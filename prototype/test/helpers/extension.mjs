// Launch Chromium with the relay extension loaded and write the pairing token into its storage.
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchChromium } from '../../src/cdp/browser.ts';

// Tests load the extension built from extension/src, into a folder of this test process (test files run in parallel).
export const EXT_DIR = mkdtempSync(join(tmpdir(), 'bbm-ext-'));
execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/build-extension.ts', import.meta.url)), '--out', EXT_DIR], { stdio: 'inherit' });

export const FAKE_PM_DIR = fileURLToPath(new URL('./fake-pm', import.meta.url));

// token: null = paste no token (the extension pairs through the native host); userDataDir: a profile to keep.
export async function launchWithExtension({ token, port = 9333, headless = process.env.BBM_HEADLESS !== '0', extra = [], userDataDir } = {}) {
  const dirs = [EXT_DIR, ...extra].join(',');
  const chromium = await launchChromium({ headless, userDataDir, args: [`--load-extension=${dirs}`, `--disable-extensions-except=${dirs}`] });
  const t0 = Date.now();
  let sw;
  while (!sw && Date.now() - t0 < 10000) {
    const { targetInfos } = await chromium.conn.send('Target.getTargets');
    sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
    if (!sw) await new Promise((r) => setTimeout(r, 100));
  }
  if (!sw) throw new Error('extension service worker not found');
  const { sessionId } = await chromium.conn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  // Extension APIs bind shortly after the worker starts: retry until a read-back confirms the token.
  for (let i = 0; ; i++) {
    const r = await chromium.conn.send(
      'Runtime.evaluate',
      {
        expression: `chrome.storage.local.set(${JSON.stringify(token == null ? { port } : { token, port, tokenSource: 'manual' })}).then(() => chrome.storage.local.get('port')).then((v) => v.port)`,
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    if (r.result?.value === port) break;
    if (i > 400) throw new Error('could not write the pairing token: ' + JSON.stringify(r.exceptionDetails?.exception?.description || r.result));
    await new Promise((res) => setTimeout(res, 50));
  }
  chromium.extensionId = new URL(sw.url).host;
  chromium.swEval = async (expression) =>
    (await chromium.conn.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  return chromium;
}
