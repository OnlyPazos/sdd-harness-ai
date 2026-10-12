# Instala (o actualiza) el harness SDD en un proyecto existente.
#
# Uso: .\install.ps1 <destino> [-Tool claude|opencode|none] [-Design] [-Update] [-Force]
#   -Tool    adaptador a copiar (por defecto: claude)
#   -Design  copia también design-system/ y su workflow de CI
#   -Update  actualiza a la versión actual del harness:
#            - agents/ y .claude/commands/ se sobrescriben
#            - AGENTS.md: solo se reemplaza el bloque <!-- sdd:begin/end -->
#            - opencode.json: se fusionan los agentes del harness (requiere node)
#            - el resto solo se copia si falta y, si difiere, se lista para
#              fusionarlo a mano
#   -Force   implica -Update; lo que -Update no pueda actualizar se
#            sobrescribe, guardando antes una copia <archivo>.bak-<fecha>.
#            design-system/ nunca se sobrescribe
param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Destino,
    [ValidateSet('claude', 'opencode', 'none')][string]$Tool = 'claude',
    [switch]$Design,
    [switch]$Update,
    [switch]$Force
)
$ErrorActionPreference = 'Stop'
if ($Force) { $Update = [switch]$true }

if (-not (Test-Path -LiteralPath $Destino -PathType Container)) {
    throw "No existe el directorio destino: $Destino"
}
$src = $PSScriptRoot
$dest = (Resolve-Path -LiteralPath $Destino).Path
if ($src -eq $dest) { throw 'El destino no puede ser el propio harness.' }

$skipped = New-Object System.Collections.Generic.List[string]
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$blockPattern = '(?ms)^<!-- sdd:begin.*?^<!-- sdd:end[^\r\n]*'

# Intenta actualizar $target sin perder lo propio del proyecto. Devuelve el
# contenido resultante, o $null si no es posible.
function Get-SmartUpdate([string]$source, [string]$target, [string]$mode) {
    switch ($mode) {
        'block' {
            $own = [IO.File]::ReadAllText($target)
            if ($own -notmatch $blockPattern) { return $null }
            $block = [regex]::Match([IO.File]::ReadAllText($source), $blockPattern).Value
            return [regex]::Replace($own, $blockPattern, [Text.RegularExpressions.MatchEvaluator] { param($m) $block })
        }
        'json' {
            if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return $null }
            $out = [IO.Path]::GetTempFileName()
            try {
                & node (Join-Path $src 'scripts/merge-opencode.mjs') $source $target $out 2>$null
                if ($LASTEXITCODE -ne 0) { return $null }
                return [IO.File]::ReadAllText($out)
            } finally {
                Remove-Item -LiteralPath $out -ErrorAction SilentlyContinue
            }
        }
    }
    return $null
}

# Copia un archivo si falta. $mode indica cómo actualizarlo con -Update si
# ya existe y difiere:
#   managed  se sobrescribe (archivo 100% del harness)
#   block    se reemplaza solo el bloque <!-- sdd:begin/end -->
#   json     se fusiona con scripts/merge-opencode.mjs
#   user     nunca se sobrescribe, ni con -Force (contenido del usuario)
#   (vacío)  solo con -Force, con copia de seguridad
function Install-File([string]$rel, [string]$mode = '') {
    $source = Join-Path $src $rel
    $target = Join-Path $dest $rel
    if (Test-Path -LiteralPath $target) {
        $smart = $null
        if ((Get-FileHash -LiteralPath $source).Hash -eq (Get-FileHash -LiteralPath $target).Hash) {
            if ($Update) { Write-Host "  al día: $rel" }
        } elseif ($Update -and $mode -eq 'managed') {
            Copy-Item -LiteralPath $source -Destination $target -Force
            Write-Host "  actualizado: $rel"
        } elseif ($Update -and ($null -ne ($smart = Get-SmartUpdate $source $target $mode))) {
            if ($smart -ceq [IO.File]::ReadAllText($target)) {
                Write-Host "  al día: $rel"
            } else {
                [IO.File]::WriteAllText($target, $smart, $utf8)
                Write-Host "  actualizado (solo la parte del harness): $rel"
            }
        } elseif ($Force -and $mode -ne 'user') {
            $bak = "$rel.bak-$stamp"
            Copy-Item -LiteralPath $target -Destination (Join-Path $dest $bak)
            Copy-Item -LiteralPath $source -Destination $target -Force
            Write-Host "  sobrescrito (copia en $bak): $rel"
        } else {
            switch ($mode) {
                'block' { Write-Host "  omitido (difiere y no tiene bloque <!-- sdd:begin/end -->): $rel" }
                'json' { Write-Host "  omitido (difiere y no se pudo fusionar: ¿falta node o JSON no válido?): $rel" }
                default { Write-Host "  omitido (ya existe y difiere): $rel" }
            }
            $skipped.Add($rel)
        }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath $source -Destination $target
        Write-Host "  copiado: $rel"
    }
}

# Copia un archivo o un directorio (recursivo) archivo a archivo.
function Install-Path([string]$rel, [string]$mode = '') {
    $full = Join-Path $src $rel
    if (Test-Path -LiteralPath $full -PathType Container) {
        Get-ChildItem -LiteralPath $full -Recurse -File -Force | ForEach-Object {
            Install-File ($_.FullName.Substring($src.Length + 1) -replace '\\', '/') $mode
        }
    } else {
        Install-File $rel $mode
    }
}

$accion = if ($Update) { 'Actualizando' } else { 'Instalando' }
Write-Host "$accion harness SDD en $dest (adaptador: $Tool)"
Install-Path 'AGENTS.md' block
Install-Path 'agents' managed
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
        Install-Path '.claude/commands' managed
        Install-Path '.claude/settings.json'
    }
    'opencode' { Install-Path 'opencode.json' json }
}

if ($Design) {
    Install-Path 'design-system' user
    Install-Path '.github/workflows/design-system.yml'
}

if ($skipped.Count -gt 0) {
    Write-Host "`nRevisa y fusiona a mano estos archivos (no se han tocado):"
    $skipped | ForEach-Object { Write-Host "  - $_" }
    if (-not $Force) { Write-Host 'O vuelve a ejecutar con -Force para sobrescribirlos con copia .bak (salvo design-system/).' }
}
Write-Host "`nListo. Siguiente paso: /sdd-spec-writer (Claude Code) o 'rol: spec-writer'."
