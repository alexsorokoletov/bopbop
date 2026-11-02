// Tab group names: "Agent:<code>", the code 1-5 letters, digits or emoji. Default: project initials + slot number.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkColor, checkLabel, defaultLabel } from '../../src/label.ts';

test('a label is 1-5 letters, digits or emoji; an emoji counts as one', () => {
  for (const ok of ['CT', 'CT2', 'ALD1', 'BBM30', '🧪', '🦊🔥', '👩‍💻', '🇺🇸', 'Ü2', 'a']) assert.equal(checkLabel(ok), ok, ok);
  assert.equal(checkLabel('  CT2 '), 'CT2');
  for (const bad of ['', 'TOOLONG', 'two w', 'a-b', 'x_y', '🦊🦊🦊🦊🦊🦊', '<b>']) assert.throws(() => checkLabel(bad), /1-5 letters, digits or emoji/, bad);
});

test('the default is the project initials and the slot number', () => {
  assert.equal(defaultLabel('/Users/a/work/connected-things', 1), 'CT2');
  assert.equal(defaultLabel('/x/better-browser-mcp', 0), 'BBM1');
  assert.equal(defaultLabel('/x/mlkit-translate-en-ru', 29), 'MTE30');
  assert.equal(defaultLabel('/x/connectedThings', 0), 'CT1'); // camelCase words
  assert.equal(defaultLabel('/x/ai', 4), 'AI5'); // one word: its first letters
  assert.equal(defaultLabel('/x/geojson', 0), 'GEO1');
  assert.equal(defaultLabel('/', 2), 'BB3'); // no usable name
  for (const d of ['/a/b', '/x/a-b-c-d-e-f', '/x/123-go', '/x/Ünïcode-wörld']) assert.ok(checkLabel(defaultLabel(d, 29)), d);
});

test("a tab group color is one of Chrome's nine", () => {
  for (const ok of ['grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange']) assert.equal(checkColor(ok), ok);
  assert.equal(checkColor(' Green '), 'green');
  for (const bad of ['', 'gray', 'teal', '#00ff00', '🟢']) assert.throws(() => checkColor(bad), /color must be one of grey, blue, red/, bad);
});
