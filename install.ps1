# Instala el harness SDD en un proyecto existente sin sobrescribir nada.
#
# Uso: .\install.ps1 <destino> [-Tool claude|opencode|none] [-Design]
#   -Tool    adaptador a copiar (por defecto: claude)
#   -Design  copia también design-system/ y su workflow de CI
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Destino,
    [ValidateSet('claude', 'opencode', 'none')][string]$Tool = 'claude',
    [switch]$Design
)
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Destino -PathType Container)) {
    throw "No existe el directorio destino: $Destino"
}
$src = $PSScriptRoot
$dest = (Resolve-Path -LiteralPath $Destino).Path
if ($src -eq $dest) { throw 'El destino no puede ser el propio harness.' }

$skipped = New-Object System.Collections.Generic.List[string]

# Copia un archivo sin sobrescribirlo si ya existe.
function Install-File([string]$rel) {
    $target = Join-Path $dest $rel
    if (Test-Path -LiteralPath $target) {
        Write-Host "  omitido (ya existe): $rel"
        $skipped.Add($rel)
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $src $rel) -Destination $target
        Write-Host "  copiado: $rel"
    }
}

# Copia un archivo o un directorio (recursivo) archivo a archivo.
function Install-Path([string]$rel) {
    $full = Join-Path $src $rel
    if (Test-Path -LiteralPath $full -PathType Container) {
        Get-ChildItem -LiteralPath $full -Recurse -File -Force | ForEach-Object {
            Install-File ($_.FullName.Substring($src.Length + 1) -replace '\\', '/')
        }
    } else {
        Install-File $rel
    }
}

Write-Host "Instalando harness SDD en $dest (adaptador: $Tool)"
Install-Path 'AGENTS.md'
Install-Path 'agents'
Install-Path 'specs/templates'

switch ($Tool) {
    'claude' {
        # CLAUDE.md existente: basta con que importe AGENTS.md.
        $claudeMd = Join-Path $dest 'CLAUDE.md'
        if (Test-Path -LiteralPath $claudeMd) {
            if (Select-String -LiteralPath $claudeMd -Pattern '^@AGENTS\.md' -Quiet) {
                Write-Host '  CLAUDE.md ya importa AGENTS.md'
            } else {
                Add-Content -LiteralPath $claudeMd -Value "`n@AGENTS.md"
                Write-Host '  añadido @AGENTS.md a CLAUDE.md existente'
            }
        } else {
            Install-File 'CLAUDE.md'
        }
        Install-Path '.claude/commands'
        Install-Path '.claude/settings.json'
    }
    'opencode' { Install-Path 'opencode.json' }
}

if ($Design) {
    Install-Path 'design-system'
    Install-Path '.github/workflows/design-system.yml'
}

if ($skipped.Count -gt 0) {
    Write-Host "`nRevisa y fusiona a mano estos archivos (no se han tocado):"
    $skipped | ForEach-Object { Write-Host "  - $_" }
}
Write-Host "`nListo. Siguiente paso: /sdd-spec-writer (Claude Code) o 'rol: spec-writer'."
