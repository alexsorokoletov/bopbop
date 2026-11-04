import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../../../fixtures/server.mjs';
import { launchChromium } from '../../src/cdp/browser.ts';
import { Controller } from '../../src/controller.ts';
import { startRelay } from '../../src/relay.ts';
import { launchWithExtension } from '../helpers/extension.mjs';

let srv, browser, chromium, c;
before(async () => {
  srv = await startServer({ port: 0 });
  if (process.env.BBM_TEST_MODE === 'extension') {
    const token = randomBytes(16).toString('hex');
    const port = +(process.env.BBM_RELAY_PORT || 9389);
    const relay = startRelay({ port, token, timeoutMs: 30000, log: () => {} });
    chromium = await launchWithExtension({ token, port });
    browser = await relay;
  } else {
    browser = await launchChromium({});
  }
  c = new Controller(browser);
  await c.init();
});
after(async () => {
  await browser?.close();
  await chromium?.close();
  await srv?.close();
});

test('back and forward finish on a back-forward-cache restore without DOMContentLoaded', async (t) => {
  await c.navigate(`${srv.base}/history/`);
  const clicked = await c.act([{ click: 'text=Second page' }], { snapshot: 'none' });
  assert.ok(clicked.ok, clicked.text);
  const tab = await c.tab();
  assert.equal(await tab.evaluate('document.title'), 'History second');
  let domLoads = 0;
  const off = tab.root.on('Page.domContentEventFired', () => domLoads++);
  try {
    for (const [direction, title] of [
      ['back', 'History first'],
      ['forward', 'History second'],
    ]) {
      const start = Date.now();
      const result = await c.navigate(direction, undefined, { snapshot: 'none' });
      const ms = Date.now() - start;
      t.diagnostic(`${direction}: ${ms}ms`);
      assert.match(result, new RegExp(title));
      assert.equal(await tab.evaluate('window.restored'), 'true', 'pageshow.persisted confirms a cache restore');
      assert.equal(domLoads, 0, 'cache restores do not fire DOMContentLoaded');
      assert.ok(ms < 5000, `${direction} waited ${ms}ms for a load event that cannot fire`);
    }
  } finally {
    off();
  }
});

test('back and forward finish for same-document history entries without DOMContentLoaded', async (t) => {
  await c.navigate(`${srv.base}/history/`);
  const tab = await c.tab();
  await tab.evaluate('history.pushState({}, "", "#second")');
  let domLoads = 0;
  const off = tab.root.on('Page.domContentEventFired', () => domLoads++);
  try {
    for (const [direction, hash] of [
      ['back', ''],
      ['forward', '#second'],
    ]) {
      const start = Date.now();
      const result = await c.navigate(direction, undefined, { snapshot: 'none' });
      const ms = Date.now() - start;
      t.diagnostic(`${direction}: ${ms}ms`);
      assert.match(result, /History first/);
      assert.equal(await tab.evaluate('location.hash'), hash);
      assert.equal(domLoads, 0);
      assert.ok(ms < 5000, `${direction} waited ${ms}ms for a load event that cannot fire`);
    }
  } finally {
    off();
  }
});

test('back and forward still wait for a new document when history cannot use the cache', async () => {
  await c.navigate(`${srv.base}/login-form/`);
  await c.navigate(`${srv.base}/long-form/`);
  const tab = await c.tab();
  let domLoads = 0;
  const off = tab.root.on('Page.domContentEventFired', () => domLoads++);
  try {
    assert.match(await c.navigate('back', undefined, { snapshot: 'none' }), /Sign in - Acme Portal/);
    assert.match(await c.navigate('forward', undefined, { snapshot: 'none' }), /Create account - Acme Portal/);
    assert.equal(domLoads, 2);
  } finally {
    off();
  }
});

for (const direction of ['back', 'forward']) {
  test(`${direction} waits for DOMContentLoaded when the new document changes history before a blocking script`, async (t) => {
    if (direction === 'forward') await c.navigate(`${srv.base}/login-form/`);
    await c.navigate(`${srv.base}/history-loading/`);
    if (direction === 'forward') await c.navigate('back', undefined, { snapshot: 'none' });
    else await c.navigate(`${srv.base}/login-form/`);
    const tab = await c.tab();
    const loads = tab.loads;
    const start = Date.now();
    const result = await c.navigate(direction, undefined, { snapshot: 'none' });
    t.diagnostic(`${direction} blocking script: ${Date.now() - start}ms`);
    assert.match(result, /History loading/);
    assert.equal(await tab.evaluate('window.__domReady'), 'true', 'the inline history change must not release the document load wait');
    assert.equal(await tab.evaluate('window.__late'), 'true', 'the parser-blocking script must finish before navigation returns');
    assert.equal(tab.loads, loads + 1, 'history must wait for DOMContentLoaded on a new-document load');
  });
}

for (const direction of ['back', 'forward']) {
  test(`${direction} ignores old-document beforeunload history changes while the new target is pending`, async (t) => {
    if (direction === 'forward') await c.navigate(`${srv.base}/history-unload/`);
    await c.navigate(`${srv.base}/api/history-target`);
    if (direction === 'back') await c.navigate(`${srv.base}/history-unload/`);
    else await c.navigate('back', undefined, { snapshot: 'none' });
    const tab = await c.tab();
    await tab.evaluate('window.__armed = true');
    const loads = tab.loads;
    let mutations = 0;
    const off = tab.root.on('Page.navigatedWithinDocument', () => mutations++);
    try {
      const start = Date.now();
      const result = await c.navigate(direction, undefined, { snapshot: 'none' });
      const ms = Date.now() - start;
      t.diagnostic(`${direction} beforeunload: ${ms}ms`);
      assert.match(result, /History target/);
      assert.ok(mutations > 0, 'the old document must change history during the traversal');
      assert.equal(await tab.evaluate('window.__domReady'), 'true');
      assert.equal(tab.loads, loads + 1, 'the target must reach DOMContentLoaded before navigation returns');
      assert.ok(ms < 10000, `${direction} took ${ms}ms for a five-second target load`);
    } finally {
      off();
    }
  });
}
