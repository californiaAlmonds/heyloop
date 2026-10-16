import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir } from './config.js';

export function startupDir(): string {
  if (process.env.HEYLOOP_STARTUP_DIR) return process.env.HEYLOOP_STARTUP_DIR;
  const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function autostartLauncherPath(): string {
  return join(startupDir(), 'heyloop.cmd');
}

export function isAutostartInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  return existsSync(autostartLauncherPath());
}

export function handleAutostart(action: string | undefined): void {
  if (process.platform !== 'win32') {
    console.log('Autostart is not supported yet on this OS.');
    return;
  }

  const file = autostartLauncherPath();

  switch (action) {
    case 'install': {
      const binPath = fileURLToPath(new URL('../bin/heyloop.mjs', import.meta.url));
      const logPath = join(dataDir(), 'daemon.log');
      const lines = ['@echo off'];
      if (process.env.HEYLOOP_HOME) {
        lines.push(`set "HEYLOOP_HOME=${process.env.HEYLOOP_HOME}"`);
      }
      // Start-Process -WindowStyle Hidden spawns cmd/node detached so no console window lingers at login.
      lines.push(
        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'cmd.exe' -ArgumentList '/d /s /c \\"\\"${process.execPath}\\" \\"${binPath}\\" start >> \\"${logPath}\\" 2>&1\\"'"`,
      );
      mkdirSync(startupDir(), { recursive: true });
      writeFileSync(file, lines.join('\r\n') + '\r\n');
      console.log(`Installed autostart launcher: ${file}`);
      return;
    }
    case 'uninstall': {
      if (existsSync(file)) {
        unlinkSync(file);
        console.log(`Removed autostart launcher: ${file}`);
      } else {
        console.log('Autostart is not installed.');
      }
      return;
    }
    case 'status': {
      console.log(isAutostartInstalled() ? `Autostart: installed (${file})` : 'Autostart: not installed');
      return;
    }
    default:
      throw new Error('Usage: heyloop autostart install|uninstall|status');
  }
}
