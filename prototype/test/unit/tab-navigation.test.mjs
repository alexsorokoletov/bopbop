import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Tab } from '../../src/cdp/tab.ts';

async function tabSession() {
  const listeners = new Map();
  const session = {
    id: 'root',
    on(method, callback) {
      if (!listeners.has(method)) listeners.set(method, new Set());
      listeners.get(method).add(callback);
      return () => listeners.get(method)?.delete(callback);
    },
    async send(method) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', url: 'https://example.com/' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 };
      return {};
    },
  };
  const tab = new Tab({}, 'target', session);
  await tab.init();
  return {
    tab,
    emit: (method, params) => {
      for (const callback of listeners.get(method) || []) callback(params);
    },
  };
}

test('only a main-frame cache restore completes the load wait before DOMContentLoaded', async () => {
  const { tab, emit } = await tabSession();
  emit('Page.frameNavigated', { frame: { id: 'child', parentId: 'main', url: 'https://example.com/child' }, type: 'BackForwardCacheRestore' });
  assert.equal(tab.historyChanges, 0);
  emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/new' }, type: 'Navigation' });
  assert.equal(tab.historyChanges, 0, 'a new document must still wait for DOMContentLoaded');
  emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/' }, type: 'BackForwardCacheRestore' });
  assert.equal(tab.historyChanges, 1);
  assert.equal(tab.loads, 0, 'a cache restore must not count as DOMContentLoaded');
});

test('only a main-frame same-document navigation completes the load wait', async () => {
  const { tab, emit } = await tabSession();
  emit('Page.navigatedWithinDocument', { frameId: 'child', url: 'https://example.com/child#next' });
  assert.equal(tab.historyChanges, 0);
  emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.com/#next' });
  assert.equal(tab.historyChanges, 1);
  assert.equal(tab.loads, 0, 'a same-document change must not count as DOMContentLoaded');
});

test('DOMContentLoaded still completes a new-document load wait', async () => {
  const { tab, emit } = await tabSession();
  emit('Page.domContentEventFired', {});
  assert.equal(tab.loads, 1);
});

test('an inline history change cannot complete a new-document navigation before DOMContentLoaded', async () => {
  const { tab, emit } = await tabSession();
  tab.root.send = async (method) => {
    assert.equal(method, 'Page.navigate');
    emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/new' }, type: 'Navigation' });
    emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.com/new#state', navigationType: 'historyApi' });
    return { loaderId: 'new-document' };
  };
  tab.settle = async () => 0;
  let completed = false;
  const navigation = tab.navigate('https://example.com/new').then(() => {
    completed = true;
  });
  await new Promise(setImmediate);
  const completedBeforeDOM = completed;
  emit('Page.domContentEventFired', {});
  await navigation;
  assert.equal(completedBeforeDOM, false, 'a new document must wait for DOMContentLoaded, not its inline history.replaceState');
  assert.equal(completed, true);
});

for (const direction of ['back', 'forward']) {
  test(`${direction} cannot complete on an inline history change after a new-document commit`, async () => {
    const { tab, emit } = await tabSession();
    tab.root.send = async (method) => {
      if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] };
      assert.equal(method, 'Page.navigateToHistoryEntry');
      emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/new', loaderId: 'new-document' }, type: 'Navigation' });
      emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.com/new#state', navigationType: 'historyApi' });
      return {};
    };
    tab.settle = async () => 0;
    let completed = false;
    const navigation = tab.navigate(direction).then(() => {
      completed = true;
    });
    await new Promise(setImmediate);
    const completedBeforeDOM = completed;
    emit('Page.domContentEventFired', {});
    await navigation;
    assert.equal(completedBeforeDOM, false, 'new-document history must not finish before DOMContentLoaded');
    assert.equal(completed, true);
  });
}

for (const direction of ['back', 'forward']) {
  test(`${direction} cannot complete on an old-document history change after different-document initiation`, async () => {
    const { tab, emit } = await tabSession();
    tab.root.send = async (method) => {
      if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] };
      assert.equal(method, 'Page.navigateToHistoryEntry');
      emit('Page.frameStartedNavigating', { frameId: 'main', navigationType: 'historyDifferentDocument' });
      emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.com/new', navigationType: 'historyApi' });
      return {};
    };
    tab.settle = async () => 0;
    let completed = false;
    const navigation = tab.navigate(direction).then(() => {
      completed = true;
    });
    await new Promise(setImmediate);
    const completedBeforeCommit = completed;
    emit('Page.frameNavigated', { frame: { id: 'main', url: 'https://example.com/new', loaderId: 'new-document' }, type: 'Navigation' });
    emit('Page.domContentEventFired', {});
    await navigation;
    assert.equal(completedBeforeCommit, false, 'old-document history must not release a different-document traversal');
    assert.equal(completed, true);
  });
}

test('same-document initiation and the missing-initiation fallback still complete without DOMContentLoaded', async () => {
  for (const direction of ['back', 'forward']) {
    for (const navigationType of ['historySameDocument', undefined]) {
      const { tab, emit } = await tabSession();
      tab.root.send = async (method) => {
        if (method === 'Page.getNavigationHistory') return { currentIndex: 1, entries: [{ id: 0 }, { id: 1 }, { id: 2 }] };
        assert.equal(method, 'Page.navigateToHistoryEntry');
        if (navigationType) emit('Page.frameStartedNavigating', { frameId: 'main', navigationType });
        emit('Page.navigatedWithinDocument', { frameId: 'main', url: 'https://example.com/#target', navigationType: 'historyApi' });
        return {};
      };
      tab.settle = async () => 0;
      await tab.navigate(direction);
      assert.equal(tab.loads, 0);
      assert.equal(tab.historyChanges, 1);
    }
  }
});
