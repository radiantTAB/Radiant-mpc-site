# Meetly — Handoff (continue in Claude Code on Windows / PowerShell)

This note lets you (or a fresh Claude Code session) pick up the Meetly project
on a Windows machine. Everything below is already merged to `main`.

## TL;DR — current state

- **Meetly** is a Calendly-style scheduling app in `calendly-clone/`, with its
  backend in `worker/`, served by the Git-connected Cloudflare Worker
  **radiant-mpc-site**.
- **Feature-complete**: booking flow, D1 backend, admin console, dark mode,
  timezones, reschedule/cancel, `.ics`, confirmation + reminder emails (cron),
  booking guardrails, date exceptions, dashboard, calendar feed + CSV, custom
  questions, webhooks, team/round-robin, Google Calendar sync + Meet links.
- **Tested**: `node worker/meetly.test.mjs` → 76 checks pass. Network features
  are covered with mocks; the live path proves out only on a real deploy.
- **Not yet done by you**: set the Cloudflare secrets and run the live
  smoke-test. See `calendly-clone/DEPLOY.md`.

## Prerequisites (Windows)

- **Git for Windows** — https://git-scm.com/download/win
- **Node.js 18+** (LTS) — https://nodejs.org (`node --version` to check)
- **Claude Code** — `npm install -g @anthropic-ai/claude-code`
- A terminal: **PowerShell** (these commands assume it) or Windows Terminal.

## Get the code

```powershell
git clone https://github.com/radiantTAB/Radiant-mpc-site.git
cd Radiant-mpc-site
claude            # start Claude Code in the repo
```

## Verify it locally (no deploy needed)

The tests are plain Node ESM — no install step:

```powershell
node worker/meetly.test.mjs        # expect: "all N Meetly backend checks passed"
```

Preview the front end without a backend (falls back to localStorage). Any static
server works; for example with Node's http-server:

```powershell
npx http-server . -p 8000
# then open http://localhost:8000/calendly-clone/booking.html
#          and http://localhost:8000/calendly-clone/admin.html
```

> Opening the HTML files directly (file://) mostly works, but some browsers
> disable `localStorage` on `file://` — prefer a local server.

## Deploy

Full steps are in **`calendly-clone/DEPLOY.md`**. Short version:

```powershell
npm install -g wrangler
wrangler login
wrangler deploy                         # or just merge to main (auto-deploys)
wrangler secret put MEETLY_ADMIN_TOKEN
wrangler secret put RESEND_API_KEY
# optional: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
```

PowerShell note: `wrangler secret put` prompts for the value interactively, so
you don't need shell env-var syntax. If you ever do need an env var in
PowerShell it's `$env:NAME = "value"` (not `export`).

## How to continue building (branch workflow)

`main` is the source of truth and auto-deploys. Work on a branch, not `main`:

```powershell
git checkout main
git pull
git checkout -b my-change
# ...edit, then:
node worker/meetly.test.mjs
git add -A
git commit -m "…"
git push -u origin my-change
# open a PR on GitHub, merge to main -> auto-deploys
```

If you ask Claude Code to make changes, tell it to run the test after edits and
to open a PR rather than committing to `main` directly.

## Project map

| Path | What it is |
|------|-----------|
| `calendly-clone/index.html` | Marketing landing page |
| `calendly-clone/booking.html` + `app.js` | Public booking flow |
| `calendly-clone/admin.html` + `admin.js` | Admin console |
| `calendly-clone/store.js` | Data layer (localStorage ↔ API) |
| `calendly-clone/styles.css` | All styling (light + dark) |
| `calendly-clone/README.md` | Full feature + architecture reference |
| `calendly-clone/DEPLOY.md` | Deployment guide |
| `worker/meetly.js` | Scheduling API (`/api/meetly/*`) |
| `worker/meetly-google.js` | Google Calendar OAuth + API |
| `worker/meetly.test.mjs` | Backend test (`node worker/meetly.test.mjs`) |
| `worker/index.js` | Worker entry (routes + cron `scheduled()`) |
| `wrangler.jsonc` | Worker config (bindings, cron, assets) |

## Repo-specific gotchas

- **The offline slot logic is mirrored in two places** — `worker/meetly.js`
  (`computeSlots`) and `calendly-clone/store.js`. If you change the slot maths,
  change both and re-run the test.
- **`meetly.js` defaults are mirrored in `store.js`** (default host, event
  types, rules). Keep them in sync.
- **No `package.json` in the repo by design** — the Cloudflare build bundles the
  Worker without dependencies, and the tests need none. Don't commit a
  `package.json`/`node_modules` (they're gitignored).
- **Secrets are never in the repo** — set them on the Worker (see DEPLOY.md).
- **Meetly reuses the existing D1 `DB` binding** and the `RESEND_API_KEY` secret
  shared with the client portal. Its tables self-create; it doesn't touch the
  License Manager tables.
- **`main` history** shows Meetly PRs as squash-merges (#3–#14).

## What's genuinely left

1. Set secrets + deploy (DEPLOY.md).
2. Smoke-test: booking → email → admin → feed (and Google/Meet if connected).
3. Optional polish only if you want it — the feature set is complete.

---

*Not affiliated with Calendly. "Meetly" is a placeholder brand for this personal
project.*
