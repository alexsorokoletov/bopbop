# Developing bopbop

The MCP server and page agent are in `prototype/`, the Chrome extension in `prototype/extension/`. To use bopbop, see the [README](prototype/README.md); this page is for changing it.

## Run from a clone

```bash
cd prototype
npm install                                   # or: bun install
npm run build:extension                       # then load prototype/dist/extension unpacked at chrome://extensions
claude mcp add -s user bopbop-dev -- node "$PWD/src/server.ts"
codex mcp add bopbop-dev -- node "$PWD/src/server.ts"
```

Node 24+ runs the TypeScript directly; Bun works too (replace `node` with `bun`). The full setup guide for a team, with the Node vs Bun numbers, is [prototype/INSTALL.md](prototype/INSTALL.md).

## Modes (`BBM_MODE`)

| Mode | What it does | Settings |
|---|---|---|
| `connect` | Attaches to a running browser over CDP. | `BBM_CDP_URL=http://127.0.0.1:9222` |
| `extension` (default) | Drives **your real Chrome profile** through the relay extension (the Web Store extension, or `dist/extension` loaded unpacked). | `BBM_RELAY_PORT` pins one port; default: the first free port of 9333–9362 (30 sessions) |
| `launch` | Starts its own Chromium (tests, CI). | `BBM_HEADLESS=0` shows the window |

## Test

```bash
npm test                 # unit + e2e (fixture tasks, guard, modal scope, extract, network, perf, emulate) + MCP stdio
npm run test:extension   # the fixture suite through the extension relay (chrome.debugger)
npm run bench:runtime    # Node vs Bun timings
```

Extension-only suites (focus, parallel sessions, other extensions) run in `npm test` with a test Chromium that loads the extension.

Checks that CI runs: `npm run typecheck`, `npm run lint`, `npm run fmt:check`, `npx knip`.

## Release

- npm: bump `prototype/package.json` in a PR (`npm version X --no-git-tag-version`), merge, then run the **Publish npm** workflow.
- Extension: run the **Publish extension** workflow (it signs a CRX for Verified CRX uploads; key: `certs/bopbop-crx.pub.pem`).
