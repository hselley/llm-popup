# LLM Popup

Extensión de **GNOME Shell** que abre un popup en la barra superior para
conversar con modelos de lenguaje: **Ollama local**, APIs **compatibles con
OpenAI**, **Anthropic (Claude)** y **Google Gemini**.

> **GNOME Shell 51** · Licencia **GPL-3.0** ·
> [extensions.gnome.org](https://extensions.gnome.org/)

---

## Características

- Popup accesible desde la barra superior o con un **atajo de teclado**
  (por defecto `Super`+`Alt`+`W`).
- Varios **perfiles de proveedor** conmutables (Ollama, OpenAI-compatible,
  Anthropic, Gemini) cada uno con su URL y modelo.
- Respuesta en **streaming** (token a token).
- **Historial de conversaciones**: se guarda automáticamente y se navega desde
  el menú → **Historial**. *Nueva conversación* empieza un hilo en blanco sin
  borrar los anteriores.
- **API keys en el llavero de GNOME** (libsecret), nunca en texto plano en
  GSettings.
- Compatible con **teclas especiales**: la tecla **Copilot** de los portátiles
  ASUS emite `Shift`+`Super`+`F23`, así que se binda como
  `<Shift><Super>F23` (o `<Shift><Super>XF86Assistant`).
- El campo de texto **recupera el foco al hacer clic** sobre él.
- `Enter` envía · `Shift`+`Enter` añade salto de línea.

## Requisitos

- GNOME Shell **51** (Wayland o X11).
- Un proveedor: **Ollama** en local, o una API key de OpenAI / Anthropic / Gemini.
- **libsecret** (incluido en GNOME).

## Instalación

### Desde extensions.gnome.org

Buscar «LLM Popup» en [extensions.gnome.org](https://extensions.gnome.org/)
o instalar desde la web.

### Compilando desde el código

```bash
git clone https://github.com/hselley/ollama-popup.git
cd ollama-popup
./build.sh
gnome-extensions install --force dist/ollama-popup@geeker.shell-extension.zip
gnome-extensions enable ollama-popup@geeker
```

Tras un cambio solo en JavaScript basta recargarla:

```bash
gnome-extensions disable ollama-popup@geeker && gnome-extensions enable ollama-popup@geeker
```

## Uso

1. Abre el popup: atajo de teclado o clic en el indicador de la barra superior.
2. Escribe la consulta y pulsa **Enter**.
3. Para empezar de cero: **Historial → Nueva conversación**.
4. Para retomar una conversación anterior: **Historial → <título>**.

### Configuración

`Preferencias → LLM Popup`:

| Ajuste | Descripción |
|---|---|
| **Perfiles** | Añadir/editar proveedores: tipo, URL base y modelo |
| **Clave API** | Se guarda en el llavero de GNOME (solo la necesitan OpenAI/Anthropic/Gemini; Ollama no) |
| **Prompt de sistema** | Instrucciones iniciales del modelo |
| **Atajo** | Se puede capturar pulsando la tecla, útil para teclas especiales |

### Dónde se guarda qué

| Qué | Dónde |
|---|---|
| Perfiles, prompt y atajo | GSettings `org.gnome.shell.extensions.ollama-popup` |
| API keys | libsecret · esquema `org.gnome.shell.extensions.ollama-popup` · atributo `profile=<id>` |
| Historial | `~/.local/share/ollama-popup@geeker/history/<conv>.json` (uno por conversación) |

### Tecla Copilot / teclas especiales

Algunos teclados (p. ej. ASUS) envían un **acorde** en lugar de una sola tecla.
La tecla Copilot emite `Shift_L`+`Super_L`+`F23`, por eso el atajo debe
incluir los modificadores:

```
<Shift><Super>F23
```

Comprobar qué emite una tecla: `wev` (Wayland) o `evtest` (nivel dispositivo).

## Empaquetar y publicar

```bash
./build.sh          # genera dist/ollama-popup@geeker.shell-extension.zip
```

Publicar en **extensions.gnome.org**:

1. Crear cuenta (GNOME Account) y entrar.
2. *Developers → Upload extension* y subir el `.zip`.
3. Rellenar descripción, licencia y captura; el sitio valida `metadata.json`.
4. Un revisor humano revisa el código (puede tardar días/semanas).

Para **actualizarla**: incrementa `version` en `metadata.json` y vuelve a subir
el zip; los usuarios reciben la notificación.

## Estructura del proyecto

| Fichero | Papel |
|---|---|
| `extension.js` | Popup, menú, historial, atajo y envío de consultas |
| `prefs.js` | Página de preferencias (perfiles, clave API, atajo) |
| `providers.js` | Adaptadores HTTP: Ollama, OpenAI-compatible, Anthropic, Gemini |
| `profiles.js` | Carga/guardado y validación de perfiles |
| `secrets.js` | API keys en libsecret |
| `schemas/` | Esquema GSettings |
| `icons/` | Icono simbólico |
| `build.sh` | Empaquetado para extensions.gnome.org |

## Licencia

[GPL-3.0](LICENSE) © Héctor Selley.
