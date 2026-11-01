// MCP over stdio: tool list, definition size budget, and a real login flow through tool calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer } from '../../../fixtures/server.mjs';
import { checkTask } from '../../../bench/check.mjs';

let srv, client;
before(async () => {
  srv = await startServer({ port: 0 });
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../src/server.ts', import.meta.url))],
      env: { ...process.env, BBM_MODE: 'launch', BBM_HEADLESS: '1' },
    }),
  );
});
after(async () => {
  await client?.close();
  await srv?.close();
});

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return r.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
};

test('serverInfo.version is the package version', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.equal(client.getServerVersion().version, pkg.version);
});

test('tool list is small', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'act',
    'console',
    'emulate',
    'eval',
    'extract',
    'navigate',
    'network',
    'perf',
    'read',
    'screenshot',
    'snapshot',
    'tabs',
    'wait',
  ]);
  const approxTokens = JSON.stringify(tools).length / 4;
  console.log(`tool definitions ≈ ${Math.round(approxTokens)} tokens`);
  assert.ok(approxTokens < 3500, `tool defs too big: ${approxTokens}`);
});

test('tool schemas are portable (no unions/tuples: Codex/OpenAI drop such tools)', async () => {
  const { tools } = await client.listTools();
  for (const t of tools) {
    const s = JSON.stringify(t.inputSchema);
    assert.doesNotMatch(s, /"(anyOf|oneOf|allOf|prefixItems)"|"items":\[/, `${t.name} schema is not portable`);
  }
});

test('login via MCP tools', async () => {
  const snap = await call('navigate', { url: `${srv.base}/login-form/` });
  const u = /textbox "Username" \[(e\d+)\]/.exec(snap)[1];
  const p = /textbox "Password" \[(e\d+)\]/.exec(snap)[1];
  const out = await call('act', {
    steps: [
      { type: u, text: 'bench_user' },
      { type: p, text: 'S3cure!pass#42', submit: true },
    ],
  });
  assert.match(out, /signed in/);
  const st = await (await fetch(`${srv.base}/api/state?task=login-form`)).json();
  assert.ok(checkTask('login-form', st).pass);
  assert.match(await call('network', { pattern: 'login' }), /POST 200/);
  assert.match(await call('eval', { expression: 'document.title' }), /Acme/);
  const shot = await client.callTool({ name: 'screenshot', arguments: {} });
  assert.equal(shot.content[0].type, 'image');
});

test('errors are tool errors, not crashes', async () => {
  const r = await client.callTool({ name: 'act', arguments: { steps: [{ click: 'e999' }] } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown ref e999/);
});
