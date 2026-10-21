// Conectores para distintos proveedores de LLM usando libsoup 3.
// Todos exponen: listModels({apiKey, cancellable}) y
// chat({model, system, history, apiKey, onChunk, cancellable}).
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MAX_TOKENS = 8192;

export function isCancelledError(e) {
    return e instanceof GLib.Error &&
        e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

class BaseProvider {
    constructor(session, baseUrl) {
        this._session = session;
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    // --- Utilidades HTTP -------------------------------------------------

    _message(method, url, headers = {}, body = null) {
        const msg = Soup.Message.new(method, url);
        if (!msg)
            throw new Error(`URL inválida: ${url}`);
        for (const [k, v] of Object.entries(headers))
            msg.request_headers.replace(k, v);
        if (body !== null) {
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        }
        return msg;
    }

    async _getJson(url, headers, cancellable = null) {
        cancellable ??= null;
        const msg = this._message('GET', url, headers);
        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT,
                cancellable, (s, res) => {
                    try {
                        resolve(s.send_and_read_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const text = decoder.decode(bytes.toArray());
        if (msg.get_status() !== Soup.Status.OK)
            throw new Error(`HTTP ${msg.get_status()}: ${extractError(text)}`);
        return JSON.parse(text);
    }

    /**
     * Hace una petición POST en streaming y llama a onLine(línea) por cada
     * línea recibida. Si onLine devuelve true, se detiene la lectura.
     */
    async _streamLines(url, headers, body, cancellable, onLine) {
        cancellable ??= null;
        const msg = this._message('POST', url, headers, body);
        const input = await new Promise((resolve, reject) => {
            this._session.send_async(msg, GLib.PRIORITY_DEFAULT, cancellable,
                (s, res) => {
                    try {
                        resolve(s.send_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        const stream = new Gio.DataInputStream({
            base_stream: input,
            close_base_stream: true,
        });

        try {
            const status = msg.get_status();
            if (status !== Soup.Status.OK) {
                const lines = [];
                let line;
                // eslint-disable-next-line no-await-in-loop
                while ((line = await readLine(stream, cancellable)) !== null && lines.length < 200)
                    lines.push(line);
                throw new Error(`HTTP ${status}: ${extractError(lines.join('\n'))}`);
            }
            while (true) {
                // eslint-disable-next-line no-await-in-loop
                const line = await readLine(stream, cancellable);
                if (line === null)
                    break;
                if (onLine(line))
                    break;
            }
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null, null);
        }
    }

    /** Variante para Server-Sent Events: entrega el JSON de cada "data:". */
    _streamSSE(url, headers, body, cancellable, onEvent) {
        return this._streamLines(url, headers, body, cancellable, line => {
            if (!line.startsWith('data:'))
                return false;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]')
                return true;
            if (!payload)
                return false;
            return onEvent(JSON.parse(payload));
        });
    }
}

function readLine(stream, cancellable) {
    return new Promise((resolve, reject) => {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (s, res) => {
            try {
                const [line] = s.read_line_finish_utf8(res);
                resolve(line);
            } catch (e) {
                reject(e);
            }
        });
    });
}

function extractError(text) {
    try {
        const json = JSON.parse(text);
        const err = Array.isArray(json) ? json[0]?.error : json.error;
        if (typeof err === 'string')
            return err;
        if (err?.message)
            return err.message;
    } catch {}
    return text.trim().slice(0, 300) || 'sin detalles';
}

function requireKey(apiKey) {
    if (!apiKey)
        throw new Error('Falta la API key. Configúrala en las preferencias de la extensión.');
}

// --- Ollama -------------------------------------------------------------

class OllamaProvider extends BaseProvider {
    async listModels({cancellable}) {
        const json = await this._getJson(`${this.baseUrl}/api/tags`, {}, cancellable);
        return (json.models ?? []).map(m => m.name);
    }

    async chat({model, system, history, onChunk, cancellable}) {
        const messages = system ? [{role: 'system', content: system}, ...history] : history;
        let full = '';
        await this._streamLines(`${this.baseUrl}/api/chat`, {},
            {model, messages, stream: true}, cancellable, line => {
                if (!line.trim())
                    return false;
                const data = JSON.parse(line);
                if (data.error)
                    throw new Error(data.error);
                const piece = data.message?.content ?? '';
                if (piece) {
                    full += piece;
                    onChunk?.(piece, full);
                }
                return Boolean(data.done);
            });
        return full;
    }
}

// --- Compatible con OpenAI ----------------------------------------------

class OpenAIProvider extends BaseProvider {
    _headers(apiKey) {
        return apiKey ? {Authorization: `Bearer ${apiKey}`} : {};
    }

    async listModels({apiKey, cancellable}) {
        const json = await this._getJson(`${this.baseUrl}/models`,
            this._headers(apiKey), cancellable);
        return (json.data ?? []).map(m => m.id).sort();
    }

    async chat({model, system, history, apiKey, onChunk, cancellable}) {
        // La key es opcional: servidores locales (LM Studio, llama.cpp) no la piden.
        const messages = system ? [{role: 'system', content: system}, ...history] : history;
        let full = '';
        await this._streamSSE(`${this.baseUrl}/chat/completions`,
            this._headers(apiKey), {model, messages, stream: true}, cancellable,
            data => {
                if (data.error)
                    throw new Error(data.error.message ?? JSON.stringify(data.error));
                const piece = data.choices?.[0]?.delta?.content ?? '';
                if (piece) {
                    full += piece;
                    onChunk?.(piece, full);
                }
                return false;
            });
        return full;
    }
}

// --- Anthropic ----------------------------------------------------------

class AnthropicProvider extends BaseProvider {
    _headers(apiKey) {
        return {'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION};
    }

    async listModels({apiKey, cancellable}) {
        requireKey(apiKey);
        const json = await this._getJson(`${this.baseUrl}/v1/models?limit=1000`,
            this._headers(apiKey), cancellable);
        return (json.data ?? []).map(m => m.id);
    }

    async chat({model, system, history, apiKey, onChunk, cancellable}) {
        requireKey(apiKey);
        const body = {
            model,
            max_tokens: ANTHROPIC_MAX_TOKENS,
            messages: history,
            stream: true,
        };
        if (system)
            body.system = system;

        let full = '';
        await this._streamSSE(`${this.baseUrl}/v1/messages`,
            this._headers(apiKey), body, cancellable, data => {
                if (data.type === 'error')
                    throw new Error(data.error?.message ?? 'Error de Anthropic');
                if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
                    full += data.delta.text;
                    onChunk?.(data.delta.text, full);
                }
                return data.type === 'message_stop';
            });
        return full;
    }
}

// --- Google Gemini ------------------------------------------------------

class GeminiProvider extends BaseProvider {
    _headers(apiKey) {
        return {'x-goog-api-key': apiKey};
    }

    async listModels({apiKey, cancellable}) {
        requireKey(apiKey);
        const json = await this._getJson(`${this.baseUrl}/v1beta/models?pageSize=1000`,
            this._headers(apiKey), cancellable);
        return (json.models ?? [])
            .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent'))
            .map(m => m.name.replace(/^models\//, ''));
    }

    async chat({model, system, history, apiKey, onChunk, cancellable}) {
        requireKey(apiKey);
        const body = {
            contents: history.map(m => ({
                role: m.role === 'assistant' ? 'model' : 'user',
                parts: [{text: m.content}],
            })),
        };
        if (system)
            body.systemInstruction = {parts: [{text: system}]};

        const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
        let full = '';
        await this._streamSSE(url, this._headers(apiKey), body, cancellable, data => {
            if (data.error)
                throw new Error(data.error.message ?? 'Error de Gemini');
            const parts = data.candidates?.[0]?.content?.parts ?? [];
            const piece = parts.filter(p => !p.thought).map(p => p.text ?? '').join('');
            if (piece) {
                full += piece;
                onChunk?.(piece, full);
            }
            return false;
        });
        return full;
    }
}

const PROVIDER_CLASSES = {
    ollama: OllamaProvider,
    openai: OpenAIProvider,
    anthropic: AnthropicProvider,
    gemini: GeminiProvider,
};

/** Fábrica de proveedores que comparte una única sesión HTTP. */
export class ProviderFactory {
    constructor() {
        this._session = new Soup.Session({timeout: 0});
    }

    create(profile) {
        const Klass = PROVIDER_CLASSES[profile.type];
        if (!Klass)
            throw new Error(`Tipo de proveedor desconocido: ${profile.type}`);
        return new Klass(this._session, profile.url);
    }

    destroy() {
        this._session?.abort();
        this._session = null;
    }
}
