// Zero-paste pairing: with the native host installed, a fresh extension pairs without a pasted token,
// and picks up a new token when the server's proof stops matching.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRelay } from '../../src/relay.ts';
import { extensionIdForPath, installNativeHost } from '../../src/native-host.ts';
import { EXT_DIR, launchWithExtension } from '../helpers/extension.mjs';

const PORT = 9412;
const tok = () => randomBytes(24).toString('hex');

test('a fresh profile pairs through the native host, and follows a token change', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bbm-np-'));
  const profile = join(home, 'profile');
  const tokenFile = join(home, 'relay-token');
  // Chrome looks for per-user hosts in <user data dir>/NativeMessagingHosts.
  installNativeHost({ dirs: [join(profile, 'NativeMessagingHosts')], ids: [extensionIdForPath(EXT_DIR)], tokenFile, binDir: join(home, 'bin') });

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
  installNativeHost({ dirs: [join(profile, 'NativeMessagingHosts')], ids: [extensionIdForPath(EXT_DIR)], tokenFile, binDir: join(home, 'bin') });
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
