#!/usr/bin/env sh
# Instala (o actualiza) el harness SDD en un proyecto existente.
#
# Uso: ./install.sh <destino> [--tool claude|opencode|none] [--design] [--update] [--force]
#   --tool    adaptador a copiar (por defecto: claude)
#   --design  copia también design-system/ y su workflow de CI
#   --update  actualiza a la versión actual del harness:
#             - agents/ y .claude/commands/ se sobrescriben
#             - AGENTS.md: solo se reemplaza el bloque <!-- sdd:begin/end -->
#             - opencode.json: se fusionan los agentes del harness (requiere node)
#             - el resto solo se copia si falta y, si difiere, se lista para
#               fusionarlo a mano
#   --force   implica --update; lo que --update no pueda actualizar se
#             sobrescribe, guardando antes una copia <archivo>.bak-<fecha>.
#             design-system/ nunca se sobrescribe
set -eu

usage() { echo "Uso: $0 <destino> [--tool claude|opencode|none] [--design] [--update] [--force]" >&2; exit 1; }

[ $# -ge 1 ] || usage
dest=$1; shift
tool=claude
design=0
update=0
force=0
while [ $# -gt 0 ]; do
  case $1 in
    --tool) [ $# -ge 2 ] || usage; tool=$2; shift 2 ;;
    --design) design=1; shift ;;
    --update) update=1; shift ;;
    --force) update=1; force=1; shift ;;
    *) usage ;;
  esac
done
case $tool in claude|opencode|none) ;; *) usage ;; esac
[ -d "$dest" ] || { echo "No existe el directorio destino: $dest" >&2; exit 1; }

src=$(cd "$(dirname "$0")" && pwd)
dest=$(cd "$dest" && pwd)
[ "$src" != "$dest" ] || { echo "El destino no puede ser el propio harness." >&2; exit 1; }

# Copia un archivo o directorio (recursivo) archivo a archivo. El segundo
# argumento indica cómo actualizarlo con --update si ya existe y difiere:
#   managed  se sobrescribe (archivo 100% del harness)
#   block    se reemplaza solo el bloque <!-- sdd:begin/end -->
#   json     se fusiona con scripts/merge-opencode.mjs
#   user     nunca se sobrescribe, ni con --force (contenido del usuario)
#   (vacío)  solo con --force, con copia de seguridad
install_path() {
  rel=$1
  if [ -d "$src/$rel" ]; then
    (cd "$src" && find "$rel" -type f) | while IFS= read -r f; do install_file "$f" "${2:-}"; done
  else
    install_file "$rel" "${2:-}"
  fi
}

has_block() {
  grep -q '^<!-- sdd:begin' "$1" && grep -q '^<!-- sdd:end' "$1"
}

# Escribe en stdout $2 con su bloque sdd sustituido por el de $1.
replace_block() {
  awk -v srcf="$1" '
    BEGIN {
      while ((getline l < srcf) > 0) {
        if (l ~ /^<!-- sdd:begin/) inb = 1
        if (inb) blk = blk l "\n"
        if (l ~ /^<!-- sdd:end/) inb = 0
      }
    }
    /^<!-- sdd:begin/ { printf "%s", blk; skip = 1; next }
    skip && /^<!-- sdd:end/ { skip = 0; next }
    !skip { print }
  ' "$2"
}

# Intenta actualizar $dest/$1 sin perder lo propio del proyecto. Deja el
# resultado en $tmp y devuelve 1 si no es posible.
smart_update() {
  case $2 in
    block)
      has_block "$dest/$1" || return 1
      replace_block "$src/$1" "$dest/$1" > "$tmp" ;;
    json)
      command -v node >/dev/null 2>&1 || return 1
      node "$src/scripts/merge-opencode.mjs" "$src/$1" "$dest/$1" "$tmp" 2>/dev/null || return 1 ;;
    *) return 1 ;;
  esac
}

install_file() {
  f=$1
  mode=${2:-}
  if [ -e "$dest/$f" ]; then
    if cmp -s "$src/$f" "$dest/$f"; then
      [ $update -eq 0 ] || echo "  al día: $f"
    elif [ $update -eq 1 ] && [ "$mode" = managed ]; then
      cp "$src/$f" "$dest/$f"
      echo "  actualizado: $f"
    elif [ $update -eq 1 ] && smart_update "$f" "$mode"; then
      if cmp -s "$tmp" "$dest/$f"; then
        echo "  al día: $f"
      else
        cp "$tmp" "$dest/$f"
        echo "  actualizado (solo la parte del harness): $f"
      fi
    elif [ $force -eq 1 ] && [ "$mode" != user ]; then
      bak="$f.bak-$stamp"
      cp "$dest/$f" "$dest/$bak"
      cp "$src/$f" "$dest/$f"
      echo "  sobrescrito (copia en $bak): $f"
    else
      case $mode in
        block) echo "  omitido (difiere y no tiene bloque <!-- sdd:begin/end -->): $f" ;;
        json) echo "  omitido (difiere y no se pudo fusionar: ¿falta node o JSON no válido?): $f" ;;
        *) echo "  omitido (ya existe y difiere): $f" ;;
      esac
      echo "$f" >> "$skiplog"
    fi
  else
    mkdir -p "$dest/$(dirname "$f")"
    cp "$src/$f" "$dest/$f"
    echo "  copiado: $f"
  fi
}

skiplog=$(mktemp)
tmp=$(mktemp)
trap 'rm -f "$skiplog" "$tmp"' EXIT
stamp=$(date +%Y%m%d%H%M%S)

if [ $update -eq 1 ]; then accion=Actualizando; else accion=Instalando; fi
echo "$accion harness SDD en $dest (adaptador: $tool)"
install_path AGENTS.md block
install_path agents managed
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
    install_path .claude/commands managed
    install_path .claude/settings.json
    ;;
  opencode)
    install_path opencode.json json
    ;;
esac

if [ $design -eq 1 ]; then
  install_path design-system user
  install_path .github/workflows/design-system.yml
fi

if [ -s "$skiplog" ]; then
  echo
  echo "Revisa y fusiona a mano estos archivos (no se han tocado):"
  sed 's/^/  - /' "$skiplog"
  [ $force -eq 1 ] || echo "O vuelve a ejecutar con --force para sobrescribirlos con copia .bak (salvo design-system/)."
fi
echo
echo "Listo. Siguiente paso: /sdd-spec-writer (Claude Code) o 'rol: spec-writer'."
