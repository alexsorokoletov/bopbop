// 30 parallel sessions. Servers take the first free port, so the extension tries only the slots up to 2 past the
// highest live one, not 30 ports every few seconds. A sweep (every 5 min) tries the other slots one per tick.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { listenRelayAuto, SLOTS } from '../../src/relay.ts';
import { launchWithExtension } from '../helpers/extension.mjs';

const BASE = 9470;
let chromium, swEval, token;
const relays = [];
before(async () => {
  token = randomBytes(16).toString('hex');
  chromium = await launchWithExtension({ token: 'not-yet-' + token, port: BASE });
  const { targetInfos } = await chromium.conn.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker');
  const { sessionId } = await chromium.conn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  swEval = async (expr) =>
    (await chromium.conn.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  await swEval('Object.assign(bbmBackoff, { min: 200, max: 400 })');
});
after(async () => {
  for (const r of relays) await r.close();
  await chromium?.close();
});

test('the server and the extension agree on 30 slots', () => {
  assert.equal(SLOTS, 30);
});

test('3 servers pair on the first 3 slots; the extension tries only up to 2 slots past them', async () => {
  for (let i = 0; i < 3; i++) relays.push(await listenRelayAuto({ basePort: BASE, token, log: () => {} }));
  assert.deepEqual(
    relays.map((r) => r.port),
    [BASE, BASE + 1, BASE + 2],
  );
  await swEval(
    `chrome.storage.session.set({ lastSweep: Date.now() }).then(() => bbmSweep(false)).then(() => chrome.storage.local.set({ token: ${JSON.stringify(token)}, port: ${BASE} }))`,
  );
  await Promise.all(relays.map((r) => r.browser({ timeoutMs: 15000 })));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 3000));
  const attempts = await swEval('bbmAttempts()');
  const since = attempts.map((times) => times.filter((t) => t >= t0).length);
  assert.ok(since[3] >= 1 && since[4] >= 1, `slots 3 and 4 are retried: ${since}`);
  for (let i = 5; i < SLOTS; i++) assert.equal(since[i], 0, `slot ${i} is outside the window: ${since}`);
});

test('a 4th server on the next slot pairs quickly, and the window moves up with it', async () => {
  const t0 = Date.now();
  const r = await listenRelayAuto({ basePort: BASE, token, log: () => {} });
  relays.push(r);
  assert.equal(r.port, BASE + 3);
  await r.browser({ timeoutMs: 5000 });
  assert.ok(Date.now() - t0 < 5000);
  const t1 = Date.now();
  await new Promise((res) => setTimeout(res, 2500));
  const since = (await swEval('bbmAttempts()')).map((times) => times.filter((t) => t >= t1).length);
  assert.ok(since[5] >= 1, `slot 5 is now in the window: ${since}`);
  for (let i = 6; i < SLOTS; i++) assert.equal(since[i], 0, `slot ${i}: ${since}`);
});

test('a sweep tries the slots outside the window one per tick, never as a burst', async () => {
  await swEval('bbmSweep(true)');
  const t0 = Date.now();
  await new Promise((res) => setTimeout(res, 6500));
  const outside = (await swEval('bbmAttempts()')).flatMap((times, slot) => (slot > 5 ? times.filter((t) => t >= t0) : [])).sort((a, b) => a - b);
  assert.ok(outside.length >= 4 && outside.length <= 8, `about one per second: ${outside.map((t) => t - t0)}`);
  for (let i = 1; i < outside.length; i++) assert.ok(outside[i] - outside[i - 1] >= 500, `no burst: ${outside.map((t) => t - t0)}`);
});

test('when every slot is taken, the error names the range', async () => {
  const blockers = await Promise.all(
    [9520, 9521].map(
      (port) =>
        new Promise((res) => {
          const s = createServer().listen(port, '127.0.0.1', () => res(s));
        }),
    ),
  );
  try {
    await assert.rejects(listenRelayAuto({ basePort: 9520, slots: 2, token, log: () => {} }), /all 2 bopbop slots are taken \(ports 9520-9521\)/);
  } finally {
    for (const s of blockers) s.close();
  }
});
