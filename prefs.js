// SPDX-FileCopyrightText: 2026 Héctor Selley
// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {
    PROVIDER_TYPES, PROVIDER_TYPE_IDS, loadProfiles, saveProfiles,
    newProfile, updateProfile,
} from './profiles.js';
import {lookupApiKey, storeApiKey, clearApiKey} from './secrets.js';

const OPENAI_EXAMPLES = [
    ['OpenAI', 'https://api.openai.com/v1'],
    ['OpenRouter', 'https://openrouter.ai/api/v1'],
    ['Groq', 'https://api.groq.com/openai/v1'],
    ['DeepSeek', 'https://api.deepseek.com/v1'],
    ['Mistral', 'https://api.mistral.ai/v1'],
    ['LM Studio (local)', 'http://localhost:1234/v1'],
    ['llama.cpp server (local)', 'http://localhost:8080/v1'],
];

export default class LlmPopupPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 760);

        window.add(this._buildProvidersPage(window, settings));
        window.add(this._buildGeneralPage(settings));
    }

    // --- Página de proveedores ------------------------------------------

    _buildProvidersPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Proveedores',
            icon_name: 'network-server-symbolic',
        });

        const group = new Adw.PreferencesGroup({
            title: 'Perfiles de proveedor',
            description: 'Las API keys se guardan cifradas en el llavero de GNOME.',
        });
        page.add(group);

        const addButton = new Gtk.MenuButton({
            icon_name: 'list-add-symbolic',
            tooltip_text: 'Añadir proveedor',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const addMenu = new Gio.Menu();
        const actionGroup = new Gio.SimpleActionGroup();
        for (const type of PROVIDER_TYPE_IDS) {
            addMenu.append(PROVIDER_TYPES[type].label, `providers.add-${type}`);
            const action = new Gio.SimpleAction({name: `add-${type}`});
            action.connect('activate', () => {
                const profiles = loadProfiles(settings);
                const profile = newProfile(type);
                profiles.push(profile);
                saveProfiles(settings, profiles);
                rebuild(profile.id);
            });
            actionGroup.add_action(action);
        }
        addButton.set_menu_model(addMenu);
        window.insert_action_group('providers', actionGroup);
        group.set_header_suffix(addButton);

        let rows = [];
        const rebuild = (expandId = null) => {
            for (const row of rows)
                group.remove(row);
            rows = [];

            const profiles = loadProfiles(settings);
            if (profiles.length === 0) {
                const empty = new Adw.ActionRow({
                    title: 'No hay proveedores',
                    subtitle: 'Pulsa + para añadir uno',
                });
                group.add(empty);
                rows.push(empty);
            }
            for (const profile of profiles) {
                const row = this._buildProfileRow(window, settings, profile, rebuild);
                row.expanded = profile.id === expandId;
                group.add(row);
                rows.push(row);
            }
            updateActiveMarks();
        };

        const updateActiveMarks = () => {
            const profiles = loadProfiles(settings);
            const activeId = settings.get_string('active-profile');
            const effective = profiles.some(p => p.id === activeId)
                ? activeId : profiles[0]?.id;
            for (const row of rows)
                row._activeIcon?.set_visible(row._profileId === effective);
        };
        settings.connect('changed::active-profile', updateActiveMarks);

        rebuild();

        // Ayuda para APIs compatibles con OpenAI
        const help = new Adw.PreferencesGroup({
            title: 'URLs compatibles con OpenAI',
            description: 'Usa el tipo «Compatible con OpenAI» con alguna de estas URLs base.',
        });
        for (const [name, url] of OPENAI_EXAMPLES) {
            const row = new Adw.ActionRow({title: name, subtitle: url, subtitle_selectable: true});
            const copy = new Gtk.Button({
                icon_name: 'edit-copy-symbolic',
                tooltip_text: 'Copiar URL',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            copy.connect('clicked', () => {
                row.get_clipboard().set(url);
                window.add_toast(new Adw.Toast({title: 'URL copiada'}));
            });
            row.add_suffix(copy);
            help.add(row);
        }
        page.add(help);

        return page;
    }

    _buildProfileRow(window, settings, profile, rebuild) {
        const info = () => PROVIDER_TYPES[currentType];
        let currentType = profile.type;

        const row = new Adw.ExpanderRow({
            title: profile.name,
            subtitle: PROVIDER_TYPES[profile.type].label,
        });
        row._profileId = profile.id;
        row._activeIcon = new Gtk.Image({
            icon_name: 'object-select-symbolic',
            tooltip_text: 'Proveedor activo',
        });
        row.add_prefix(row._activeIcon);

        const save = changes => updateProfile(settings, profile.id, changes);

        // Nombre
        const nameRow = new Adw.EntryRow({title: 'Nombre', text: profile.name});
        nameRow.connect('changed', () => {
            row.title = nameRow.text || '(sin nombre)';
            save({name: nameRow.text});
        });
        row.add_row(nameRow);

        // Tipo
        const typeRow = new Adw.ComboRow({
            title: 'Tipo',
            model: Gtk.StringList.new(PROVIDER_TYPE_IDS.map(t => PROVIDER_TYPES[t].label)),
            selected: PROVIDER_TYPE_IDS.indexOf(profile.type),
        });
        row.add_row(typeRow);

        // URL base
        const urlRow = new Adw.EntryRow({title: 'URL base', text: profile.url});
        urlRow.connect('changed', () => save({url: urlRow.text.trim()}));
        row.add_row(urlRow);

        // Modelo
        const modelRow = new Adw.EntryRow({
            title: 'Modelo (también se elige desde el popup)',
            text: profile.model,
        });
        modelRow.connect('changed', () => save({model: modelRow.text.trim()}));
        row.add_row(modelRow);

        // API key
        const keyRow = new Adw.PasswordEntryRow({
            title: 'API key',
            show_apply_button: true,
        });
        const refreshKeyTitle = async () => {
            try {
                const key = await lookupApiKey(profile.id);
                keyRow.title = key
                    ? 'API key (guardada en el llavero; escribe otra para reemplazarla)'
                    : info().needsKey ? 'API key (requerida)' : 'API key (opcional)';
            } catch (e) {
                keyRow.title = `API key (llavero no disponible: ${e.message})`;
            }
        };
        keyRow.connect('apply', async () => {
            const key = keyRow.text.trim();
            try {
                if (key)
                    await storeApiKey(profile.id, nameRow.text || profile.name, key);
                else
                    await clearApiKey(profile.id);
                keyRow.text = '';
                window.add_toast(new Adw.Toast({
                    title: key ? 'API key guardada en el llavero' : 'API key eliminada',
                }));
            } catch (e) {
                window.add_toast(new Adw.Toast({title: `Error del llavero: ${e.message}`}));
            }
            refreshKeyTitle();
        });
        row.add_row(keyRow);
        refreshKeyTitle();

        const updateKeyVisibility = () => {
            keyRow.visible = currentType !== 'ollama';
        };
        updateKeyVisibility();

        typeRow.connect('notify::selected', () => {
            const newType = PROVIDER_TYPE_IDS[typeRow.selected];
            const oldDefault = PROVIDER_TYPES[currentType].defaultUrl;
            currentType = newType;
            row.subtitle = PROVIDER_TYPES[newType].label;
            save({type: newType});
            if (!urlRow.text.trim() || urlRow.text.trim() === oldDefault)
                urlRow.text = PROVIDER_TYPES[newType].defaultUrl;
            updateKeyVisibility();
            refreshKeyTitle();
        });

        // Acciones
        const actionsRow = new Adw.ActionRow({title: 'Acciones'});
        const useButton = new Gtk.Button({
            label: 'Usar este proveedor',
            valign: Gtk.Align.CENTER,
        });
        useButton.connect('clicked', () => {
            settings.set_string('active-profile', profile.id);
            window.add_toast(new Adw.Toast({title: `Proveedor activo: ${nameRow.text}`}));
        });
        const deleteButton = new Gtk.Button({
            label: 'Eliminar',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        deleteButton.connect('clicked', () => {
            const dialog = new Adw.AlertDialog({
                heading: `¿Eliminar «${nameRow.text}»?`,
                body: 'También se borrará su API key del llavero.',
            });
            dialog.add_response('cancel', 'Cancelar');
            dialog.add_response('delete', 'Eliminar');
            dialog.set_response_appearance('delete', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', async (_d, response) => {
                if (response !== 'delete')
                    return;
                try {
                    await clearApiKey(profile.id);
                } catch (e) {
                    console.warn(e);
                }
                const profiles = loadProfiles(settings).filter(p => p.id !== profile.id);
                saveProfiles(settings, profiles);
                if (settings.get_string('active-profile') === profile.id)
                    settings.set_string('active-profile', profiles[0]?.id ?? '');
                rebuild();
            });
            dialog.present(window);
        });
        actionsRow.add_suffix(useButton);
        actionsRow.add_suffix(deleteButton);
        row.add_row(actionsRow);

        return row;
    }

    // --- Página general -------------------------------------------------

    _buildGeneralPage(settings) {
        const page = new Adw.PreferencesPage({
            title: 'General',
            icon_name: 'preferences-system-symbolic',
        });

        const group = new Adw.PreferencesGroup({title: 'Comportamiento'});
        page.add(group);

        const promptRow = new Adw.EntryRow({title: 'Prompt de sistema'});
        settings.bind('system-prompt', promptRow, 'text', Gio.SettingsBindFlags.DEFAULT);
        group.add(promptRow);

        const DEFAULT_TITLE = 'Atajo de teclado (p. ej. <Super><Alt>o)';
        const shortcutRow = new Adw.EntryRow({
            title: DEFAULT_TITLE,
            show_apply_button: true,
            text: settings.get_strv('llm-popup-shortcut')[0] ?? '',
        });

        // GTK no conoce algunos keysyms (p. ej. XF86Assistant, la tecla
        // Asistente/Copilot), pero libxkbcommon/mutter sí. Aceptamos tanto lo
        // que GTK valida como esos nombres para no bloquear teclas especiales.
        const looksLikeAccel = accel =>
            /^(<[A-Za-z0-9]+>)*(0x[0-9A-Fa-f]+|[A-Za-z0-9_]+)$/.test(accel);

        shortcutRow.connect('apply', () => {
            const accel = shortcutRow.text.trim();
            if (accel === '') {
                settings.set_strv('llm-popup-shortcut', []);
                shortcutRow.remove_css_class('error');
                return;
            }
            const [ok] = Gtk.accelerator_parse(accel);
            if (ok || looksLikeAccel(accel)) {
                settings.set_strv('llm-popup-shortcut', [accel]);
                shortcutRow.remove_css_class('error');
            } else {
                shortcutRow.add_css_class('error');
            }
        });

        // Botón «Capturar»: graba la siguiente tecla que pulses.
        const captureButton = new Gtk.Button({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            tooltip_text: 'Capturar atajo (pulsa una tecla)',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        shortcutRow.add_suffix(captureButton);

        let capturing = false;
        const setCapturing = on => {
            capturing = on;
            captureButton.icon_name = on
                ? 'process-stop-symbolic'
                : 'preferences-desktop-keyboard-shortcuts-symbolic';
            shortcutRow.title = on
                ? 'Pulsa la tecla deseada (Esc para cancelar)'
                : DEFAULT_TITLE;
        };
        captureButton.connect('clicked', () => setCapturing(!capturing));

        const MODIFIER_KEYS = new Set([
            Gdk.KEY_Shift_L, Gdk.KEY_Shift_R,
            Gdk.KEY_Control_L, Gdk.KEY_Control_R,
            Gdk.KEY_Alt_L, Gdk.KEY_Alt_R,
            Gdk.KEY_Super_L, Gdk.KEY_Super_R,
            Gdk.KEY_Meta_L, Gdk.KEY_Meta_R,
            Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R,
            Gdk.KEY_Caps_Lock, Gdk.KEY_Num_Lock,
        ]);

        const keyController = new Gtk.EventControllerKey();
        keyController.set_propagation_phase(Gtk.PropagationPhase.CAPTURE);
        keyController.connect('key-pressed', (_ctrl, keyval, _keycode, state) => {
            if (!capturing)
                return false;
            if (keyval === Gdk.KEY_Escape) {
                setCapturing(false);
                return true;
            }
            if (MODIFIER_KEYS.has(keyval))
                return true;
            const mods = state & Gtk.accelerator_get_default_mod_mask();
            const accel = Gtk.accelerator_name(keyval, mods);
            if (accel) {
                shortcutRow.text = accel;
                settings.set_strv('llm-popup-shortcut', [accel]);
                shortcutRow.remove_css_class('error');
            }
            setCapturing(false);
            return true;
        });
        shortcutRow.add_controller(keyController);

        group.add(shortcutRow);

        return page;
    }
}
