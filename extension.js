// SPDX-FileCopyrightText: 2026 Héctor Selley
// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {ProviderFactory, isCancelledError} from './providers.js';
import {
    PROVIDER_TYPES, loadProfiles, getActiveProfile, updateProfile,
} from './profiles.js';
import {lookupApiKey, setSecret, deleteSecret} from './secrets.js';

const ROLE_NAMES = {
    user: 'Tu',
    assistant: 'Asistente',
    error: 'Error',
};

const OllamaIndicator = GObject.registerClass(
class OllamaIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'LLM Popup', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._factory = new ProviderFactory();
        this._modelsRequest = 0;
        this._history = [];
        this._conversationId = null;
        this._historyDir = null;
        this._lastResponse = '';
        this._cancellable = null;
        this._destroyed = false;
        this._scrollIdleId = 0;
        this._focusIdleId = 0;

        const iconPath = extension.dir.get_child('icons')
            .get_child('llm-popup-symbolic.svg').get_path();
        this.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(iconPath),
            style_class: 'system-status-icon',
        }));

        this._buildMenu();

        this._settings.connectObject(
            'changed::profiles', () => this._updateLabels(),
            'changed::active-profile', () => {
                this._updateLabels();
                if (this.menu.isOpen)
                    this._refreshModels().catch(logError);
            },
            this);

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._refreshProviders();
                this._refreshModels().catch(logError);
                this._focusEntry();
                this._refreshHistory().catch(logError);
            }
        });
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('llm-popup-menu');

        // Selector de proveedor y de modelo
        this._providerItem = new PopupMenu.PopupSubMenuMenuItem('');
        this.menu.addMenuItem(this._providerItem);
        this._modelItem = new PopupMenu.PopupSubMenuMenuItem('');
        this.menu.addMenuItem(this._modelItem);
        this._updateLabels();

        // Historial de conversaciones
        this._historyItem = new PopupMenu.PopupSubMenuMenuItem('Historial');
        this.menu.addMenuItem(this._historyItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Area de chat
        const chatItem = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        const box = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ollama-chat-box',
            x_expand: true,
        });
        chatItem.add_child(box);
        this.menu.addMenuItem(chatItem);

        this._messagesBox = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'ollama-messages',
            x_expand: true,
        });
        this._scroll = new St.ScrollView({
            style_class: 'ollama-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._messagesBox);
        box.add_child(this._scroll);

        this._placeholder = new St.Label({
            text: 'Escribe una consulta para empezar.',
            style_class: 'ollama-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._messagesBox.add_child(this._placeholder);

        // Entrada de texto multilinea
        this._entry = new St.Entry({
            style_class: 'ollama-entry',
            hint_text: 'Tu consulta... (Enter envia - Shift+Enter nueva linea)',
            can_focus: true,
            x_expand: true,
        });
        const ct = this._entry.clutter_text;
        ct.set_single_line_mode(false);
        ct.set_activatable(false);
        ct.set_line_wrap(true);
        ct.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        // Enter envia, Shift+Enter hace salto de linea (Clutter.KeyController,
        // forma recomendada desde GNOME 51; key-press-event esta deprecado).
        const keyController = new Clutter.KeyController();
        this._keyController = keyController;
        keyController.connect('key-press', () => {
            const [, sym] = keyController.get_key();
            const [, , mods] = global.get_pointer();
            const shift = mods & Clutter.ModifierType.SHIFT_MASK;
            if ((sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) && !shift) {
                this._send().catch(logError);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        ct.add_action(keyController);
        // Click del raton enfoca la caja de texto. Conectamos en fase BURBUJA
        // pero devolvemos EVENT_PROPAGATE para no bloquear a ClutterText
        // (colocacion de cursor al hacer clic tras perder el foco).
        const focusEntry = () => {
            if (!this._destroyed)
                global.stage.set_key_focus(this._entry.clutter_text);
        };
        const clickGesture = new Clutter.ClickGesture();
        this._clickGesture = clickGesture;
        clickGesture.connect('recognize', () => {
            focusEntry();
            return Clutter.EVENT_PROPAGATE;
        });
        this._entry.add_action(clickGesture);
        // Tambien sobre ClutterText, en fase CAPTURE para mayor robustez
        // con el modal del menu y devolviendo EVENT_PROPAGATE.
        const clickGestureText = new Clutter.ClickGesture();
        this._clickGestureText = clickGestureText;
        clickGestureText.connect('recognize', () => {
            focusEntry();
            return Clutter.EVENT_PROPAGATE;
        });
        ct.add_action_full('click-focus-capture', Clutter.EventPhase.CAPTURE,
            clickGestureText);
        box.add_child(this._entry);

        // Botones
        const buttons = new St.BoxLayout({
            style_class: 'ollama-buttons',
            x_expand: true,
        });
        box.add_child(buttons);

        this._statusLabel = new St.Label({
            style_class: 'ollama-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        buttons.add_child(this._statusLabel);

        const clearButton = this._makeButton('Limpiar', () => this._clear());
        const copyButton = this._makeButton('Copiar', () => this._copy());
        this._sendButton = this._makeButton('Enviar', () => {
            if (this._cancellable)
                this._cancellable.cancel();
            else
                this._send().catch(logError);
        });
        this._sendButton.add_style_class_name('default');
        buttons.add_child(clearButton);
        buttons.add_child(copyButton);
        buttons.add_child(this._sendButton);
    }

    _makeButton(label, callback) {
        const button = new St.Button({
            label,
            style_class: 'button ollama-button',
            can_focus: true,
        });
        button.connect('clicked', callback);
        return button;
    }

    _ensureHistoryDir() {
        if (this._historyDir)
            return this._historyDir;
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'llm-popup@geeker', 'history']);
        const gdir = Gio.File.new_for_path(dir);
        try {
            if (!gdir.query_exists(null))
                gdir.make_directory_with_parents(null);
        } catch (e) {
            logError(e);
        }
        this._historyDir = dir;
        return dir;
    }

    _historyPath(id) {
        return GLib.build_filenamev([this._ensureHistoryDir(), `${id}.json`]);
    }

    _updateLabels() {
        const profile = getActiveProfile(this._settings);
        this._providerItem.label.text = `Proveedor: ${profile?.name ?? '(ninguno)'}`;
        this._modelItem.label.text = `Modelo: ${profile?.model || '(elige uno)'}`;
    }

    _addInfoItem(submenu, text) {
        const item = new PopupMenu.PopupMenuItem(text);
        item.setSensitive(false);
        submenu.addMenuItem(item);
    }

    _fillChoices(parentItem, choices, currentValue, onSelect) {
        const submenu = parentItem.menu;
        submenu.removeAll();
        for (const {value, label} of choices) {
            const item = new PopupMenu.PopupMenuItem(label);
            item.setOrnament(value === currentValue ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            item.activate = () => {
                for (const other of submenu._getMenuItems()) {
                    other.setOrnament?.(other === item ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
                }
                parentItem.setSubmenuShown(false);
                onSelect(value);
                this._focusEntry();
            };
            submenu.addMenuItem(item);
        }
    }

    _refreshProviders() {
        const profiles = loadProfiles(this._settings);
        const active = getActiveProfile(this._settings, profiles);
        if (profiles.length === 0) {
            this._providerItem.menu.removeAll();
            this._addInfoItem(this._providerItem.menu,
                'Sin proveedores: anade uno en las preferencias');
        } else {
            this._fillChoices(this._providerItem,
                profiles.map(p => ({
                    value: p.id,
                    label: `${p.name}  -  ${PROVIDER_TYPES[p.type].label}`,
                })),
                active?.id,
                id => this._settings.set_string('active-profile', id));
        }

        const prefsItem = new PopupMenu.PopupMenuItem('Configurar proveedores...');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this._providerItem.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._providerItem.menu.addMenuItem(prefsItem);
    }

    async _getApiKey(profile) {
        if (profile.type === 'ollama')
            return null;
        try {
            return await lookupApiKey(profile.id);
        } catch (e) {
            console.warn(`[LLM Popup] No se pudo leer el llavero: ${e.message}`);
            return null;
        }
    }

    async _refreshModels() {
        const request = ++this._modelsRequest;
        const submenu = this._modelItem.menu;
        const profile = getActiveProfile(this._settings);

        submenu.removeAll();
        if (!profile) {
            this._addInfoItem(submenu, 'No hay proveedor activo');
            return;
        }
        this._addInfoItem(submenu, 'Cargando modelos...');

        let models;
        try {
            const apiKey = await this._getApiKey(profile);
            models = await this._factory.create(profile).listModels({apiKey});
        } catch (e) {
            if (this._destroyed || request !== this._modelsRequest)
                return;
            submenu.removeAll();
            this._addInfoItem(submenu, 'No se pudieron cargar los modelos');
            this._setStatus(`${profile.name}: ${e.message}`);
            return;
        }
        if (this._destroyed || request !== this._modelsRequest)
            return;

        if (models.length === 0) {
            submenu.removeAll();
            this._addInfoItem(submenu, profile.type === 'ollama'
                ? 'No hay modelos (ollama pull ...)' : 'El proveedor no devolvio modelos');
            return;
        }

        this._fillChoices(this._modelItem,
            models.map(m => ({value: m, label: m})),
            profile.model,
            model => updateProfile(this._settings, profile.id, {model}));
    }

    _addMessage(role, text) {
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
        }

        const wrapper = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            style_class: `ollama-msg ollama-msg-${role}`,
            x_expand: true,
        });
        wrapper.add_child(new St.Label({
            text: ROLE_NAMES[role] ?? role,
            style_class: 'ollama-role',
        }));
        const label = new St.Label({
            text,
            style_class: 'ollama-msg-text',
            x_expand: true,
        });
        label.clutter_text.set_line_wrap(true);
        label.clutter_text.set_line_wrap_mode(Pango.WrapMode.WORD_CHAR);
        label.clutter_text.set_ellipsize(Pango.EllipsizeMode.NONE);
        wrapper.add_child(label);

        this._messagesBox.add_child(wrapper);
        this._scrollToBottom();
        return {wrapper, label};
    }

    async _send() {
        if (this._cancellable)
            return;
        const text = this._entry.get_text().trim();
        if (!text)
            return;

        const profile = getActiveProfile(this._settings);
        if (!profile) {
            this._setStatus('Anade un proveedor en las preferencias');
            return;
        }
        if (!profile.model) {
            this._setStatus('Elige un modelo en el menu <Modelo>');
            this._modelItem.setSubmenuShown(true);
            return;
        }

        this._entry.set_text('');
        if (!this._conversationId)
            this._conversationId = this._generateConversationId();
        this._history.push({role: 'user', content: text});
        this._addMessage('user', text);
        this._saveConversation().catch(logError);
        const {wrapper, label} = this._addMessage('assistant', '...');
        wrapper.get_first_child().text = `${ROLE_NAMES.assistant} - ${profile.model}`;

        this._cancellable = new Gio.Cancellable();
        this._setBusy(true, `Generando con ${profile.name}...`);

        try {
            const apiKey = await this._getApiKey(profile);
            const full = await this._factory.create(profile).chat({
                model: profile.model,
                system: this._settings.get_string('system-prompt').trim(),
                history: [...this._history],
                apiKey,
                cancellable: this._cancellable,
                onChunk: (_piece, acc) => {
                    if (this._destroyed)
                        return;
                    label.text = acc;
                    this._scrollToBottom();
                },
            });
            if (this._destroyed)
                return;
            label.text = full || '(respuesta vacia)';
            this._history.push({role: 'assistant', content: full});
            this._lastResponse = full;
            this._setStatus('Listo');
            this._saveConversation().catch(logError);
        } catch (e) {
            if (this._destroyed)
                return;
            if (isCancelledError(e)) {
                const partial = label.text === '...' ? '' : label.text;
                label.text = `${partial}\n[detenido]`.trim();
                if (partial) {
                    this._history.push({role: 'assistant', content: partial});
                    this._lastResponse = partial;
                    this._saveConversation().catch(logError);
                } else {
                    this._history.pop();
                }
                this._setStatus('Detenido');
            } else {
                this._history.pop();
                wrapper.remove_style_class_name('ollama-msg-assistant');
                wrapper.add_style_class_name('ollama-msg-error');
                wrapper.get_first_child().text = ROLE_NAMES.error;
                let message = e.message ?? String(e);
                if (/connect|refused|resolve/i.test(message)) {
                    message += profile.type === 'ollama'
                        ? '\n?Esta corriendo Ollama? (systemctl status ollama)'
                        : `\nRevisa la URL (${profile.url}) y tu conexion.`;
                } else if (/HTTP 401|HTTP 403/.test(message)) {
                    message += '\nRevisa la API key en las preferencias.';
                }
                label.text = message;
                this._setStatus('Error');
            }
        } finally {
            if (!this._destroyed) {
                this._cancellable = null;
                this._setBusy(false);
                this._scrollToBottom();
            }
        }
    }

    _setBusy(busy, status = null) {
        this._sendButton.label = busy ? 'Detener' : 'Enviar';
        if (status !== null)
            this._setStatus(status);
    }

    _setStatus(text) {
        this._statusLabel.text = text;
    }

    _generateConversationId() {
        return `conv_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    }

    _renderAll() {
        if (this._placeholder) {
            this._placeholder.destroy();
            this._placeholder = null;
        }
        this._messagesBox.destroy_all_children();
        for (const msg of this._history) {
            this._addMessage(msg.role, msg.content);
        }
        this._lastResponse = '';
        for (let i = this._history.length - 1; i >= 0; i--) {
            if (this._history[i].role === 'assistant') {
                this._lastResponse = this._history[i].content;
                break;
            }
        }
        this._scrollToBottom();
    }

    _newConversation() {
        this._saveConversation().catch(logError);
        this._conversationId = this._generateConversationId();
        this._clear();
    }

    _loadConversation(id) {
        this._ensureHistoryDir();
        const path = this._historyPath(id);
        const file = Gio.File.new_for_path(path);
        try {
            const [ok, data] = file.load_contents(null);
            if (!ok)
                return false;
            const text = new TextDecoder().decode(data);
            const parsed = JSON.parse(text);
            if (!Array.isArray(parsed.messages))
                return false;
            this._conversationId = parsed.id || id;
            this._history = parsed.messages.map(m => ({role: m.role, content: m.content}));
            this._renderAll();
            this._setStatus('');
            this._focusEntry();
            return true;
        } catch (e) {
            logError(e);
            return false;
        }
    }

    _saveConversation() {
        if (!this._conversationId)
            this._conversationId = this._generateConversationId();
        if (this._history.length === 0) {
            const path = this._historyPath(this._conversationId);
            try {
                Gio.File.new_for_path(path).delete(null);
            } catch (e) {
                // ignore
            }
            return Promise.resolve();
        }
        const profile = getActiveProfile(this._settings);
        const conv = {
            id: this._conversationId,
            title: this._history[0]?.content?.slice(0, 60) || 'Conversacion',
            created_at: Date.now(),
            updated_at: Date.now(),
            provider: profile?.name || '',
            model: profile?.model || '',
            messages: this._history,
        };
        const text = JSON.stringify(conv, null, 2);
        const path = this._historyPath(this._conversationId);
        const file = Gio.File.new_for_path(path);
        return new Promise((resolve) => {
            file.replace_contents_async(
                new TextEncoder().encode(text),
                null,
                false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (_f, res) => {
                    try {
                        file.replace_contents_finish(res);
                    } catch (e) {
                        logError(e);
                    }
                    resolve();
                });
        });
    }

    async _refreshHistory() {
        const dir = this._ensureHistoryDir();
        const gdir = Gio.File.new_for_path(dir);
        const submenu = this._historyItem.menu;
        submenu.removeAll();
        const newItem = new PopupMenu.PopupMenuItem('Nueva conversacion');
        newItem.connect('activate', () => {
            this._newConversation();
            submenu.setSubmenuShown(false);
            this._focusEntry();
        });
        submenu.addMenuItem(newItem);
        submenu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        try {
            const enumerator = gdir.enumerate_children('standard::*',
                Gio.FileQueryInfoFlags.NONE, null);
            const files = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_name().endsWith('.json')) {
                    const path = GLib.build_filenamev([dir, info.get_name()]);
                    try {
                        const [ok, data] = Gio.File.new_for_path(path).load_contents(null);
                        if (ok) {
                            const parsed = JSON.parse(new TextDecoder().decode(data));
                            files.push({path, name: info.get_name(), parsed});
                        }
                    } catch (e) {
                        logError(e);
                    }
                }
            }
            files.sort((a, b) => (b.parsed.updated_at || 0) - (a.parsed.updated_at || 0));
            const list = files.slice(0, 15);
            for (const f of list) {
                const item = new PopupMenu.PopupMenuItem(f.parsed.title || f.name);
                item.connect('activate', () => {
                    this._saveConversation().catch(logError);
                    this._loadConversation(f.parsed.id || f.name.replace('.json', ''));
                    submenu.setSubmenuShown(false);
                });
                submenu.addMenuItem(item);
            }
            if (files.length > 15) {
                const more = new PopupMenu.PopupMenuItem('Ver todo...');
                more.setSensitive(false);
                submenu.addMenuItem(more);
            }
        } catch (e) {
            logError(e);
        }
    }

    _clear() {
        this._cancellable?.cancel();
        this._history = [];
        this._lastResponse = '';
        if (this._messagesBox)
            this._messagesBox.destroy_all_children();
        this._placeholder = new St.Label({
            text: 'Escribe una consulta para empezar.',
            style_class: 'ollama-placeholder',
            x_align: Clutter.ActorAlign.CENTER,
        });
        if (this._messagesBox)
            this._messagesBox.add_child(this._placeholder);
        this._setStatus('');
        this._focusEntry();
    }

    _copy() {
        if (!this._lastResponse) {
            this._setStatus('Nada que copiar');
            return;
        }
        St.Clipboard.get_default().set_text(
            St.ClipboardType.CLIPBOARD, this._lastResponse);
        this._setStatus('Respuesta copiada');
    }

    _scrollToBottom() {
        if (this._scrollIdleId)
            return;
        this._scrollIdleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._scrollIdleId = 0;
            const adj = this._scroll.vadjustment;
            adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    _focusEntry() {
        if (this._focusIdleId)
            return;
        this._focusIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._focusIdleId = 0;
            global.stage.set_key_focus(this._entry.clutter_text);
            return GLib.SOURCE_REMOVE;
        });
    }

    _onDestroy() {
        this._destroyed = true;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._scrollIdleId)
            GLib.source_remove(this._scrollIdleId);
        if (this._focusIdleId)
            GLib.source_remove(this._focusIdleId);
        this._scrollIdleId = 0;
        this._focusIdleId = 0;
        this._factory.destroy();
        this._factory = null;
        this._settings = null;
        super._onDestroy();
    }
});

export default class OllamaPopupExtension extends Extension {
    enable() {
        this._indicator = new OllamaIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._settings = this.getSettings();
        Main.wm.addKeybinding('llm-popup-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            // POPUP: que el atajo tambien funcione para cerrar el menu abierto
            // (con el menu abierto, GNOME esta en modo captura, no NORMAL).
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._indicator?.menu.toggle());
    }

    disable() {
        Main.wm.removeKeybinding('llm-popup-shortcut');
        this._settings = null;
        this._indicator?.destroy();
        this._indicator = null;
    }
}
