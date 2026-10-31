// Zero-paste pairing. The server installs a Chrome native messaging host that answers {type: 'pair'} with the relay
// token, and only our extension IDs may call it (allowed_origins). The extension asks it when it has no token or
// when the server's proof does not match (the token changed). The token still never crosses the WebSocket.
//
// Files: the host script and its launcher go to ~/.config/better-browser-mcp/ (not the npx cache, which can be
// cleared); one manifest per installed Chromium browser goes to that browser's per-user NativeMessagingHosts folder.
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOKEN_FILE, relayToken } from './relay.ts';

export const HOST_NAME = 'dev.bopbop.host';
/** The relay extension in the Chrome Web Store. */
export const WEB_STORE_ID = 'emlckjhnbjogdooccahhbkhciflhobpp';

/** The ID Chrome gives an unpacked extension: SHA-256 of its real folder path, first 32 hex digits as a-p. */
export function extensionIdForPath(dir: string): string {
  const path = existsSync(dir) ? realpathSync(dir) : dir;
  const hex = createHash('sha256').update(path).digest('hex').slice(0, 32);
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
  // Windows registers hosts in the registry: not supported yet (paste the token on the options page).
};

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
const hostScript = (tokenFile: string) => `// better-browser-mcp native messaging host: gives the relay token to the relay extension.
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
  /** Extension IDs allowed to call the host. */
  ids: string[];
  tokenFile: string;
  /** Where the host script and its launcher go. */
  binDir: string;
  /** The JavaScript runtime that runs the host (Chrome starts it with a minimal PATH, so an absolute path). */
  runtime?: string;
}

/** Install or update the host. Returns the manifests it wrote (unchanged ones are not rewritten). */
export function installNativeHost({ dirs = browserHostDirs(), ids, tokenFile, binDir, runtime = process.execPath }: InstallOptions) {
  mkdirSync(binDir, { recursive: true, mode: 0o700 });
  const script = join(binDir, 'native-host.mjs');
  const launcher = join(binDir, 'native-host');
  writeIfChanged(script, hostScript(tokenFile));
  writeIfChanged(launcher, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(script)} "$@"\n`, 0o755);
  const manifest =
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'better-browser-mcp: pairs the relay extension with the local MCP server',
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
  if (written.length) log(`[bbm] native pairing host installed: ${written.join(', ')}`);
}
