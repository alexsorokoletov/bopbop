# Privacy policy: bopbop relay extension

Last updated: 2026-11-02

The bopbop relay extension connects Chrome to a bopbop server that runs on your own computer. It lets an AI agent that you run (for example Claude Code, Codex or Cursor) control the tabs that the agent opens.

## What the extension sends, and where

- The extension connects only to `ws://127.0.0.1` on a port that you set (default 9333–9362). It does not connect to any other server.
- Page content, screenshots and network data from agent tabs go only to that local server. The local server gives them to the agent that you run. What your agent does with that data is controlled by the agent and its provider, not by this extension.
- When the agent's click starts a download in one of its tabs, the extension tells the local server the saved file's path and size. Downloads that you start are not reported.
- To pair without a pasted token, the extension asks a small native messaging host on your computer (installed by the local server) for the pairing token.
- The extension has no analytics, no telemetry, no ads and no remote code.

## What the extension stores

- The pairing token, the port and the cleanup setting, in `chrome.storage.local` on your computer. The token never leaves the browser; only HMAC proofs made from it are sent to the local server.

## What the extension does not do

- It does not sell or share data with third parties.
- It does not collect personal data for the developer. The developer receives nothing from the extension.

## Contact

Open an issue: https://github.com/alexsorokoletov/bopbop/issues
