// Zero-paste pairing. The server installs a Chrome native messaging host that answers {type: 'pair'} with the relay
// token, and only our extension IDs may call it (allowed_origins). The extension asks it when it has no token or
// when the server's proof does not match (the token changed). The token still never crosses the WebSocket.
//
// Files: the host script and its launcher go to ~/.config/bopbop/ (not the npx cache, which can be
// cleared). macOS and Linux: one manifest per installed Chromium browser goes to that browser's per-user
// NativeMessagingHosts folder. Windows: one manifest next to the launcher, and a per-user registry key per browser
// (HKCU\Software\<browser>\NativeMessagingHosts\<name>) whose default value is the manifest path.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_FILE, relayToken } from './relay.ts';

export const HOST_NAME = 'dev.bopbop.host';
/** The relay extension in the Chrome Web Store. */
export const WEB_STORE_ID = 'emlckjhnbjogdooccahhbkhciflhobpp';

/** The ID Chrome gives an unpacked extension: SHA-256 of its real folder path, first 32 hex digits as a-p.
 *  On Windows Chrome hashes the UTF-16 path, with the drive letter in upper case. */
export function extensionIdForPath(dir: string, platform = process.platform): string {
  const path = existsSync(dir) ? realpathSync(dir) : dir;
  const upperDrive = path.replace(/^[a-z]:/, (d) => d.toUpperCase());
  const bytes = platform === 'win32' ? Buffer.from(upperDrive, 'utf16le') : Buffer.from(path);
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

// Per-user profile folders of Chromium browsers that run extensions from the Chrome Web Store.
const BROWSERS: Record<string, string[]> = {
  darwin: [
    'Library/Application Support/Google/Chrome',
    'Library/Application Support/Google/Chrome Beta',
    'Library/Application Support/Google/Chrome Dev',
    'Library/Application Support/Google/Chrome Canary',
    'Library/Application Support/Chromium',
    'Library/Application Support/BraveSoftware/Brave-Browser',
    'Library/Application Support/Microsoft Edge',
    'Library/Application Support/Vivaldi',
  ],
  // Relative to the config root: CHROME_CONFIG_HOME, else XDG_CONFIG_HOME, else ~/.config.
  linux: ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge', 'vivaldi'],
};

// Windows: profile folder under %LOCALAPPDATA% -> the browser's registry key. All Chrome channels read Google\Chrome.
const WIN_BROWSERS: [string, string][] = [
  ['Google/Chrome/User Data', 'Google\\Chrome'],
  ['Google/Chrome Beta/User Data', 'Google\\Chrome'],
  ['Google/Chrome Dev/User Data', 'Google\\Chrome'],
  ['Google/Chrome SxS/User Data', 'Google\\Chrome'],
  ['Chromium/User Data', 'Chromium'],
  ['BraveSoftware/Brave-Browser/User Data', 'BraveSoftware\\Brave-Browser'],
  ['Microsoft/Edge/User Data', 'Microsoft\\Edge'],
];

/** Windows: the HKCU registry keys to register the host under, for the installed browsers. */
export function browserRegistryKeys({
  platform = process.platform,
  env = process.env,
}: { platform?: string; env?: Record<string, string | undefined> } = {}): string[] {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return [];
  const keys = WIN_BROWSERS.filter(([dir]) => existsSync(join(env.LOCALAPPDATA!, dir))).map(
    ([, key]) => `HKCU\\Software\\${key}\\NativeMessagingHosts\\${HOST_NAME}`,
  );
  return [...new Set(keys)];
}

/** Set the default value of a registry key. True when it changed. */
function regSet(key: string, value: string): boolean {
  try {
    const now = execFileSync('reg', ['query', key, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (now.trimEnd().endsWith(value)) return false;
  } catch {
    /* no key yet */
  }
  execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', value, '/f'], { stdio: 'ignore' });
  return true;
}

/** NativeMessagingHosts folders of the installed browsers (the profile folder exists). Creates nothing. */
export function browserHostDirs({
  home = homedir(),
  platform = process.platform,
  env = process.env,
}: { home?: string; platform?: string; env?: Record<string, string | undefined> } = {}): string[] {
  const root = platform === 'linux' ? env.CHROME_CONFIG_HOME || env.XDG_CONFIG_HOME || join(home, '.config') : home;
  return (BROWSERS[platform] ?? [])
    .map((p) => join(root, p))
    .filter((p) => existsSync(p))
    .map((p) => join(p, 'NativeMessagingHosts'));
}

// The host: one framed request in, one framed reply out (4-byte little-endian length + JSON). No dependencies.
const hostScript = (tokenFile: string) => `// bopbop native messaging host: gives the relay token to the relay extension.
import { readFileSync } from 'node:fs';
const TOKEN_FILE = ${JSON.stringify(tokenFile)};
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
  let reply;
  try {
    const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
    if (msg?.type !== 'pair') reply = { error: 'unknown request' };
    else {
      try {
        reply = { token: readFileSync(TOKEN_FILE, 'utf8').trim() };
      } catch {
        reply = { error: 'no token yet: start the MCP server once' };
      }
    }
  } catch {
    reply = { error: 'bad request' };
  }
  const body = Buffer.from(JSON.stringify(reply));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([head, body]), () => process.exit(0));
});
`;

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Write `content` unless the file already has it. True when written. */
function writeIfChanged(file: string, content: string, mode?: number): boolean {
  if (existsSync(file) && readFileSync(file, 'utf8') === content) return false;
  writeFileSync(file, content, mode == null ? undefined : { mode });
  if (mode != null) chmodSync(file, mode);
  return true;
}

export interface InstallOptions {
  /** NativeMessagingHosts folders to write the manifest into (default: the installed browsers). */
  dirs?: string[];
  /** Windows registry keys to point at the manifest (default: the installed browsers). */
  regKeys?: string[];
  /** Extension IDs allowed to call the host. */
  ids: string[];
  tokenFile: string;
  /** Where the host script and its launcher go. */
  binDir: string;
  /** The JavaScript runtime that runs the host (Chrome starts it with a minimal PATH, so an absolute path). */
  runtime?: string;
  /** Selects the launcher: a .bat on Windows, a shell script elsewhere. */
  platform?: string;
  /** Sets a registry key's default value; true when it changed. */
  reg?: (key: string, value: string) => boolean;
}

/** Install or update the host. Returns the manifests and registry keys it wrote (unchanged ones are not rewritten). */
export function installNativeHost({
  dirs = browserHostDirs(),
  regKeys = browserRegistryKeys(),
  ids,
  tokenFile,
  binDir,
  runtime = process.execPath,
  platform = process.platform,
  reg = regSet,
}: InstallOptions) {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const script = join(binDir, 'native-host.mjs');
  writeIfChanged(script, hostScript(tokenFile));
  const launcher = join(binDir, platform === 'win32' ? 'native-host.bat' : 'native-host');
  // cmd reads a .bat in the legacy code page: switch to UTF-8 (output to nul, stdout is the native-messaging channel)
  // and find the script next to the launcher (%~dp0), so a non-ASCII user folder works.
  if (platform === 'win32') writeIfChanged(launcher, `@echo off\r\nchcp 65001 >nul\r\n"${runtime}" "%~dp0native-host.mjs" %*\r\n`);
  else writeIfChanged(launcher, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(script)} "$@"\n`, 0o755);
  const manifest =
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'bopbop: pairs the relay extension with the local MCP server',
        path: launcher,
        type: 'stdio',
        allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
      },
      null,
      2,
    ) + '\n';
  const written: string[] = [];
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${HOST_NAME}.json`);
    if (writeIfChanged(file, manifest)) written.push(file);
  }
  if (regKeys.length) {
    const file = join(binDir, `${HOST_NAME}.json`);
    if (writeIfChanged(file, manifest)) written.push(file);
    for (const key of regKeys) if (reg(key, file)) written.push(key);
  }
  return { written, launcher };
}

/** On server start (extension mode): make the token and install or update the host for every installed browser.
 *  Allowed: the Web Store extension, a local build of this checkout, and BBM_EXTENSION_IDS. Off: BBM_NATIVE_HOST=0. */
export function setupNativePairing(log: (m: string) => void) {
  if (process.env.BBM_NATIVE_HOST === '0') return;
  if (process.env.BBM_RELAY_TOKEN) return log('[bbm] BBM_RELAY_TOKEN is set: paste it on the extension options page (no native pairing)');
  relayToken(); // the host reads the token file: make it now, not on the first tool call
  const localBuild = fileURLToPath(new URL('../dist/extension', import.meta.url)); // a checkout of the repo
  const ids = [WEB_STORE_ID, ...(existsSync(localBuild) ? [extensionIdForPath(localBuild)] : [])];
  ids.push(
    ...(process.env.BBM_EXTENSION_IDS?.split(',')
      .map((s) => s.trim())
      .filter((s) => /^[a-p]{32}$/.test(s)) ?? []),
  );
  const { written } = installNativeHost({ ids, tokenFile: TOKEN_FILE, binDir: dirname(TOKEN_FILE) });
  if (written.length) log(`[bopbop] native pairing host installed: ${written.join(', ')}`);
}
