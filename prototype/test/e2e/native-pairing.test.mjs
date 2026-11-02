// Zero-paste pairing: with the native host installed, a fresh extension pairs without a pasted token,
// and picks up a new token when the server's proof stops matching.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '../../src/relay.ts';
import { extensionIdForPath, installNativeHost } from '../../src/native-host.ts';
import { EXT_DIR, launchWithExtension } from '../helpers/extension.mjs';

const PORT = 9412;
// Chrome looks for per-user hosts in <user data dir>/NativeMessagingHosts; on Windows only in the registry
// (the test Chromium reads the Chromium key).
const REG_KEY = 'HKCU\\Software\\Chromium\\NativeMessagingHosts\\dev.bopbop.host';
const where = (profile) => (process.platform === 'win32' ? { dirs: [], regKeys: [REG_KEY] } : { dirs: [join(profile, 'NativeMessagingHosts')], regKeys: [] });

// Windows: put back the user's own registration (or none) when the tests end.
if (process.platform === 'win32') {
  const reg = (...args) => execFileSync('reg', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let saved = null;
  try {
    saved =
      reg('query', REG_KEY, '/ve')
        .match(/REG_SZ\s+(.+)/)?.[1]
        .trim() ?? null;
  } catch {
    /* none */
  }
  after(() => {
    if (saved) reg('add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', saved, '/f');
    else reg('delete', REG_KEY, '/f');
  });
}
const tok = () => randomBytes(24).toString('hex');

test('a fresh profile pairs through the native host, and follows a token change', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bbm-np-'));
  const profile = join(home, 'profile');
  const tokenFile = join(home, 'relay-token');
  installNativeHost({ ...where(profile), ids: [extensionIdForPath(EXT_DIR)], tokenFile, binDir: join(home, 'bin') });

  const first = tok();
  writeFileSync(tokenFile, first);
  const relay = startRelay({ port: PORT, token: first, timeoutMs: 30000, log: () => {} });
  const chromium = await launchWithExtension({ token: null, port: PORT, userDataDir: profile });
  try {
    assert.equal(chromium.extensionId, extensionIdForPath(EXT_DIR), 'the computed unpacked ID is the one Chrome uses');
    const b = await relay;
    await b.close();

    // The server's token changes (file deleted and made again): the stored token no longer proves it.
    const second = tok();
    writeFileSync(tokenFile, second);
    const b2 = await startRelay({ port: PORT + 1, token: second, timeoutMs: 30000, log: () => {} });
    await b2.close();
  } finally {
    await chromium.close();
  }
});

test('a token pasted by hand is never replaced by the native host', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bbm-np-'));
  const profile = join(home, 'profile');
  const tokenFile = join(home, 'relay-token');
  installNativeHost({ ...where(profile), ids: [extensionIdForPath(EXT_DIR)], tokenFile, binDir: join(home, 'bin') });
  const fileToken = tok();
  writeFileSync(tokenFile, fileToken);
  const chromium = await launchWithExtension({ token: null, port: PORT + 5, userDataDir: profile });
  try {
    const stored = () => chromium.swEval('chrome.storage.local.get(["token", "tokenSource"])');
    while ((await stored()).token !== fileToken) await new Promise((r) => setTimeout(r, 100)); // paired by the host at start
    // The user pastes another token (as the options page saves it); asks are no longer rate-limited.
    const pasted = tok();
    await chromium.swEval(`bbmBackoff.nativeAsk = 0; chrome.storage.local.set({ token: ${JSON.stringify(pasted)}, tokenSource: 'manual' })`);
    // A server with the file's token: its proof does not match the pasted token, and the host offers the file's.
    await assert.rejects(startRelay({ port: PORT + 5, token: fileToken, timeoutMs: 8000, log: () => {} }), /did not connect\/pair/);
    assert.deepEqual(await stored(), { token: pasted, tokenSource: 'manual' });
    // A token pasted before native pairing existed has no tokenSource: it is the user's too.
    await chromium.swEval('chrome.storage.local.remove("tokenSource")');
    await assert.rejects(startRelay({ port: PORT + 5, token: fileToken, timeoutMs: 8000, log: () => {} }), /did not connect\/pair/);
    assert.deepEqual(await stored(), { token: pasted });
  } finally {
    await chromium.close();
  }
});
