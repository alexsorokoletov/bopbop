// Browser-level CDP wrapper: tab list, create/close/activate, attach.
// Works the same over a direct CDP WebSocket and over the extension relay,
// because the relay emulates the Target.* domain with chrome.tabs + chrome.debugger.

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { CDPConnection, webSocketTransport, type Json } from './connection.ts';

export interface TargetInfo {
  targetId: string;
  type: string;
  url: string;
  title: string;
  openerId?: string;
  attached?: boolean;
  [k: string]: Json;
}

export class CDPBrowser {
  conn: CDPConnection;
  targets: Map<string, TargetInfo>;
  listeners: { created: Set<(t: TargetInfo) => void>; destroyed: Set<(id: string) => void>; changed: Set<(t: TargetInfo) => void> };
  _onClose?: () => unknown;
  process?: ChildProcess;
  extensionId?: string;
  port?: number;
  mode?: string;
  relay?: unknown; // extension mode: the RelayServer this link came from

  constructor(conn: CDPConnection, { onClose }: { onClose?: () => unknown } = {}) {
    this.conn = conn;
    this.targets = new Map(); // targetId -> {targetId, url, title, openerId, type}
    this.listeners = { created: new Set(), destroyed: new Set(), changed: new Set() };
    this._onClose = onClose;
  }

  async init() {
    this.conn.on('Target.targetCreated', ({ targetInfo: t }) => {
      if (t.type !== 'page') return;
      this.targets.set(t.targetId, t);
      for (const fn of this.listeners.created) fn(t);
    });
    this.conn.on('Target.targetInfoChanged', ({ targetInfo: t }) => {
      if (!this.targets.has(t.targetId)) return;
      this.targets.set(t.targetId, t);
      for (const fn of this.listeners.changed) fn(t);
    });
    this.conn.on('Target.targetDestroyed', ({ targetId }) => {
      if (!this.targets.delete(targetId)) return;
      for (const fn of this.listeners.destroyed) fn(targetId);
    });
    await this.conn.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await this.conn.send('Target.getTargets');
    for (const t of targetInfos as TargetInfo[]) if (t.type === 'page') this.targets.set(t.targetId, t);
  }

  onTabCreated(fn: (t: TargetInfo) => void) {
    this.listeners.created.add(fn);
  }
  onTabDestroyed(fn: (id: string) => void) {
    this.listeners.destroyed.add(fn);
  }
  onTabChanged(fn: (t: TargetInfo) => void) {
    this.listeners.changed.add(fn);
  }

  listTabs() {
    return [...this.targets.values()].filter((t) => !t.url.startsWith('devtools://') && !t.url.startsWith('chrome-extension://'));
  }

  async createTab(url = 'about:blank', { background = false, newWindow = false } = {}): Promise<string> {
    const { targetId } = await this.conn.send('Target.createTarget', { url, background, ...(newWindow ? { newWindow } : {}) });
    return targetId;
  }

  closeTab(targetId: string) {
    return this.conn.send('Target.closeTarget', { targetId });
  }
  activateTab(targetId: string) {
    return this.conn.send('Target.activateTarget', { targetId });
  }

  async attach(targetId: string) {
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    return this.conn.session(sessionId);
  }

  async close() {
    try {
      this.conn.close();
    } catch {}
    await this._onClose?.();
  }
}

function findChromium() {
  if (process.env.BBM_CHROME) return process.env.BBM_CHROME;
  // Playwright's Chromium: macOS, Linux and Windows caches, old and new folder names.
  const caches = [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')];
  if (process.env.LOCALAPPDATA) caches.push(join(process.env.LOCALAPPDATA, 'ms-playwright'));
  for (const pw of caches) {
    if (!existsSync(pw)) continue;
    const dirs = readdirSync(pw)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const rel of [
        'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
        'chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium',
        'chrome-linux64/chrome',
        'chrome-linux/chrome',
        'chrome-win64/chrome.exe',
        'chrome-win/chrome.exe',
      ]) {
        if (existsSync(join(pw, d, rel))) return join(pw, d, rel);
      }
    }
  }
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  throw new Error('No Chromium found; set BBM_CHROME');
}

/** Launch a fresh Chromium with a temp profile. */
const QUIET_PREFS = {
  autofill: { profile_enabled: false, credit_card_enabled: false },
  credentials_enable_service: false,
  profile: { password_manager_enabled: false },
};

export async function launchChromium({
  headless = true,
  executable = findChromium(),
  args = [] as string[],
  userDataDir,
}: { headless?: boolean; executable?: string; args?: string[]; userDataDir?: string } = {}) {
  const dir = userDataDir || (await mkdtemp(join(tmpdir(), 'bbm-profile-')));
  // A fresh profile: no "Save address / card / password?" bubbles when an agent fills forms (they pop over the
  // user's screen and wait for a click). A given userDataDir is the user's: we leave its settings alone.
  if (!userDataDir) {
    await mkdir(join(dir, 'Default'), { recursive: true });
    await writeFile(join(dir, 'Default', 'Preferences'), JSON.stringify(QUIET_PREFS));
  }
  const proc = spawn(
    executable,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion',
      '--password-store=basic',
      '--use-mock-keychain',
      // keep background/occluded tabs rendering, else input acks wait seconds for a frame
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      ...(headless ? ['--headless=new'] : []),
      // extra flags, e.g. BBM_CHROME_ARGS=--no-sandbox in CI containers where the sandbox cannot start
      ...(process.env.BBM_CHROME_ARGS?.split(/\s+/).filter(Boolean) ?? []),
      ...args,
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d;
    if (stderr.length > 20000) stderr = stderr.slice(-10000);
  });
  const portFile = join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  let wsUrl: string | undefined;
  while (!wsUrl) {
    if (proc.exitCode !== null) throw new Error(`Chromium exited: ${stderr.slice(-2000)}`);
    if (Date.now() - t0 > 20000) {
      proc.kill();
      throw new Error(`Chromium launch timeout: ${stderr.slice(-1500)}`);
    }
    try {
      const [port, path] = (await readFile(portFile, 'utf8')).trim().split('\n');
      if (port && path) wsUrl = `ws://127.0.0.1:${port}${path}`;
    } catch {}
    if (!wsUrl) await new Promise((r) => setTimeout(r, 50));
  }
  const conn = new CDPConnection(await webSocketTransport(wsUrl));
  const browser = new CDPBrowser(conn, {
    onClose: async () => {
      proc.kill();
      await new Promise<void>((r) => (proc.exitCode !== null ? r() : proc.once('exit', () => r())));
      if (!userDataDir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  });
  await browser.init();
  browser.process = proc;
  return browser;
}

/** Connect to a running browser: http://host:port or ws://... */
export async function connectCDP(endpoint: string) {
  let wsUrl = endpoint;
  if (endpoint.startsWith('http')) {
    const res = await fetch(new URL('/json/version', endpoint));
    wsUrl = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
  }
  const browser = new CDPBrowser(new CDPConnection(await webSocketTransport(wsUrl)));
  await browser.init();
  return browser;
}
