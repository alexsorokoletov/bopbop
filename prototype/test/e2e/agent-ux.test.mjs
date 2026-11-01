// Agent feedback round: eval awaits Promises, quiet outputs, scroll-until reaches an app's <main>, locators
// (css=, scoped chains, ambiguity warning), screenshot area/scale, console dedupe, tab duplicate.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../../../fixtures/server.mjs';
import { launchChromium } from '../../src/cdp/browser.ts';
import { Controller } from '../../src/controller.ts';

let srv, browser, c, page;
before(async () => {
  srv = await startServer({ port: 0 });
  browser = await launchChromium({});
  c = new Controller(browser);
  await c.init();
  page = `${srv.base}/agent-ux/`;
});
after(async () => {
  await browser?.close();
  await srv?.close();
});

const js = (expression) => c.evaluate({ expression });

test('eval awaits a returned Promise', async () => {
  await c.navigate(page);
  assert.equal(await js('fetch(location.href).then((r) => r.status)'), '200');
  assert.match(await js('(async () => ({ s: (await fetch(location.href)).status }))()'), /"s": 200/);
  assert.equal(await js('async function h() { return 6 } h()'), '6');
  assert.match(await js('new Promise((r) => setTimeout(() => r({ ok: 1 }), 200))'), /"ok": 1/);
});

