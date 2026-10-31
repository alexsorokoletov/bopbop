# Install better-browser-mcp

This guide installs the MCP server, adds it to Claude Code or Codex, and connects it to your real Chrome profile.

## 1. Prerequisites

| Item | Version | Check |
|---|---|---|
| Node.js | 24 or later | `node --version` |
| Bun (optional, recommended) | 1.4 or later | `bun --version` (install: `brew install oven-sh/bun/bun`) |
| Google Chrome or Chromium | 125 or later | Chrome is in `/Applications`, or set `BBM_CHROME` |
| Claude Code and/or Codex CLI | current | `claude --version`, `codex --version` |

## 2. Get the code and install

```bash
git clone https://github.com/alexsorokoletov/bopbop.git
cd bopbop/prototype
npm install          # or: bun install (it makes a bun.lock file from package-lock.json)
```

Do the steps below from `bopbop/prototype`. They use `$PWD` to make an absolute path.

## 3. Add the server to your agent

Use one runtime. The server is the same file for Node and Bun.

**Claude Code**

```bash
claude mcp add -s user bbm -- bun "$PWD/src/server.ts"     # Bun (recommended)
claude mcp add -s user bbm -- node "$PWD/src/server.ts"    # Node
```

**Codex CLI**

```bash
codex mcp add bbm -- bun "$PWD/src/server.ts"      # Bun (recommended)
codex mcp add bbm -- node "$PWD/src/server.ts"     # Node
```

`-s user` makes `bbm` available in all your projects. Without it, Claude Code adds it only for the current folder. Codex adds servers for all projects.

Then do a check. `claude mcp list` must show `bbm: ... ✔ Connected`. `codex mcp list` must show `bbm` with status `enabled`.

With no other settings, the server uses your Chrome through the relay extension (`extension` mode). Complete step 4 to load and pair it. To open a fresh headless Chromium with an empty profile instead, explicitly set `BBM_MODE=launch`.

## 4. Use your real Chrome profile (extension mode)

This is the default mode. It lets the agent use your sign-ins and cookies.

1. Build the extension: `npm run build:extension`. The output is in `dist/extension`.
2. In Chrome, go to `chrome://extensions`. Turn on **Developer mode**. Click **Load unpacked**. Select the folder `bopbop/prototype/dist/extension`.
3. The server added in step 3 already defaults to extension mode. If your existing entry explicitly sets another mode, replace it:

   ```bash
   claude mcp remove -s user bbm
   claude mcp add -s user bbm -e BBM_MODE=extension -- bun "$PWD/src/server.ts"
   # Codex: codex mcp remove bbm && codex mcp add bbm --env BBM_MODE=extension -- bun "$PWD/src/server.ts"
   ```

4. Start the agent and make one browser call. On the first start, the server writes a pairing token to `~/.config/better-browser-mcp/relay-token`.
5. Copy the token: `pbcopy < ~/.config/better-browser-mcp/relay-token`.
6. Open the extension options (on `chrome://extensions`, click **Details**, then **Extension options**). Paste the token. Keep port `9333`. Click **Save**.

The extension connects to `ws://127.0.0.1:9333` only. The token stays in Chrome. Only HMAC proofs go on the wire. The agent sees only the tabs in the **Agent** tab group. Your other tabs stay hidden from it.

### Working side by side with the agent (extension mode)

The agent works in the background. It does not switch your active tab or focus a window. Its tabs are in the **Agent** tab group.

| Setting | Effect |
|---|---|
| (default) | Agent tabs open in the background of your window. When the agent session ends, the extension closes the agent tabs that you did not open or pin. It keeps the tabs that you used, and removes them from the group. |
| `-e BBM_WINDOW=agent` | Agent tabs open in a separate window. The extension does not focus this window. |
| `-e BBM_KEEP_TABS=1` | Agent tabs stay open after the session ends, for example to examine a draft. |
| `-e BBM_FRONT=1` | Old behavior: the agent brings its tab to the front. |

Up to 30 agent sessions can use the same Chrome at the same time (for example, several Claude Code windows). Each server uses the first free port of 9333-9362. The extension tries the ports up to 2 past the highest connected one, and all 30 once every 5 minutes, so the error list in `chrome://extensions` stays short. A server keeps its port while it runs: after an extension reload, a Chrome restart or a sleep, the next tool call waits for the extension to connect again (up to 30 s) and continues. The agent is told that its earlier tabs are gone. You need `/mcp` only after a change to the server code. Each session sees only its own tabs, in its own group. The group is named after the project and the slot, for example **Agent:CT2** for `connected-things` in slot 2 (`BBM_LABEL` sets a fixed name). The agent is asked to rename it for its task with 1-5 letters, digits or emoji: `tabs action=label label=ALD` gives **Agent:ALD**, `label=🧪` gives **Agent:🧪**. Add `color=green` (or grey, blue, red, yellow, pink, purple, cyan, orange) to color the group; `color` alone keeps the name. The default is purple. When a sleep leaves a dead link, the extension's next connection replaces it. A session opens no tab until its first `navigate` or `tabs new`. Agent groups that no live session owns (left after a Chrome restart, for example) close after 7 days without use. Change the number of days on the extension options page (0 = never).

