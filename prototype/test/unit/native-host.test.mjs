// Native messaging pairing: the server installs a tiny host that hands the relay token to our extension only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST_NAME, WEB_STORE_ID, extensionIdForPath, installNativeHost, browserHostDirs } from '../../src/native-host.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'bbm-nh-'));

/** Send one native-messaging frame to the host and read its one reply, as Chrome does. */
function ask(launcher, message) {
  return new Promise((resolve, reject) => {
    const p = spawn(launcher, ['chrome-extension://' + WEB_STORE_ID + '/'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const chunks = [];
    p.stdout.on('data', (d) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => {
      const out = Buffer.concat(chunks);
      if (out.length < 4) return reject(new Error('no reply'));
      resolve(JSON.parse(out.subarray(4, 4 + out.readUInt32LE(0)).toString()));
    });
    const body = Buffer.from(JSON.stringify(message));
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length);
    p.stdin.end(Buffer.concat([head, body]));
  });
}

test('an unpacked extension ID is the hash of its folder, in the letters a-p', () => {
  const id = extensionIdForPath('/x/dist/extension');
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(extensionIdForPath('/x/dist/extension'), id);
  assert.notEqual(extensionIdForPath('/y/dist/extension'), id);
});

test('install writes a manifest that only our extensions may use, and a host that answers with the token', async () => {
  const home = tmp();
  const hostsDir = join(home, 'Chrome', 'NativeMessagingHosts');
  const tokenFile = join(home, 'relay-token');
  writeFileSync(tokenFile, 'a'.repeat(48) + '\n');
  const res = installNativeHost({ dirs: [hostsDir], ids: [WEB_STORE_ID, 'b'.repeat(32)], tokenFile, binDir: join(home, 'bin') });
  assert.deepEqual(res.written, [join(hostsDir, `${HOST_NAME}.json`)]);

  const manifest = JSON.parse(readFileSync(join(hostsDir, `${HOST_NAME}.json`), 'utf8'));
  assert.equal(manifest.name, HOST_NAME);
  assert.equal(manifest.type, 'stdio');
  assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${WEB_STORE_ID}/`, `chrome-extension://${'b'.repeat(32)}/`]);
  assert.ok(manifest.path.startsWith(join(home, 'bin')), manifest.path);
  assert.ok(statSync(manifest.path).mode & 0o100, 'the launcher is executable');

  assert.deepEqual(await ask(manifest.path, { type: 'pair' }), { token: 'a'.repeat(48) });
  assert.match((await ask(manifest.path, { type: 'other' })).error, /unknown request/);
  rmSync(tokenFile);
  assert.match((await ask(manifest.path, { type: 'pair' })).error, /no token/);
});

test('install is idempotent: a second run with the same inputs rewrites nothing', () => {
  const home = tmp();
  const args = { dirs: [join(home, 'NativeMessagingHosts')], ids: [WEB_STORE_ID], tokenFile: join(home, 't'), binDir: join(home, 'bin') };
  assert.equal(installNativeHost(args).written.length, 1);
  assert.equal(installNativeHost(args).written.length, 0);
});

test('host folders: only browsers that are installed (their profile folder exists)', () => {
  const home = tmp();
  mkdirSync(join(home, 'Library/Application Support/Google/Chrome'), { recursive: true });
  mkdirSync(join(home, 'Library/Application Support/BraveSoftware/Brave-Browser'), { recursive: true });
  assert.deepEqual(browserHostDirs({ home, platform: 'darwin' }), [
    join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts'),
    join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts'),
  ]);
  mkdirSync(join(home, '.config/chromium'), { recursive: true });
  assert.deepEqual(browserHostDirs({ home, platform: 'linux', env: {} }), [join(home, '.config/chromium/NativeMessagingHosts')]);
  assert.deepEqual(browserHostDirs({ home, platform: 'win32' }), []);
  assert.ok(!existsSync(join(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts')), 'listing creates nothing');
});

test('Linux: the config root follows CHROME_CONFIG_HOME, then XDG_CONFIG_HOME', () => {
  const home = tmp();
  const xdg = join(home, 'xdg');
  mkdirSync(join(xdg, 'google-chrome'), { recursive: true });
  assert.deepEqual(browserHostDirs({ home, platform: 'linux', env: { XDG_CONFIG_HOME: xdg } }), [join(xdg, 'google-chrome/NativeMessagingHosts')]);
  const chromeHome = join(home, 'chrome-home');
  mkdirSync(join(chromeHome, 'google-chrome'), { recursive: true });
  assert.deepEqual(browserHostDirs({ home, platform: 'linux', env: { XDG_CONFIG_HOME: xdg, CHROME_CONFIG_HOME: chromeHome } }), [
    join(chromeHome, 'google-chrome/NativeMessagingHosts'),
  ]);
});
