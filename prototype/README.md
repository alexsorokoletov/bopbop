# better-browser-mcp: server reference

The MCP server, the page agent and the relay extension. Setup steps for a team: [`INSTALL.md`](INSTALL.md).

## Run

From npm (the package is `bopbop`; the project is being renamed from better-browser-mcp):

```bash
claude mcp add -s user bbm -- npx -y bopbop
codex mcp add bbm -- npx -y bopbop
```

From a clone:

```bash
bun install                                   # or: npm install
claude mcp add -s user bbm -- bun /abs/path/prototype/src/server.ts
codex mcp add bbm -- bun /abs/path/prototype/src/server.ts
```

Node 24+ also runs the server: replace `bun` with `node`.

## Modes (`BBM_MODE`)

| Mode | What it does | Settings |
|---|---|---|
| `connect` | Attaches to a running browser over CDP. | `BBM_CDP_URL=http://127.0.0.1:9222` |
| `extension` (default) | Drives **your real Chrome profile** through the relay extension (build and load `dist/extension` unpacked). | `BBM_RELAY_PORT` pins one port; default: the first free port of 9333–9362 (30 sessions) |

## Settings

| Setting | Effect |
|---|---|
| `BBM_GUARD=shop-social` | Blocks Buy now, Place order, checkout pages and Post buttons (step checks, in-page guard, browser-level blocking). Under the guard, JavaScript clicks through `eval` are blocked too. |
| `BBM_ALLOW=http://127.0.0.1:*,*.example.com` | Origin allowlist. Fails closed. Enforced in the browser (documents, frames, redirects, popups). |
| `BBM_UPLOAD_ROOTS=/path/a,/path/b` | Upload files only from these folders (default `~/Downloads`, `$TMPDIR/bbm-uploads`). Hidden files are refused. |
| `BBM_OUTPUT_DIR=/path` | Where HAR files go (default `~/Downloads/bbm`). The agent gives only a file name. |
| `BBM_SHOW_COOKIES=1` | Show cookie and credential header values in full (default: shortened). |
| `BBM_WINDOW=agent` | Extension mode: agent tabs in their own unfocused window. |
| `BBM_KEEP_TABS=1` | Extension mode: keep the agent's tabs open when the session ends. |
| `BBM_FRONT=1` | Extension mode: bring agent tabs to the front (old behavior). |
| `BBM_TRACE=1` | Timing traces on stderr. |

## Tools

| Tool | Use |
|---|---|
| `navigate` | Open a URL (or back, forward, reload). Returns the snapshot; `snapshot: interactive\|none` for less. |
| `act` | Batched steps; returns step results, events (navigation, dialogs, new tabs, errors) and what changed. Refs or locators: `text=Save`, `css=.bar button`, `e12 >> text=Save`; alternatives `css=textarea, text=Ask` (first match wins); an ambiguous `text=` gives a warning. |
| `snapshot` | Page structure with refs. `search`, `ref`, `viewport`, `mode=interactive`, `scope=page` (default: the open dialog). |
| `read` | Page text. `format=markdown`: the main content as Markdown. |
| `extract` | Tables as rows keyed by column, label/value tables and `<dl>` as fields, as JSON. |
| `wait` | Until text appears or goes, a ref is visible, or the URL matches. |
| `screenshot` | JPEG of the viewport, a ref/locator, a `clip` rect (+`padding`) or the full page; `marks` draws refs. 1280 px wide at most, `scale: full` for 1:1. Returns the captured area in CSS px. |
| `eval` | JavaScript for values that the other tools do not show. Awaits a returned Promise (`timeout`). One line if the page changed; `snapshot: diff\|full` shows the change. |
| `console` | Console messages and page errors; identical messages show once with `×N`. |
| `network` | Requests with time and size; `id`: phases, headers, bodies; `cookies`; `har` export. |
| `emulate` | Device presets, viewport, dark mode, reduced motion, network and CPU throttling, `reset`; `window=true` resizes the agent window. |
| `perf` | Web Vitals with ratings, long tasks, slowest and largest resources, heap and DOM size. |
| `tabs` | List, open, select (one line), close, duplicate (keeps sessionStorage). Extension mode: `label` names the tab group `Agent:<1-5 letters, digits or emoji>` (default: project initials + slot, e.g. `Agent:CT2`). |

`act` steps: `click`, `type` (+`submit`), `press`, `hover`, `select` (native or custom combobox, verified), `check`/`uncheck`, `upload`, `drag` (+`position`), `click_xy`, `scroll` (+`until`), `wait`, `wait_for`, `dialog`, `navigate`. Any ref field also accepts `text=Label`.

## Test

```bash
npm test                 # unit + e2e (fixture tasks, guard, modal scope, extract, network, perf, emulate) + MCP stdio
npm run test:extension   # the fixture suite through the extension relay (chrome.debugger)
npm run bench:runtime    # Node vs Bun timings
```

Extension-only suites (focus, parallel sessions, other extensions) run in `npm test` with a test Chromium that loads the extension.