### Network, emulation and performance

- `network` shows the time, size, timing phases, headers and cookies of each request. Cookie values are shortened (`abc…(32 chars)`) because they are often sign-in sessions. To show them in full, set `-e BBM_SHOW_COOKIES=1`.
- `network har=<name>` saves a HAR file. Files go only into `~/Downloads/bbm/` (or `-e BBM_OUTPUT_DIR=<dir>`), by name. The agent cannot select a path.
- `emulate` uses the responsive mode of Chrome: device presets, viewport size, dark mode, network and CPU throttling. `window=true` resizes the real window, but only the agent window.
- `perf` gives Web Vitals, long tasks, the slowest and largest resources, and the heap and DOM size.

A tab that a page or an extension opens from an agent tab becomes an agent tab only if it opens within 3 seconds after an agent action. Tabs that you open stay hidden from the agent.

After pulling code updates, run `npm run build:extension` from `prototype/`, then reload the extension on `chrome://extensions`. Chrome keeps running the loaded extension until you reload it; updating the server or restarting the MCP alone does not update the extension. If you originally loaded a copy from another folder, load `prototype/dist/extension` instead.

Each build prints a display version containing the release version, UTC build time and a hash of the extension files. After reloading, compare it with the version on `chrome://extensions` or the extension's options page. The MCP server also logs the connected extension's build when it pairs. The release version (for example `0.1.0`) alone does not identify a build.

## 5. Smoke check

Give the agent this prompt:

> Use bbm. Open https://example.com and tell me the page heading.

The correct answer is "Example Domain". In extension mode, a new tab opens in an **Agent** tab group in your Chrome.

## 6. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `No Chromium found; set BBM_CHROME` | Install Google Chrome, or set `-e BBM_CHROME=/path/to/chrome` |
| `extension did not connect/pair` after 2 minutes | The extension is not loaded, is turned off, or has no token. Do step 4 again. Then restart the agent. |
| `pairing failed` on stderr | The token in the extension is not the same as the file. Paste it again. |
| `Bbm.setLabel is not supported by the extension relay` | The connected extension is older than the server. Run `npm run build:extension` from `prototype/`, then reload the relay at `chrome://extensions`. Ensure it loads `prototype/dist/extension`, not an older copy. |
| `all 30 bbm slots are taken (ports 9333-9362)` | 30 agent sessions already use this Chrome, or old ones did not exit. Close sessions you do not use. To pin one port, set `-e BBM_RELAY_PORT=<port>`; the extension counts its 30 slots from the base port in its options. |
| `bbm` shows `✗ Failed to connect` | Run the command yourself: `bun src/server.ts` (or `node`). The error is on stderr. Make sure that the path is absolute. |
| `blocked: ... is not in the allowlist (BBM_ALLOW)` | `BBM_ALLOW` is set and does not include the origin. Add it, for example `-e BBM_ALLOW='https://*.example.com'`. |

More settings (`BBM_ALLOW`, `BBM_UPLOAD_ROOTS`, `connect` mode) are in [README.md](README.md).

## 7. Node vs Bun

Both runtimes pass all tests (38 unit and e2e tests, and 19 extension-relay tests). Measured on an Apple Silicon Mac, with Node 24.21 and Bun 1.4.0. Values are median / p90 in ms. Do the measurement again with `npm run bench:runtime`.

| Measure | Node 24.21 | Bun 1.4.0 | Runs |
|---|---|---|---|
| Server cold start (spawn to MCP `initialize` reply) | 119 / 159 | **73 / 86** | 10 |
| First `navigate` (includes the browser start) | 889 / 1033 | 893 / 1022 | 10 |
| Warm `navigate` | 367 / 371 | 365 / 369 | 100 |
| Warm `act` (type into one field) | 323 / 326 | 322 / 325 | 100 |
| Dependency install from a clean `node_modules` (`npm ci` / `bun install`), s | 0.99 / 1.28 | **0.22 / 0.56** | 5 |
| Full test suite (`npm test` / `npm run test:bun`), s | **44.8 / 45.2** | 80.6 / 80.9 | 5 |

The browser sets the speed of tool calls, so the runtime does not change it. Bun starts the server about 45 ms faster and installs about 4 times faster. The Bun test runner runs the test files one after the other, so the suite takes longer on Bun.

**Recommendation:** Use Bun to run the server (step 3). It starts faster and installs faster, and tool calls have the same speed. Use `npm test` for the test suite, because it is faster. Node remains fully supported.
