// The extension retries a relay port with no server less and less often (1 s, 2 s, 4 s … up to a cap), so
// chrome://extensions does not fill with ERR_CONNECTION_REFUSED; a server that starts later still pairs within the cap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startRelay } from '../../src/relay.ts';
import { launchWithExtension } from '../helpers/extension.mjs';

const BASE = 9420;
const CAP = 4000; // shortened by the test hook (default 10 s)
const token = randomBytes(16).toString('hex');
let chromium, swEval;

before(async () => {
  chromium = await launchWithExtension({ token, port: BASE });
  const { targetInfos } = await chromium.conn.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker');
  const { sessionId } = await chromium.conn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  swEval = async (expr) =>
    (await chromium.conn.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  await swEval(`bbmBackoff.max = ${CAP}`);
});
after(() => chromium?.close());

const attempts = async (slot) => swEval(`bbmAttempts()[${slot}]`);
const gaps = (ts) => ts.slice(1).map((t, i) => t - ts[i]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a port with no server is tried less and less often', async () => {
  const t0 = Date.now();
  await sleep(13000);
  const ts = (await attempts(1)).filter((t) => t >= t0);
  const g = gaps(ts);
  // Without backoff: one try per second (~13). With 1, 2, 4, 4 s waits: about 5.
  assert.ok(ts.length >= 3 && ts.length <= 6, `attempts in 13 s: ${ts.length} (${g})`);
  assert.ok(g.at(-1) >= CAP - 1000, `the last wait reaches the cap: ${g}`);
  for (let i = 1; i < g.length; i++) assert.ok(g[i] >= g[i - 1] - 300, `waits do not shrink: ${g}`);
});

test('a server that starts later pairs within the cap; after it goes away, the next try comes soon', async () => {
  const t0 = Date.now();
  const browser = await startRelay({ port: BASE, token, timeoutMs: CAP * 3, log: () => {} });
  const paired = Date.now() - t0;
  // cap + one 1 s connect tick + Chrome's own throttling of repeated connects to one host (varies with load; a busy
  // CI runner went past 2× cap). Without the cap the next try would come only ~30 s after the first.
  assert.ok(paired <= CAP * 3, `paired after ${paired} ms`);
  await browser.close();
  const closed = Date.now();
  await sleep(3000);
  const next = (await attempts(0)).filter((t) => t > closed);
  assert.ok(next.length >= 1 && next[0] - closed <= 2500, `first retry after the server left: ${next.map((t) => t - closed)}`);
});
