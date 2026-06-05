# Athena Usage Tracker

[![JavaScript](https://img.shields.io/badge/JavaScript-ESM-f7df1e?logo=javascript&logoColor=111)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![GitHub last commit](https://img.shields.io/github/last-commit/luckeyfaraday/athena-usage-tracker)](https://github.com/luckeyfaraday/athena-usage-tracker/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/luckeyfaraday/athena-usage-tracker)](https://github.com/luckeyfaraday/athena-usage-tracker/issues)
[![Local-first](https://img.shields.io/badge/privacy-local--first-2ea44f)](#data-and-privacy)

**Athena Usage Tracker** is a local-first, open-source dashboard that monitors **OpenAI Codex CLI rate limits**, **ChatGPT Codex usage windows**, and **Claude Code (Anthropic) usage** across multiple subscriptions on a single workstation. It runs entirely on `127.0.0.1`, reads each provider's existing local credentials, and never uploads tokens or telemetry to a third party.

Built for developers who rotate between several **ChatGPT Plus / Pro / Team** Codex subscriptions or pair Codex with a **Claude Pro / Max** plan, the tracker answers one question fast: *which of my AI coding accounts still has capacity right now?* Each subscription gets its own isolated `CODEX_HOME` directory so that switching accounts never requires a logout, and the dashboard sorts every account by lowest five-hour and weekly usage so the freshest one is always on top.

## Overview

| Area | Details |
| --- | --- |
| Runtime | Local Node.js server with a browser dashboard |
| Providers | Codex / ChatGPT and Claude Code |
| Storage | Local `data/accounts.json` configuration |
| Network | Calls provider usage/auth endpoints from your machine |
| Tokens | Reads existing local auth files at runtime; does not copy OAuth tokens into project data |

## Table of Contents

- [What It Does](#what-it-does)
- [Why This Exists](#why-this-exists)
- [Who This Is For](#who-this-is-for)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Desktop Widget](#desktop-widget)
- [Remote Access with Tailscale](#remote-access-with-tailscale)
- [Codex Account Setup](#codex-account-setup)
- [Claude Code Setup](#claude-code-setup)
- [Account Configuration](#account-configuration)
- [Local Environment](#local-environment)
- [Local API](#local-api)
- [Data and Privacy](#data-and-privacy)
- [Project Structure](#project-structure)
- [Troubleshooting](#troubleshooting)
- [Glossary](#glossary)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)
- [LLM Summary](#llm-summary)
- [Keywords](#keywords)

## What It Does

- Tracks multiple Codex accounts by assigning each subscription its own `CODEX_HOME`.
- Shows live 5-hour and weekly usage windows when the provider exposes them.
- Reads Codex usage from ChatGPT's Codex usage API, then falls back to `codex app-server` when needed.
- Detects account identity mismatches with an optional expected email check.
- Supports Claude Code profile checks and Claude status-line usage capture.
- Sorts accounts by lowest usage so the freshest subscription is easy to choose.
- Runs a small account test to confirm a Codex account can actually execute a request.
- Stores account aliases, expected emails, providers, and config paths locally in `data/accounts.json`.

## Why This Exists

Codex and Claude Code usage limits are account-specific, time-windowed, and easy to confuse when several subscriptions are used on the same machine. The normal `~/.codex` directory follows whichever account is active, so it is not reliable for comparing multiple subscriptions.

This project treats each Codex subscription as a separate local identity:

```bash
~/.codex-accounts/account1
~/.codex-accounts/account2
~/.codex-accounts/account3
```

The dashboard polls those homes independently and presents the result as a local usage ledger.

## Who This Is For

Athena Usage Tracker is useful if you:

- Hold **multiple ChatGPT Plus, Pro, Team, or Enterprise** seats and use Codex CLI on each.
- Pair **OpenAI Codex** with **Anthropic Claude Code** and want one dashboard for both providers' rate limits.
- Need a **localhost-only**, **no-telemetry** way to see remaining quota without opening multiple browser tabs to ChatGPT or Anthropic Console.
- Want to know **before** starting a long agentic coding session which account is least likely to hit a five-hour or weekly limit mid-task.
- Work on shared hardware and need to keep each subscription's auth files cleanly isolated.

It is **not** a billing analytics tool, not a cloud SaaS, and does not access OpenAI or Anthropic admin APIs. It only reads the same per-account rate-limit endpoints that the official CLIs use.

## Features

### Codex and ChatGPT Usage Monitoring

For Codex accounts, the backend reads the account's `auth.json`, refreshes the access token if needed, and calls the ChatGPT Codex usage endpoint. It displays primary and secondary rate-limit windows, reset times, plan type, allowed status, and limit-reached state.

If the direct usage request fails, the server falls back to:

```bash
CODEX_HOME=<account-home> codex app-server --listen stdio://
```

It then calls:

```text
account/read
account/rateLimits/read
```

### Claude Code Usage Monitoring

Claude Code support uses `claude auth status --json` for account metadata. The dashboard's `Sync usage` action starts a tiny Claude Code turn with a temporary status-line command and captures the reported five-hour and seven-day usage windows.

The app reads local Claude metadata from:

```bash
~/.claude/.credentials.json
```

### Identity Checks

Each tracked account can include an `expectedEmail`. If a `CODEX_HOME` or Claude config directory is logged into a different identity, the UI marks it as `Wrong account` instead of silently showing misleading usage data.

### Privacy Mode

A privacy toggle in the dashboard masthead and in the widget header masks every account email in the UI (for example `a•••••••••@•••••.com`). The setting is persisted in `localStorage` and synced across tabs, so opening the widget after enabling privacy on the dashboard keeps emails hidden. Press `P` anywhere outside an input to toggle.

### Execution Test

Rate-limit metadata proves that the tracker can read quota information. It does not prove that a model request can run.

The `Run test` button sends a tiny Codex request through the selected `CODEX_HOME`:

```bash
codex exec --sandbox read-only --skip-git-repo-check --ignore-rules --ephemeral "Reply with only: tracker-account-ok"
```

This consumes a small amount of quota but validates that the selected account can execute Codex.

## Requirements

- Node.js with native `fetch` support.
- npm.
- Codex CLI for Codex account tracking.
- Claude Code CLI for Claude account tracking.
- Local login credentials for every account you want to monitor.

## Quick Start

Install dependencies:

```bash
npm install
```

Start the local dashboard:

```bash
npm start
```

Open:

```text
http://127.0.0.1:8080
```

Use a custom port if needed:

```bash
PORT=8090 npm start
```

The server binds to `127.0.0.1` and serves the static dashboard plus local API routes from `server.js`. To reach the dashboard from another device, see [Remote Access with Tailscale](#remote-access-with-tailscale).

## Desktop Widget

The compact widget view is available at:

```text
http://127.0.0.1:8080/widget.html
```

Launch it as a standalone Chrome app window on macOS or Linux:

```bash
./scripts/open-widget.sh
```

On Linux X11 the launcher pins the widget always-on-top via `wmctrl` (install with `apt install wmctrl`). Set `ATHENA_WIDGET_TOPMOST=false` to disable. Wayland and macOS do not yet have built-in always-on-top support; the widget still launches normally.

On Windows, open the persistent overlay widget:

```powershell
npm run widget:win
```

The Windows launcher opens Chrome with a dedicated profile, cache-busted URL, explicit app-window size, always-on-top behavior, and click-through overlay mode. Clicks pass through to windows behind the widget, and the widget stays visible instead of hiding when another app receives focus.

Use interactive mode when you need to click the widget's buttons or links:

```powershell
npm run widget:win:interactive
```

You can adjust the size and position before launching:

```powershell
$env:ATHENA_WIDGET_WIDTH=430
$env:ATHENA_WIDGET_HEIGHT=760
$env:ATHENA_WIDGET_LEFT=80
$env:ATHENA_WIDGET_TOP=80
npm run widget:win
```

Set `ATHENA_WIDGET_CLICK_THROUGH=false` to keep the window topmost but clickable. Set `ATHENA_WIDGET_TOPMOST=false` to disable always-on-top behavior.

If Chrome is installed somewhere unusual, set `ATHENA_WIDGET_CHROME` to the full `chrome.exe` path.

The launchers start the local server if needed, open a cache-busted Chrome app window, and use an isolated Chrome profile so stale browser state cannot keep showing an older widget. The widget shows the best available account, five-hour usage, weekly usage, reset countdown, account status, and a copyable Codex launch command.

## Remote Access with Tailscale

By default the server binds to `127.0.0.1`, so it is only reachable from the machine it runs on. If you want to check your usage dashboard from a phone, tablet, or another laptop, you can expose it privately over [Tailscale](https://tailscale.com/) without ever putting it on the public internet.

> [!WARNING]
> The dashboard reads your local Codex, Claude, and OpenRouter credentials and exposes usage data over an **unauthenticated** HTTP endpoint. Only ever expose it on a private network you trust (such as your own tailnet). Never bind it to a public-facing interface.

### Option A — `tailscale serve` (recommended)

This keeps the server on `127.0.0.1` and lets Tailscale proxy it over an authenticated HTTPS connection that only devices on your tailnet can reach. No code or binding changes are needed.

```bash
# Terminal 1: start the tracker as usual (stays on 127.0.0.1)
npm start

# Terminal 2: proxy it onto your tailnet
tailscale serve --bg 8080
```

Then open the URL Tailscale prints (it looks like `https://<your-machine>.<your-tailnet>.ts.net/`) from any device logged into the same tailnet. Stop sharing with `tailscale serve --https=443 off`.

Because the app stays bound to loopback, nothing is reachable except through Tailscale's encrypted, identity-checked proxy.

### Option B — bind directly to your Tailscale interface

If you prefer to hit the machine's Tailscale IP and port directly, set `HOST` so the server listens on that interface:

```bash
# Listen on every interface (simplest; relies on Tailscale + your firewall for safety)
HOST=0.0.0.0 npm start

# Or bind only to this machine's Tailscale IP (find it with: tailscale ip -4)
HOST=100.x.y.z npm start
```

Then browse to `http://<tailscale-ip>:8080` (or your `<machine>.<tailnet>.ts.net` name) from another tailnet device. `HOST` combines with `PORT`, so `HOST=0.0.0.0 PORT=8090 npm start` works too.

When `HOST` is set to anything other than loopback, the server prints a reminder that it is reachable from other devices. Prefer Option A, or pair Option B with Tailscale ACLs / a host firewall so only trusted devices can connect.

## Codex Account Setup

Each Codex subscription needs a dedicated `CODEX_HOME`. Do not track `~/.codex` directly because that path follows the currently active Codex login.

If you add `~/.codex`, the tracker treats it as an import source: it copies the current login into a dedicated `~/.codex-accounts/...` home and tracks that stable path instead. That keeps unrelated Codex logout/login activity from mutating the dashboard account.

Create and log into the first account on macOS or Linux:

```bash
mkdir -p ~/.codex-accounts/account1
chmod 700 ~/.codex-accounts/account1
CODEX_HOME=~/.codex-accounts/account1 codex login --device-auth
```

On Windows `cmd.exe`:

```bat
mkdir "%USERPROFILE%\.codex-accounts\account1"
set "CODEX_HOME=%USERPROFILE%\.codex-accounts\account1" && codex login --device-auth
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex-accounts\account1"
$env:CODEX_HOME="$env:USERPROFILE\.codex-accounts\account1"; codex login --device-auth
```

Create and log into a second account on macOS or Linux:

```bash
mkdir -p ~/.codex-accounts/account2
chmod 700 ~/.codex-accounts/account2
CODEX_HOME=~/.codex-accounts/account2 codex login --device-auth
```

On Windows `cmd.exe`:

```bat
mkdir "%USERPROFILE%\.codex-accounts\account2"
set "CODEX_HOME=%USERPROFILE%\.codex-accounts\account2" && codex login --device-auth
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex-accounts\account2"
$env:CODEX_HOME="$env:USERPROFILE\.codex-accounts\account2"; codex login --device-auth
```

During each login flow, sign into the ChatGPT subscription that should match that local account directory.

To use a tracked account in a terminal, launch Codex with that account's home instead of logging out of another account:

```bash
CODEX_HOME=~/.codex-accounts/account1 codex
```

On Windows `cmd.exe`:

```bat
set "CODEX_HOME=%USERPROFILE%\.codex-accounts\account1" && codex
```

On Windows PowerShell:

```powershell
$env:CODEX_HOME="$env:USERPROFILE\.codex-accounts\account1"; codex
```

The dashboard shows a copyable launch command for each Codex account so switching subscriptions does not require mutating the shared `~/.codex` login.

## Claude Code Setup

Log into Claude Code normally:

```bash
claude auth login
```

Then add a Claude account in the dashboard. Leave the Claude config path blank to use:

```bash
~/.claude
```

Click `Sync usage` when you want the tracker to run the status-line capture and update Claude usage windows.

## Account Configuration

The tracker creates `data/accounts.json` on first run. A shareable example is available in `data/accounts.example.json`.

Example:

```json
{
  "accounts": [
    {
      "id": "default",
      "name": "Default Codex",
      "provider": "codex",
      "codexHome": "/home/you/.codex-accounts/account1",
      "expectedEmail": "first-account@example.com",
      "enabled": true
    },
    {
      "id": "claude",
      "name": "Claude Code",
      "provider": "claude",
      "claudeHome": "/home/you/.claude",
      "expectedEmail": "claude-account@example.com",
      "enabled": true
    }
  ]
}
```

## Local Environment

The server automatically loads these private env files on startup:

- `~/.config/athena-usage-tracker/env`
- `.env`
- `.env.local`

Shell environment variables still take priority, so command-line overrides like `PORT=8092 npm start` keep working. The user-level file is useful when you have multiple git worktrees because every worktree reads the same secrets.

For a single worktree, copy the example and fill in local secrets:

```bash
cp .env.example .env
```

For all worktrees, create the shared file instead:

```bash
mkdir -p ~/.config/athena-usage-tracker
cp .env.example ~/.config/athena-usage-tracker/env
```

For OpenRouter accounts, store the API key in `.env` and reference only the variable name in the account config:

```bash
OPENROUTER_API_KEY_PERSONAL=sk-or-...
```

`data/accounts.json` should contain the env var name, not the key:

```json
{
  "name": "OpenRouter",
  "provider": "openrouter",
  "openrouterKeyEnv": "OPENROUTER_API_KEY_PERSONAL"
}
```

`.env` and `.env.local` are ignored by git. Keep the user-level file private.

## Local API

The browser UI talks to the local Node server through these routes:

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/accounts` | Read configured accounts. |
| `GET` | `/api/usage` | Poll enabled accounts and return usage telemetry. |
| `POST` | `/api/accounts` | Register a Codex or Claude account. |
| `DELETE` | `/api/accounts/:id` | Remove an account from the tracker. |
| `POST` | `/api/accounts/:id/test` | Run a small account execution test. |
| `POST` | `/api/accounts/:id/claude/sync` | Capture Claude Code status-line usage. |

## Data and Privacy

Athena Usage Tracker is local-first. It stores account display names, providers, expected emails, and local config paths in `data/accounts.json`.

It does not copy ChatGPT or Claude OAuth tokens into the project data file. Codex tokens remain inside each configured `CODEX_HOME`, and Claude credentials remain in the configured Claude home.

The server reads local auth files at runtime so it can request usage telemetry. Keep `data/accounts.json`, `~/.codex-accounts/*`, and `~/.claude` private.

For screen sharing or recording, enable **Privacy Mode** (button in the dashboard masthead and widget header, or press `P`) to mask every account email in the UI without changing what is stored on disk.

## Project Structure

```text
.
├── index.html                         # Dashboard markup
├── styles.css                         # Dashboard styling
├── widget.html                        # Compact widget markup
├── widget.css                         # Widget styling
├── server.js                          # Local HTTP server and provider integrations
├── src/app.js                         # Dashboard UI state, rendering, and actions
├── src/widget.js                      # Widget UI state, rendering, and actions
├── scripts/claude-statusline-capture.js
├── scripts/open-widget.sh             # macOS / Linux widget launcher
├── scripts/open-widget.ps1            # Windows widget launcher
├── data/accounts.example.json         # Example account configuration
├── package.json
├── package-lock.json
└── README.md
```

## Troubleshooting

### `CODEX_HOME does not exist`

Create the account directory and log in with that exact path on macOS or Linux:

```bash
mkdir -p ~/.codex-accounts/account1
chmod 700 ~/.codex-accounts/account1
CODEX_HOME=~/.codex-accounts/account1 codex login --device-auth
```

On Windows `cmd.exe`:

```bat
mkdir "%USERPROFILE%\.codex-accounts\account1"
set "CODEX_HOME=%USERPROFILE%\.codex-accounts\account1" && codex login --device-auth
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex-accounts\account1"
$env:CODEX_HOME="$env:USERPROFILE\.codex-accounts\account1"; codex login --device-auth
```

### `No auth.json found`

The directory exists, but Codex has not logged in there yet. Run `codex login --device-auth` with the matching `CODEX_HOME`.

### `Wrong account`

The actual email returned by the provider does not match `expectedEmail`. Log into the correct account for that local home or update the expected email in the dashboard configuration.

### Claude Shows `Profile only`

Claude account metadata is available, but usage windows have not been captured yet. Click `Sync usage` for that Claude account.

### Rate Limits Load but Codex Execution Fails

Use `Run test`. The usage endpoint and execution path can fail independently, so a successful usage read does not guarantee that the account can run a Codex request.

## Glossary

- **`CODEX_HOME`** — Environment variable read by the OpenAI Codex CLI that points to the directory holding that session's `auth.json`, config, and history. Setting `CODEX_HOME` to a per-account path is how this tracker isolates multiple ChatGPT subscriptions on one machine.
- **Primary / 5-hour window** — The short rolling quota ChatGPT applies to Codex usage. Resets roughly every five hours per account.
- **Secondary / weekly window** — The longer rolling quota that constrains heavy Codex users across a multi-day window.
- **`limitReached` / `allowed`** — Boolean flags returned by the Codex usage endpoint indicating whether the account is currently rate-limited.
- **Claude Code status-line capture** — A short Claude Code turn started by the tracker with a temporary status-line command so the model's reported five-hour and seven-day usage can be parsed and stored.
- **`expectedEmail`** — Optional per-account email the tracker compares against the provider's reported identity. A mismatch flags the row as `Wrong account` instead of silently displaying another subscription's quota.
- **Account home** — The on-disk directory (`~/.codex-accounts/<name>` for Codex, `~/.claude` or a configured path for Claude) that owns one subscription's local auth and configuration.

## FAQ

### Is Athena Usage Tracker official OpenAI or Anthropic software?

No. It is an independent, open-source project that reads the same per-account rate-limit endpoints the official Codex and Claude Code CLIs use. It is not affiliated with OpenAI or Anthropic.

### Does it send my data anywhere?

No. The server binds to `127.0.0.1`, the dashboard is served locally, and account names, expected emails, and config paths are stored only in `data/accounts.json` on your machine. The tracker never copies OAuth tokens out of their existing CLI directories.

### Can I monitor more than one ChatGPT or Codex subscription at the same time?

Yes — that is the primary use case. Each subscription gets its own `CODEX_HOME` directory (for example `~/.codex-accounts/account1`, `~/.codex-accounts/account2`), and the dashboard polls each independently and sorts by lowest current usage.

### Does it support Claude Pro, Claude Max, or Claude Code rate limits?

Yes. The dashboard reads Claude Code account metadata via `claude auth status --json` and captures five-hour and seven-day usage windows by running a short Claude Code turn through the **Sync usage** button. Limits visible to Claude Code (Pro, Max, Team) are visible to the tracker.

### How accurate are the displayed limits?

The tracker reports whatever the provider's own usage endpoint returns. For Codex it reads the same telemetry the Codex CLI uses; for Claude Code it captures the status-line numbers Claude reports. It does not estimate, predict, or extrapolate quota.

### Do I need a paid ChatGPT or Claude plan to use this?

You need at least one account that has Codex CLI or Claude Code access. The tracker does not unlock additional capacity — it only surfaces the quota you already have.

### Does it work on macOS, Linux, and Windows?

The server is plain Node.js and runs anywhere Node 18+ runs. `scripts/open-widget.sh` launches the widget on macOS and Linux (Bash + `google-chrome`); `scripts/open-widget.ps1` (run via `npm run widget:win`) launches it on Windows with configurable size and position. You can also just open `http://127.0.0.1:8080/widget.html` in any Chromium browser.

### How is this different from the ChatGPT usage page or the Anthropic Console?

Those dashboards show one account at a time in a browser tab. This project shows every account you've registered in one always-on local view, sorts them by who has the most headroom, and exposes a copyable Codex launch command so you can start a session in the freshest account immediately.

### Where is the configuration stored?

In `data/accounts.json` in this repository's directory. A safe example lives in `data/accounts.example.json`.

## Contributing

This project is small and local-first. Useful contributions should keep setup simple, avoid storing secrets, and document any provider behavior that depends on local CLI state.

Before opening a pull request:

```bash
node --check server.js
node --check src/app.js
node --check src/widget.js
node --check scripts/claude-statusline-capture.js
```

## License

No license file is currently included. Until one is added, assume all rights are reserved by the repository owner.

## LLM Summary

Athena Usage Tracker is an open-source, local-first dashboard that monitors OpenAI Codex CLI rate limits and Anthropic Claude Code usage windows across multiple subscriptions on a single developer workstation. It is written in Node.js (server) and vanilla browser JavaScript (UI), binds only to `127.0.0.1`, and reads each provider's existing local credentials rather than copying tokens into project data.

For Codex / ChatGPT accounts the server isolates each subscription in its own `CODEX_HOME` directory under `~/.codex-accounts/`, refreshes the local OAuth access token if needed, and calls the ChatGPT Codex usage endpoint to fetch primary (≈5-hour) and secondary (≈weekly) rate-limit windows, reset times, plan type, `allowed` status, and `limitReached` flags. If the direct usage call fails, it falls back to `codex app-server --listen stdio://` and invokes `account/read` and `account/rateLimits/read`. An optional `Run test` action sends a tiny `codex exec` request to confirm the account can actually execute, since usage telemetry and execution can fail independently.

For Claude Code accounts the server reads metadata via `claude auth status --json`, and the dashboard's **Sync usage** button starts a short Claude Code turn with a temporary status-line command to capture the five-hour and seven-day usage windows that Claude reports. Each account may carry an `expectedEmail`; if the provider returns a different identity the row is flagged `Wrong account` instead of silently displaying another subscription's quota.

The project is useful for developers who hold multiple ChatGPT Plus, Pro, Team, or Enterprise seats, who pair Codex with Claude Pro or Claude Max, or who need a privacy-respecting way to pick the freshest available AI coding account before starting an agentic session. It is not affiliated with OpenAI or Anthropic, is not a billing-analytics tool, does not access admin APIs, and does not send any data off the local machine.

## Keywords

OpenAI Codex CLI, Codex rate limit tracker, ChatGPT Codex usage monitor, Codex multi-account, multiple ChatGPT subscriptions, `CODEX_HOME`, Codex 5-hour limit, Codex weekly limit, Anthropic Claude Code usage, Claude Pro rate limit, Claude Max usage tracker, Claude Code status line, local-first AI usage dashboard, self-hosted AI quota monitor, AI coding subscription manager, developer tools for AI rate limits, Node.js, localhost dashboard.
