// Almacenamiento de API keys en el llavero de GNOME (libsecret).
import Gio from 'gi://Gio';
import Secret from 'gi://Secret?version=1';

const SCHEMA = new Secret.Schema(
    'org.gnome.shell.extensions.ollama-popup',
    Secret.SchemaFlags.NONE,
    {profile: Secret.SchemaAttributeType.STRING});

/** Devuelve la API key del perfil o null si no existe. */
export function lookupApiKey(profileId, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_lookup(SCHEMA, {profile: profileId}, cancellable,
            (_src, res) => {
                try {
                    resolve(Secret.password_lookup_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function storeApiKey(profileId, profileName, key, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_store(SCHEMA, {profile: profileId},
            Secret.COLLECTION_DEFAULT, `LLM Popup: ${profileName}`, key,
            cancellable, (_src, res) => {
                try {
                    resolve(Secret.password_store_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

export function setSecret(profileId, profileName, key, cancellable = null) { return storeApiKey(profileId, profileName, key, cancellable); }

export function deleteSecret(profileId, cancellable = null) {
    return clearApiKey(profileId, cancellable);
}

export function clearApiKey(profileId, cancellable = null) {
    return new Promise((resolve, reject) => {
        Secret.password_clear(SCHEMA, {profile: profileId}, cancellable,
            (_src, res) => {
                try {
                    resolve(Secret.password_clear_finish(res));
                } catch (e) {
                    if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                        resolve(false);
                    else
                        reject(e);
                }
            });
    });
}
