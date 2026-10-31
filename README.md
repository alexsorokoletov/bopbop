<p align="center"><img src="brand/icon-128.png" width="96" alt=""></p>

<h1 align="center">better-browser-mcp</h1>

<p align="center"><b>Give any AI agent your Chrome. Better than Claude in Chrome, at a third of the tokens.</b></p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="bench/README.md">Benchmark</a> ·
  <a href="lessons/lessons.md">Lessons</a> ·
  <a href="prototype/README.md">Docs</a>
</p>

<p align="center"><a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a></p>

---

I read through my own agent sessions. Browser agents took 1,849 screenshots and read the page as text 7 times. Most of the tokens went into looking at pages, not into doing the work.

bbm is an MCP server that gives any agent (Codex, Claude Code, or any other MCP client) your real Chrome, with your sign-ins: the kind of access Claude in Chrome gives Claude. In our benchmark it does that job better than Claude in Chrome: 72% fewer tokens, 3.5× faster, and it passed all 32 runs where Claude in Chrome passed 28.

The browser answers in text, in few calls. Open a page and you get the page. Do several things and you get back what happened.

```
> navigate /login-form/
  # Sign in
  textbox "Username" [e1]
  textbox "Password" [e2]
  checkbox "Keep me signed in" [e3]
  button "Sign in" [e4] disabled

> act  type e1 "bench_user" · type e2 "S3cure!pass#42" · click e4
  1. type e1 "bench_user" ✓
  2. type e2 "S3cure!pass#42" ✓
  3. click e4 ✓
  # Welcome back
  You are signed in as bench_user.
```

That is a login in two calls. The output above is real, from a test page in [`fixtures/`](fixtures/).

## The numbers

16 hard pages (iframes, shadow DOM, native dialogs, popups, uploads, and a prompt-injection trap). Claude Sonnet 5.5, 2 runs each. The server checks success, not the agent.

| | success | tokens / task | calls | time | cost |
|---|---|---|---|---|---|
| **bbm** | **32/32** | **30.5k** | **3.2** | **11 s** | **$0.025** |
| Playwright MCP | 32/32 | 84.8k | 7.8 | 27 s | $0.039 |
| chrome-devtools-mcp | 32/32 | 100.7k | 6.7 | 21 s | $0.041 |
| claude-in-chrome | 28/32 | 109.9k | 8.9 | 39 s | $0.055 |

<details>
<summary><b>Real sites, real Chrome profile</b> (vs claude-in-chrome)</summary>

<br>

Medians of 3 runs. Each run is checked against ground truth (the HN API, the live product page, the cart), not against what the agent says it did.

| Task | bbm | claude-in-chrome |
|---|---|---|
| Hacker News: top story + 3 top comments | 4 calls · 35k | 5 calls · 75k |
| Amazon: find a USB-C hub by price, rating, ports | 2 calls · 45k | 8 calls · 163k |
| Amazon: add it to the cart (checkout blocked) | 4 calls · 76k | 12 calls · 217k |

All runs passed (3/3) on both sides. The samples are small: treat differences under ~15% as noise. Method, raw runs and failures are in [`bench/`](bench/README.md).

</details>

## Quick start

```bash
cd prototype && bun install        # or npm install
claude mcp add -s user bbm -- bun "$PWD/src/server.ts"
# Codex: codex mcp add bbm -- bun "$PWD/src/server.ts"
```

Then load the Chrome extension ([2-minute guide](prototype/INSTALL.md)) and ask:

> *Use bbm. Open example.com and tell me the heading.*

## Why it feels different

**It stays out of your way.** The agent works in its own tab group. It never takes your active tab and never steals focus. Up to 30 sessions share one Chrome, and each session sees only its own tabs. If you reload the extension or restart Chrome, the next call reconnects.

**It does not lie about clicks.** If a click changes nothing, bbm tries once more with the keyboard. If that also fails, it reports `⚠ no effect`, not ✓.

**It keeps your wallet closed.** `BBM_GUARD=shop-social` blocks Buy now, Place order, checkout and Post, at three levels. Hidden text never gets to the model, and lines that look like prompt injection are flagged.

<details>
<summary><b>All the details</b></summary>

<br>

**Fewer calls, fewer tokens**
- `navigate` returns the page. `act` runs a batch of steps and returns a diff.
- A compact snapshot (`role "name" [e5] states`) that sees into iframes and shadow DOM.
- In an open dialog or composer, snapshots cover only that dialog.
- `extract` gives tables and records as JSON. `read` gives the main content as Markdown.
- 13 tools, ~2.5k tokens of definitions (others use 5–7k).

**Your Chrome, shared politely**
- Extension mode drives your real profile. Agent tabs close when the session ends, except the tabs that you used.
- Fields in agent tabs opt out of password managers, so their pop-ups do not break the session.

**Safety**
- Cookie and credential header values are shortened. Downloads go into one folder, by name only.
- Local only: stdio and a paired local WebSocket. No cloud relay.

**Developer tools**
- `network`: timings, sizes, headers and cookies per request, filters, HAR export.
- `emulate`: device presets, dark mode, network and CPU throttling.
- `perf`: Web Vitals, long tasks, the heaviest resources, heap and DOM size.

</details>

<details>
<summary><b>What is in this repo</b></summary>

<br>

| Path | |
|---|---|
| [`prototype/`](prototype/) | The MCP server (Node or Bun), page agent, Chrome extension |
| [`bench/`](bench/) | Fixture benchmark and real-site benchmark |
| [`fixtures/`](fixtures/) | The 16 hard pages, with a server that checks success |
| [`lessons/`](lessons/lessons.md) | Each failure we found, why it happened, the fix, and its regression test |
| [`brand/`](brand/) | Icon and social cards |

</details>

## License

[MIT](LICENSE)
