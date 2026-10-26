#!/usr/bin/env bash
# Empaqueta la extensión en un .zip listo para extensions.gnome.org.
#
#   ./build.sh
#   → dist/ollama-popup@geeker.shell-extension.zip
set -euo pipefail

UUID="ollama-popup@geeker"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
DIST="$ROOT/dist"
STAGE="$DIST/$UUID"
ZIP="$DIST/$UUID.shell-extension.zip"

SOURCES=(metadata.json extension.js prefs.js providers.js profiles.js secrets.js stylesheet.css)
ENTRIES=(metadata.json extension.js prefs.js providers.js profiles.js secrets.js stylesheet.css icons schemas)

command -v zip >/dev/null || { echo "ERROR: falta la herramienta 'zip'" >&2; exit 1; }

# 1. Montar un árbol limpio (sin .fix/.broken ni dist/)
rm -rf "$STAGE"
mkdir -p "$STAGE/schemas"
for f in "${SOURCES[@]}"; do
    cp "$ROOT/$f" "$STAGE/"
done
cp -r "$ROOT/icons" "$STAGE/"
cp "$ROOT"/schemas/*.xml "$STAGE/schemas/"

# 2. Compilar el esquema dentro del paquete
if command -v glib-compile-schemas >/dev/null; then
    glib-compile-schemas "$STAGE/schemas/" >/dev/null
elif [ -f "$ROOT/schemas/gschemas.compiled" ]; then
    cp "$ROOT/schemas/gschemas.compiled" "$STAGE/schemas/"
else
    echo "ERROR: no hay 'glib-compile-schemas' ni gschemas.compiled precompilado." >&2
    echo "       Instala glib2-devel / libglib2.0-dev-bin." >&2
    exit 1
fi

# 3. Validar metadata.json antes de empaquetar
python3 - "$STAGE/metadata.json" "$UUID" <<'PY'
import json, sys
path, uuid = sys.argv[1], sys.argv[2]
meta = json.load(open(path))
if meta.get("uuid") != uuid:
    raise SystemExit(f"ERROR: uuid '{meta.get('uuid')}' ≠ '{uuid}'")
for req in ("name", "description", "shell-version"):
    if req not in meta:
        raise SystemExit(f"ERROR: falta '{req}' en metadata.json")
if not meta.get("shell-version"):
    raise SystemExit("ERROR: 'shell-version' vacío")
print(f"  uuid          : {meta['uuid']}")
print(f"  nombre        : {meta['name']}")
print("  versión       : asignada por extensions.gnome.org")
print(f"  shell-version : {', '.join(meta['shell-version'])}")
PY

# 4. Comprimir
rm -f "$ZIP"
( cd "$STAGE" && zip -qr "$ZIP" "${ENTRIES[@]}" )

echo
echo "OK → $ZIP  ($(du -h "$ZIP" | cut -f1))"
unzip -l "$ZIP"
echo
echo "Para instalarlo en local:"
echo "  gnome-extensions install --force '$ZIP'"
echo "  gnome-extensions enable $UUID"
