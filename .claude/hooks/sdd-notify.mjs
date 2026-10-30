// Notificación de escritorio cuando Claude Code se queda esperando (un
// permiso o una respuesta). Sin ella, un rol que pide permiso mientras no
// miras la terminal deja el pipeline parado: en proyectos reales, las esperas
// eran el 30-75 % del tiempo activo de cada rol.
//
// Lo ejecuta el hook Notification de .claude/settings.json, que pasa por
// stdin { message, cwd, ... }. Desactívalo con SDD_NOTIFY=0.
// Nunca falla: si el sistema no tiene cómo notificar, no hace nada.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

if (process.env.SDD_NOTIFY === '0') process.exit(0);

let hook = {};
try { hook = JSON.parse(readFileSync(0, 'utf8')); } catch { /* sin stdin */ }
const titulo = `Claude Code · ${basename(hook.cwd ?? process.cwd())}`;
const mensaje = String(hook.message ?? 'Esperando tu respuesta').slice(0, 200);

// El texto va por variables de entorno para no tener que escaparlo.
const env = { ...process.env, SDD_TITULO: titulo, SDD_MENSAJE: mensaje };
const lanzar = (cmd, args) => {
  try {
    const p = spawn(cmd, args, { env, detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* sin notificador */ }
};

if (process.platform === 'win32') {
  lanzar('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; ' +
    '$n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; ' +
    '$n.ShowBalloonTip(10000, $env:SDD_TITULO, $env:SDD_MENSAJE, "Info"); Start-Sleep 10; $n.Dispose()']);
} else if (process.platform === 'darwin') {
  lanzar('osascript', ['-e', 'display notification (system attribute "SDD_MENSAJE") with title (system attribute "SDD_TITULO")']);
} else {
  lanzar('notify-send', [titulo, mensaje]);
}
