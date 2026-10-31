// Extension mode tab UX: a session opens no empty tab of its own, and the agent can label its tab group.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../../../fixtures/server.mjs';
import { startRelay } from '../../src/relay.ts';
import { Controller } from '../../src/controller.ts';
import { launchWithExtension } from '../helpers/extension.mjs';

const PORT = 9382;
let srv, chromium, browser, c, swEval;
const relayLogs = [];
before(async () => {
  srv = await startServer({ port: 0 });
  const token = randomBytes(16).toString('hex');
  const relay = startRelay({ port: PORT, token, timeoutMs: 30000, log: (message) => relayLogs.push(message) });
  chromium = await launchWithExtension({ token, port: PORT });
  browser = await relay;
  const { targetInfos } = await chromium.conn.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker');
  const { sessionId } = await chromium.conn.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  swEval = async (expr) =>
    (await chromium.conn.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)).result?.value;
  c = new Controller(browser, { front: false, project: '/work/connected-things' });
  await c.init();
});
after(async () => {
  await browser?.close().catch(() => {});
  await chromium?.close();
  await srv?.close();
});

const groups = () => swEval('chrome.tabGroups.query({}).then((gs) => gs.map((g) => g.title))');
const groupedUrls = () => swEval('chrome.tabs.query({}).then((ts) => ts.filter((t) => t.groupId !== -1).map((t) => t.pendingUrl || t.url))');

test('the relay reports the build of the running extension', async () => {
  const build = await swEval('chrome.runtime.getManifest().version_name');
  assert.match(build, /\(\d{4}-.*Z; [a-f0-9]{12}\)/);
  assert.ok(relayLogs.includes(`[bbm] extension build: ${JSON.stringify(build)}`));
});

test('init opens no tab', async () => {
  assert.equal(c.tabs.size, 0);
  assert.deepEqual(await groupedUrls(), []);
});

test('tools that need a tab say so when none is open', async () => {
  await assert.rejects(c.snapshot({}), /no tab open/);
});

test('labeling before any group exists describes the future name', async () => {
  assert.equal(await c.setLabel('NEXT'), 'new tab groups will be named Agent:NEXT');
  assert.deepEqual(await groups(), []);
  await c.setLabel('');
  await c.init(); // Restore the initial naming notice for the following test.
});

test('navigate with no tab opens exactly one tab, at the URL', async () => {
  assert.match(await c.navigate(`${srv.base}/login-form/`), /Sign in/);
  assert.equal(c.tabs.size, 1);
  const urls = await groupedUrls();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /login-form/);
});

test('the group is named after the project and slot, and the agent is asked once to name it', async () => {
  // port 9382 is outside 9333-9362: its last two digits give the number
  assert.deepEqual(await groups(), ['Agent:CT82']);
  assert.match(c.takeNotice(), /^your tab group is Agent:CT82; name it for your task: tabs action=label/);
  assert.equal(c.takeNotice(), '');
});

test('label renames the agent group: letters, digits or emoji, 1-5 of them', async () => {
  assert.equal(await c.setLabel('ALD'), 'tab group: Agent:ALD');
  assert.deepEqual(await groups(), ['Agent:ALD']);
  await c.setLabel('🧪🔥');
  assert.deepEqual(await groups(), ['Agent:🧪🔥']);
  await assert.rejects(c.setLabel('two words'), /1-5 letters, digits or emoji/);
  await assert.rejects(c.setLabel('TOOLONG'), /1-5 letters, digits or emoji/);
  assert.deepEqual(await groups(), ['Agent:🧪🔥']);
});

test('an empty label restores the default title', async () => {
  await c.setLabel('');
  assert.deepEqual(await groups(), ['Agent:CT82']);
});

const colors = () => swEval('chrome.tabGroups.query({}).then((gs) => gs.map((g) => g.title + "/" + g.color))');

test('color sets the tab group color; a color alone keeps the label', async () => {
  assert.equal(await c.setLabel('GW44', 'green'), 'tab group: Agent:GW44 (green)');
  assert.deepEqual(await colors(), ['Agent:GW44/green']);
  await c.setLabel(undefined, 'orange');
  assert.deepEqual(await colors(), ['Agent:GW44/orange']);
  await c.setLabel('ALD');
  assert.deepEqual(await colors(), ['Agent:ALD/orange']); // a label alone keeps the color
  await assert.rejects(c.setLabel(undefined, 'teal'), /color must be one of/);
  assert.deepEqual(await colors(), ['Agent:ALD/orange']);
});

test('after a service-worker restart, a new tab joins our colored group', async () => {
  await swEval('bbmForget()');
  await c.newTab(`${srv.base}/login-form/?color=1`);
  assert.deepEqual(await colors(), ['Agent:ALD/orange']);
  await c.setLabel('', 'purple');
  assert.deepEqual(await colors(), ['Agent:CT82/purple']);
});

test('after a service-worker restart, a new tab joins the group with our title instead of a second one', async () => {
  await swEval('bbmForget()');
  await c.newTab(`${srv.base}/login-form/?again=1`);
  assert.deepEqual(await groups(), ['Agent:CT82']);
});

test('duplicate copies sessionStorage, joins the agent group, and leaves the user tab active', async () => {
  const userTab = await swEval(`chrome.tabs.create({ url: ${JSON.stringify(srv.base + '/login-form/')}, active: true }).then((t) => t.id)`);
  await c.navigate(`${srv.base}/agent-ux/?s=1#signin`);
  await c.navigate(`${srv.base}/agent-ux/`);
  const dup = await c.duplicateTab();
  assert.equal(await c.evaluate({ expression: 'document.getElementById("auth").textContent' }), 'signed in');
  const dupId = +c.tabs.get(dup).targetId;
  assert.notEqual(await swEval(`chrome.tabs.get(${dupId}).then((t) => t.groupId)`), -1);
  assert.equal(await swEval('chrome.tabs.query({ active: true, lastFocusedWindow: true }).then((t) => t[0]?.id)'), userTab);
});

test('a Chrome rename failure is reported instead of claiming the group was renamed', async () => {
  const previous = c.label;
  await swEval('chrome.tabs.query({}).then((ts) => chrome.tabs.ungroup(ts.filter((t) => t.groupId !== -1).map((t) => t.id)))');
  await assert.rejects(c.setLabel('FAIL'), /group/i);
  assert.equal(c.label, previous);
  assert.deepEqual(await groups(), []);
});
