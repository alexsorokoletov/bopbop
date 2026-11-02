// Stale agent groups (left behind by a Chrome restart, a service worker restart or BBM_KEEP_TABS) are closed
// after the idle period set on the options page (default 7 days). Live sessions and the user's groups are never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../../../fixtures/server.mjs';
import { startRelay } from '../../src/relay.ts';
import { Controller } from '../../src/controller.ts';
import { launchWithExtension } from '../helpers/extension.mjs';

const PORT = 9392;
const DAY = 864e5;
let srv, chromium, browser, c, swEval;
before(async () => {
  srv = await startServer({ port: 0 });
  const token = randomBytes(16).toString('hex');
  const relay = startRelay({ port: PORT, token, timeoutMs: 30000, log: () => {} });
  chromium = await launchWithExtension({ token, port: PORT });
  browser = await relay;
  const { targetInfos } = await chromium.conn.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker');
  const { sessionId } = await chromium.conn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  swEval = async (expr) =>
    (await chromium.conn.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  c = new Controller(browser, { front: false });
  await c.init();
  await c.navigate(`${srv.base}/login-form/`); // the live session's own "Agent" group
});
after(async () => {
  await browser?.close().catch(() => {});
  await chromium?.close();
  await srv?.close();
});

// A group that no session owns, as Chrome restores it after a restart.
const makeGroup = (title, color) =>
  swEval(`(async () => {
  const t = await chrome.tabs.create({ url: ${JSON.stringify(srv.base + '/login-form/')}, active: false });
  const g = await chrome.tabs.group({ tabIds: [t.id] });
  await chrome.tabGroups.update(g, { title: ${JSON.stringify(title)}, color: ${JSON.stringify(color)} });
  return g;
})()`);
const titles = () => swEval('chrome.tabGroups.query({}).then((gs) => gs.map((g) => g.title).sort())');
const cleanup = (inDays) => swEval(`bbmCleanup({ now: Date.now() + ${inDays * DAY} })`);

test('a recently used orphan agent group stays', async () => {
  await makeGroup('Agent:old', 'purple');
  assert.equal(await cleanup(0), 0);
  assert.ok((await titles()).includes('Agent:old'));
});

test('cleanup off (0 days): nothing is closed', async () => {
  await swEval('chrome.storage.local.set({ cleanupDays: 0 })');
  assert.equal(await cleanup(30), 0);
  assert.ok((await titles()).includes('Agent:old'));
  await swEval('chrome.storage.local.remove("cleanupDays")');
});

test('after 7 idle days the orphan group and its tabs are closed; live and user groups stay', async () => {
  await makeGroup('Agent 3', 'purple');
  await makeGroup('Work', 'purple'); // the user's group: other title
  await makeGroup('Agent', 'blue'); // the user's group: other color
  assert.equal(await cleanup(8), 2);
  const left = await titles();
  assert.equal(left.length, 3, String(left)); // live session's group + the user's two
  assert.ok(left.includes('Agent') && left.includes('Work') && left.some((t) => /^Agent:[A-Z]+\d+$/.test(t)), String(left));
  assert.match(await c.navigate(`${srv.base}/long-form/`), /Create account/);
});

test('the idle period is a setting', async () => {
  await makeGroup('Agent:ALD', 'purple');
  await swEval('chrome.storage.local.set({ cleanupDays: 2 })');
  assert.equal(await cleanup(1), 0);
  assert.equal(await cleanup(3), 1);
  await swEval('chrome.storage.local.remove("cleanupDays")');
});

test("an orphan group the agent colored is cleaned up; the user's groups with that color stay", async () => {
  await c.setLabel('GRN', 'green');
  // The session's group as Chrome keeps it after a service-worker restart: no live session owns it any more.
  await swEval('bbmForget()');
  await makeGroup('Agent:GRN2', 'green'); // never colored by an agent: the user's
  await makeGroup('Groceries', 'green');
  assert.equal(await cleanup(8), 1);
  const left = await titles();
  assert.ok(!left.includes('Agent:GRN') && left.includes('Agent:GRN2') && left.includes('Groceries'), String(left));
});

test('a colored pair is remembered while any group still uses it, and forgotten when none does', async () => {
  const keys = () => swEval('chrome.storage.local.get(null).then((o) => Object.keys(o).filter((k) => k.startsWith("colored:")).sort())');
  // Two sessions color their groups at the same moment: both pairs are kept.
  await swEval('Promise.all([bbmRemember("Agent:AA", "red"), bbmRemember("Agent:BB", "cyan")])');
  assert.deepEqual(await keys(), ['colored:Agent:AA|red', 'colored:Agent:BB|cyan']);
  await makeGroup('Agent:AA', 'red');
  await cleanup(0); // nothing stale: Agent:AA keeps its pair, Agent:BB has no group any more
  assert.deepEqual(await keys(), ['colored:Agent:AA|red']);
});
