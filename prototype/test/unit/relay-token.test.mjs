// The token moved from ~/.config/better-browser-mcp to ~/.config/bopbop: an extension paired before keeps its token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const relay = fileURLToPath(new URL('../../src/relay.ts', import.meta.url));
const tokenIn = (home) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', `import { relayToken } from ${JSON.stringify(relay)}; process.stdout.write(relayToken());`], {
    env: { ...process.env, HOME: home, USERPROFILE: home, BBM_RELAY_TOKEN: '' },
  }).toString();

test('a token from before the rename is kept and copied to ~/.config/bopbop', () => {
  const home = mkdtempSync(join(tmpdir(), 'bopbop-home-'));
  mkdirSync(join(home, '.config', 'better-browser-mcp'), { recursive: true });
  writeFileSync(join(home, '.config', 'better-browser-mcp', 'relay-token'), 'old-token-0123456789abcdef\n');
  assert.equal(tokenIn(home), 'old-token-0123456789abcdef');
  const file = join(home, '.config', 'bopbop', 'relay-token');
  assert.equal(readFileSync(file, 'utf8').trim(), 'old-token-0123456789abcdef');
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
});

test('a new computer gets a new token in ~/.config/bopbop', () => {
  const home = mkdtempSync(join(tmpdir(), 'bopbop-home-'));
  const t = tokenIn(home);
  assert.match(t, /^[0-9a-f]{48}$/);
  assert.equal(readFileSync(join(home, '.config', 'bopbop', 'relay-token'), 'utf8').trim(), t);
});
