# bopbop

Give your AI agent (Claude Code, Codex, Cursor, any MCP client) your real Chrome, with your sign-ins. The agent works in its own tab group; your tabs stay yours. It reads pages as small text snapshots, not screenshots: in our benchmark, 72% fewer tokens and 3.5× faster than Claude in Chrome. Everything runs on your computer, no cloud.

## Install

1. Install the Chrome extension: [bopbop relay](https://chromewebstore.google.com/detail/emlckjhnbjogdooccahhbkhciflhobpp).
2. Add the server to your agent:

   ```bash
   claude mcp add -s user bopbop -- npx -y bopbop    # Claude Code
   codex mcp add bopbop -- npx -y bopbop             # Codex
   ```

   Cursor and other MCP clients: add this to the client's MCP config (for Cursor, `~/.cursor/mcp.json`):

   ```json
   { "mcpServers": { "bopbop": { "command": "npx", "args": ["-y", "bopbop"] } } }
   ```

3. Optional: teach your agent how to use it well (batch steps, read data without screenshots):

   ```bash
   npx skills add alexsorokoletov/bopbop
   ```

4. Restart the agent and ask: *"Use bopbop. Open example.com and tell me the heading."* A tab opens in an **Agent** tab group in your Chrome. The extension pairs with the server by itself; there is nothing to paste.

Needs Node.js 24+ and Chrome (or Edge, Brave, Chromium) 125+.

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

## Settings

Set them when you add the server, for example `claude mcp add -s user bopbop -e BBM_GUARD=shop-social -- npx -y bopbop`, or under `"env"` in a JSON config.

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
| `BBM_MODE=connect` + `BBM_CDP_URL=http://127.0.0.1:9222` | Use a browser that you started with remote debugging, not the extension. |

## If it does not work

| Symptom | Fix |
|---|---|
| `extension did not connect/pair` | Check that the bopbop extension is installed and on, then restart the agent. If it still does not pair, paste the token from `~/.config/bopbop/relay-token` on the extension's options page. |
| `all 30 bopbop slots are taken` | 30 agent sessions already use this Chrome, or old ones did not exit. Close the sessions you do not use. |
| `blocked: ... is not in the allowlist (BBM_ALLOW)` | `BBM_ALLOW` is set and does not include that site. Add it. |
| The agent says the tools are missing | Run `claude mcp list` (or `codex mcp list`): `bopbop` must be connected. |

Something else: [open an issue](https://github.com/alexsorokoletov/bopbop/issues).

## Privacy

Everything stays on your computer: the extension talks only to the server on `127.0.0.1`, with no analytics. [Privacy policy](https://github.com/alexsorokoletov/bopbop/blob/main/PRIVACY.md).

Developing bopbop itself (run from a clone, tests, building the extension): [DEVELOPMENT.md](https://github.com/alexsorokoletov/bopbop/blob/main/DEVELOPMENT.md).