test('eval shows values JSON cannot carry', async () => {
  assert.match(await js('fetch(location.href)'), /^\[Response 200 .*r\.json\(\)/);
  assert.match(await js('async () => (await fetch(location.href)).headers'), /"content-type": "text\/html/);
  assert.match(await js('document.getElementById("card")'), /^<div id="card">Table card<\/div>$/);
});

test('eval times out on a Promise that never settles', async () => {
  await assert.rejects(c.evaluate({ expression: 'new Promise(() => {})', timeout: 300 }), /timed out after 300ms/);
});

test('eval: a page change is one line by default, the diff on request', async () => {
  await c.navigate(page);
  const quiet = await js('document.getElementById("status").textContent = "changed A"');
  assert.equal(quiet, 'changed A\n(page changed; snapshot shows it)');
  assert.equal(await js('document.title'), 'Agent UX'); // a read changes nothing: no extra line
  const loud = await c.evaluate({ expression: 'document.getElementById("status").textContent = "changed B"', snapshot: 'diff' });
  assert.match(loud, /diff \(\+1 -1\)/);
});

test('navigate snapshot=none gives one line; interactive leaves out text', async () => {
  const none = await c.navigate(page, undefined, { snapshot: 'none' });
  assert.equal(none.split('\n').length, 1);
  assert.match(none, /agent-ux\/ "Agent UX"/);
  const inter = await c.navigate(page, undefined, { snapshot: 'interactive' });
  assert.match(inter, /checkbox/);
  assert.doesNotMatch(inter, /Table card/);
});

test('scroll until brings the text into view inside the app <main>', async () => {
  await c.navigate(page);
  const r = await c.act([{ scroll: 'page', until: 'Deep target' }], { snapshot: 'none' });
  assert.ok(r.ok, r.text);
  assert.equal(
    await js('(() => { const b = document.getElementById("deep").getBoundingClientRect(); return b.top >= 60 && b.bottom <= innerHeight; })()'),
    'true',
  );
});

test('plain page scroll moves <main> when the page itself barely scrolls', async () => {
  await c.navigate(page);
  const r = await c.act([{ scroll: 'page' }], { snapshot: 'none' });
  assert.ok(r.ok, r.text);
  assert.ok(+(await js('document.querySelector("main").scrollTop')) > 100);
});

test('a scoped locator clicks inside its container only', async () => {
  await c.navigate(page);
  const r = await c.act([{ click: 'css=#tiles >> text=ALD' }], { snapshot: 'none' });
  assert.ok(r.ok, r.text);
  assert.doesNotMatch(r.text, /matched/);
  assert.equal(await js('document.getElementById("status").textContent'), 'picked ALD');
  assert.equal(await js('document.getElementById("series-ald").checked'), 'false');
});

test('an ambiguous text= locator warns and names what it used', async () => {
  await c.navigate(page);
  const r = await c.act([{ hover: 'text=ALD' }], { snapshot: 'none' });
  assert.match(r.text, /⚠ text=ALD matched 2 elements, used .* \[e\d+\]; narrow it: "css=… >> text=ALD"/);
});

test('locators work in ref options of other tools', async () => {
  await c.navigate(page);
  assert.equal(await c.text({ ref: 'css=#card' }), 'Table card');
  assert.equal(await c.evaluate({ expression: '(el) => el.id', ref: 'css=#card' }), 'card');
  await assert.rejects(c.text({ ref: 'css=#nope' }), /no visible element for css=#nope/);
});

test('screenshot of an element, with padding, and of a clip; area in CSS px', async () => {
  await c.navigate(page);
  const el = await c.screenshot({ ref: 'css=#card' });
  assert.deepEqual([el.width, el.height], [300, 150]);
  const pad = await c.screenshot({ ref: 'css=#card', padding: 5 });
  assert.deepEqual([pad.width, pad.height], [310, 160]);
  assert.equal(pad.area.x, el.area.x - 5);
  const clip = await c.screenshot({ clip: { x: 0, y: 0, width: 200, height: 60 } });
  assert.deepEqual([clip.width, clip.height, clip.area.x, clip.area.y], [200, 60, 0, 0]);
});

test('screenshot scale=full keeps a wide viewport 1:1; fit stays at 1280', async () => {
  await c.emulate({ width: 1600, height: 900 });
  try {
    const fit = await c.screenshot({});
    const full = await c.screenshot({ scale: 'full' });
    // the viewport is 1600 px minus the scrollbar
    assert.equal(full.width, full.viewport.w);
    assert.ok(full.width > 1500);
    assert.equal(full.scale, 1);
    assert.equal(fit.width, 1280);
    assert.equal(fit.scale, 1280 / full.viewport.w);
  } finally {
    await c.emulate({ reset: true });
  }
});

test('console collapses identical messages with a count', async () => {
  await c.console({ clear: true });
  await c.navigate(page);
  const out = await c.console({});
  assert.equal(out.match(/HMR socket failed/g).length, 1);
  assert.match(out, /HMR socket failed .*×5$/m);
  assert.match(out, /\[warn\] once/);
});

test('duplicate copies sessionStorage; a new tab does not', async () => {
  await c.navigate(`${page}?s=1#signin`); // a real load (a hash-only change does not run the page script)
  await c.navigate(page);
  assert.equal(await js('document.getElementById("auth").textContent'), 'signed in');
  const dup = await c.duplicateTab();
  assert.equal(c.current, dup);
  assert.equal(await js('document.getElementById("auth").textContent'), 'signed in');
  assert.match(await c.tabLine(dup), /^\[t\d+\] .*agent-ux\/ "Agent UX"$/);
  await c.newTab(page);
  assert.equal(await js('document.getElementById("auth").textContent'), 'signed out');
});

test('locator alternatives: "a, b" uses the first that matches, and says so', async () => {
  await c.navigate(page);
  const r = await c.act([{ click: 'css=#nope, css=#tiles >> text=BRK' }], { snapshot: 'none' });
  assert.ok(r.ok, r.text);
  assert.match(r.text, /used alternative 2 of 2: css=#tiles >> text=BRK/);
  assert.equal(await js('document.getElementById("status").textContent'), 'picked BRK');
  assert.equal(await c.text({ ref: 'text=Nothing here, text=Table card' }), 'Table card');
  assert.equal(await c.text({ ref: 'e9999, css=#card' }), 'Table card'); // an unknown ref falls through
});

test('locator alternatives: commas inside a CSS list or a text stay as they are', async () => {
  await c.navigate(page);
  assert.equal(await c.text({ ref: 'css=#nope, #card' }), 'Table card'); // one CSS selector list
  await assert.rejects(c.text({ ref: 'text=Deep, target' }), /no visible element for text=Deep, target/); // one text
});

test('locator alternatives: when none matches, the error lists them', async () => {
  await c.navigate(page);
  await assert.rejects(c.text({ ref: 'css=#a1, text=Missing' }), /no visible element for any of: css=#a1 \| text=Missing/);
});

test('a link that wraps a block (a card title: <a><h2>…</h2></a>) is clickable below the fold', async () => {
  await c.navigate(page);
  await js(`document.body.innerHTML = '<div style="height:2000px"></div><a id="title-link" href="#title-hit"><h2>Card title</h2></a>'`);
  const r = await c.act([{ click: 'css=#title-link' }], { snapshot: 'none' });
  assert.ok(r.ok, r.text);
  assert.equal(await js('location.hash'), '#title-hit');
});
