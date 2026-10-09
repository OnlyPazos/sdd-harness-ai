#!/usr/bin/env sh
# Instala el harness SDD en un proyecto existente sin sobrescribir nada.
#
# Uso: ./install.sh <destino> [--tool claude|opencode|none] [--design]
#   --tool    adaptador a copiar (por defecto: claude)
#   --design  copia también design-system/ y su workflow de CI
set -eu

usage() { echo "Uso: $0 <destino> [--tool claude|opencode|none] [--design]" >&2; exit 1; }

[ $# -ge 1 ] || usage
dest=$1; shift
tool=claude
design=0
while [ $# -gt 0 ]; do
  case $1 in
    --tool) [ $# -ge 2 ] || usage; tool=$2; shift 2 ;;
    --design) design=1; shift ;;
    *) usage ;;
  esac
done
case $tool in claude|opencode|none) ;; *) usage ;; esac
[ -d "$dest" ] || { echo "No existe el directorio destino: $dest" >&2; exit 1; }

src=$(cd "$(dirname "$0")" && pwd)
dest=$(cd "$dest" && pwd)
[ "$src" != "$dest" ] || { echo "El destino no puede ser el propio harness." >&2; exit 1; }

# Copia un archivo o directorio (recursivo) sin sobrescribir los existentes.
install_path() {
  rel=$1
  if [ -d "$src/$rel" ]; then
    (cd "$src" && find "$rel" -type f) | while IFS= read -r f; do install_file "$f"; done
  else
    install_file "$rel"
  fi
}

install_file() {
  f=$1
  if [ -e "$dest/$f" ]; then
    echo "  omitido (ya existe): $f"
    echo "$f" >> "$skiplog"
  else
    mkdir -p "$dest/$(dirname "$f")"
    cp "$src/$f" "$dest/$f"
    echo "  copiado: $f"
  fi
}

skiplog=$(mktemp)
trap 'rm -f "$skiplog"' EXIT

echo "Instalando harness SDD en $dest (adaptador: $tool)"
install_path AGENTS.md
install_path agents
install_path specs/templates

case $tool in
  claude)
    # CLAUDE.md existente: basta con que importe AGENTS.md.
    if [ -e "$dest/CLAUDE.md" ]; then
      if grep -q '^@AGENTS.md' "$dest/CLAUDE.md"; then
        echo "  CLAUDE.md ya importa AGENTS.md"
      else
        printf '\n@AGENTS.md\n' >> "$dest/CLAUDE.md"
        echo "  añadido @AGENTS.md a CLAUDE.md existente"
      fi
    else
      install_file CLAUDE.md
    fi
    install_path .claude/commands
    install_path .claude/settings.json
    ;;
  opencode)
    install_path opencode.json
    ;;
esac

if [ $design -eq 1 ]; then
  install_path design-system
  install_path .github/workflows/design-system.yml
fi

if [ -s "$skiplog" ]; then
  echo
  echo "Revisa y fusiona a mano estos archivos (no se han tocado):"
  sed 's/^/  - /' "$skiplog"
fi
echo
echo "Listo. Siguiente paso: /sdd-spec-writer (Claude Code) o 'rol: spec-writer'."
