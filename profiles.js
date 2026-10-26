// SPDX-FileCopyrightText: 2026 Héctor Selley
// SPDX-License-Identifier: GPL-3.0-or-later

// Gestión de perfiles de proveedor (compartido entre extension.js y prefs.js).
import GLib from 'gi://GLib';

export const PROVIDER_TYPES = {
    ollama: {
        label: 'Ollama',
        defaultUrl: 'http://localhost:11434',
        needsKey: false,
    },
    openai: {
        label: 'Compatible con OpenAI',
        defaultUrl: 'https://api.openai.com/v1',
        needsKey: true,
    },
    anthropic: {
        label: 'Anthropic (Claude)',
        defaultUrl: 'https://api.anthropic.com',
        needsKey: true,
    },
    gemini: {
        label: 'Google Gemini',
        defaultUrl: 'https://generativelanguage.googleapis.com',
        needsKey: true,
    },
};

export const PROVIDER_TYPE_IDS = Object.keys(PROVIDER_TYPES);

export function newProfile(type = 'openai') {
    return {
        id: GLib.uuid_string_random(),
        name: `Nuevo ${PROVIDER_TYPES[type].label}`,
        type,
        url: PROVIDER_TYPES[type].defaultUrl,
        model: '',
    };
}

function sanitize(p) {
    if (!p || typeof p !== 'object' || !p.id)
        return null;
    const type = PROVIDER_TYPES[p.type] ? p.type : 'openai';
    return {
        id: String(p.id),
        name: String(p.name ?? PROVIDER_TYPES[type].label),
        type,
        url: String(p.url || PROVIDER_TYPES[type].defaultUrl),
        model: String(p.model ?? ''),
    };
}

export function loadProfiles(settings) {
    let list = [];
    try {
        list = JSON.parse(settings.get_string('profiles'));
    } catch {}
    if (!Array.isArray(list))
        list = [];
    return list.map(sanitize).filter(p => p !== null);
}

export function saveProfiles(settings, profiles) {
    settings.set_string('profiles', JSON.stringify(profiles));
}

export function getActiveProfile(settings, profiles = loadProfiles(settings)) {
    const id = settings.get_string('active-profile');
    return profiles.find(p => p.id === id) ?? profiles[0] ?? null;
}

export function updateProfile(settings, id, changes) {
    const profiles = loadProfiles(settings);
    const profile = profiles.find(p => p.id === id);
    if (!profile)
        return;
    Object.assign(profile, changes);
    saveProfiles(settings, profiles);
}
