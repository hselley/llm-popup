# LLM Popup

A **GNOME Shell** extension that opens a popup in the top bar to chat with
language models: **local Ollama**,  local llama.cpp,
**OpenAI-compatible** APIs, **Anthropic (Claude)** and
**Google Gemini**.

> **GNOME Shell 51** · **GPL-3.0-or-later** license ·
> [extensions.gnome.org](https://extensions.gnome.org/)

---

## Features

- Popup accessible from the top bar or with a **keyboard shortcut**
  (default `Super`+`Alt`+`W`).
- Multiple switchable **provider profiles** (Ollama, OpenAI-compatible,
  Anthropic, Gemini), each with its own URL and model.
- **Streaming** responses (token by token).
- **Conversation history**: saved automatically and browsable from the
  menu → **History**. *New conversation* starts a blank thread without
  deleting the previous ones.
- **API keys in the GNOME keyring** (libsecret), never in plain text in
  GSettings.
- **Special keys** support: the **Copilot** key on ASUS laptops emits
  `Shift`+`Super`+`F23`, so it can be bound as
  `<Shift><Super>F23` (or `<Shift><Super>XF86Assistant`).
- The text field **regains focus when clicked**.
- `Enter` sends · `Shift`+`Enter` inserts a line break.

## Requirements

- GNOME Shell **51** (Wayland or X11).
- A provider: local **Ollama**, or an API key for OpenAI / Anthropic / Gemini.
- **libsecret** (bundled with GNOME).

## Installation

### From extensions.gnome.org

Search for “LLM Popup” on [extensions.gnome.org](https://extensions.gnome.org/)
or install it from the website.

### Building from source

```bash
git clone https://github.com/hselley/llm-popup.git
cd llm-popup
./build.sh
gnome-extensions install --force dist/llm-popup@geeker.shell-extension.zip
gnome-extensions enable llm-popup@geeker
```

After a JavaScript-only change, reloading it is enough:

```bash
gnome-extensions disable llm-popup@geeker && gnome-extensions enable llm-popup@geeker
```

## Usage

1. Open the popup: keyboard shortcut or click the top-bar indicator.
2. Type your query and press **Enter**.
3. To start from scratch: **History → New conversation**.
4. To resume an earlier conversation: **History → <title>**.

### Settings

`Preferences → LLM Popup`:

| Setting | Description |
| --- | --- |
| **Profiles** | Add/edit providers: type, base URL and model |
| **API key** | Stored in the GNOME keyring (only needed for OpenAI/Anthropic/Gemini; Ollama does not need one) |
| **System prompt** | Initial instructions for the model |
| **Shortcut** | Can be captured by pressing the key, useful for special keys |

### Where things are stored

| What | Where |
| --- | --- |
| Profiles, prompt and shortcut | GSettings `org.gnome.shell.extensions.llm-popup` |
| API keys | libsecret · schema `org.gnome.shell.extensions.llm-popup` · attribute `profile=<id>` |
| History | `~/.local/share/llm-popup@geeker/history/<conv>.json` (one per conversation) |

### Copilot key / special keys

Some keyboards (e.g. ASUS) send a **chord** instead of a single key.
The Copilot key emits `Shift_L`+`Super_L`+`F23`, which is why the shortcut
must include the modifiers:

```
<Shift><Super>F23
```

To check what a key emits: `wev` (Wayland) or `evtest` (device level).

## Packaging and publishing

```bash
./build.sh          # produces dist/llm-popup@geeker.shell-extension.zip
```

Publishing to **extensions.gnome.org**:

1. Create an account (GNOME Account) and sign in.
2. *Developers → Upload extension* and upload the `.zip`.
3. Fill in the description, license and a screenshot; the site validates `metadata.json`.
4. A human reviewer checks the code (it may take days/weeks).

To **update** it: build a new zip and upload it again; extensions.gnome.org
assigns the version number and users receive the update notification.

## Project structure

| File | Role |
| --- | --- |
| `extension.js` | Popup, menu, history, shortcut and query sending |
| `prefs.js` | Preferences page (profiles, API key, shortcut) |
| `providers.js` | HTTP adapters: Ollama, OpenAI-compatible, Anthropic, Gemini |
| `profiles.js` | Profile loading/saving and validation |
| `secrets.js` | API keys in libsecret |
| `schemas/` | GSettings schema |
| `icons/` | Symbolic icon |
| `build.sh` | Packaging for extensions.gnome.org |

## License

[GPL-3.0-or-later](LICENSE) © Héctor Selley.
