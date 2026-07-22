# Meetly — Deployment Guide

A step-by-step guide to taking Meetly live on Cloudflare Workers + D1, with
email, reminders, and (optionally) Google Calendar sync.

## What you're deploying

Meetly lives in the **`calendly-clone/`** folder of the
**radiantTAB/Radiant-mpc-site** repository, with its backend in **`worker/`**.
It's served by the same Git-connected Cloudflare Worker (**radiant-mpc-site**)
that runs the rest of the site, and stores bookings in the existing D1 database.
It works with no backend at all (per-browser `localStorage`), and "lights up"
the shared backend once deployed.

> **Good to know** — Because the Worker is connected to the GitHub repo,
> **merging to `main` already deploys the code automatically.** Most of this
> guide is really about setting the **secrets** and **verifying** — the code is
> likely already live.

## Before you start

- A **Cloudflare account** with the **radiant-mpc-site** Worker and the
  **radiant-licenses** D1 database (both already exist).
- Access to the **Cloudflare dashboard** (dash.cloudflare.com).
- A **Resend** API key for outgoing email (already used for portal password
  resets).
- *Optional:* a **Google Cloud** project, only if you want calendar
  busy-blocking + Google Meet links.

## Step 1 · Confirm the code is deployed

The repo auto-deploys on every merge to `main`. Check it:

- Open **dash.cloudflare.com** → **Workers & Pages** → **radiant-mpc-site**.
- Open the **Deployments** tab. You should see recent deployments matching your
  merges, the latest green.
- If deployments are **not** firing on merge, go to **Settings → Build** and
  confirm the connected repo is `radiantTAB/Radiant-mpc-site` on branch `main`.

**Manual alternative** (from your own computer, if you prefer):

```bash
git clone https://github.com/radiantTAB/Radiant-mpc-site.git
cd Radiant-mpc-site
npm install -g wrangler      # or use: npx wrangler ...
wrangler login               # authorizes your Cloudflare account
wrangler deploy              # bundles worker/index.js + uploads assets
```

## Step 2 · Set the secrets

Deploying the code does **not** set secrets. Set these on the Worker — in the
dashboard under **Settings → Variables and Secrets**, or via the CLI below. The
app only fully works once `MEETLY_ADMIN_TOKEN` and `RESEND_API_KEY` are set.

```bash
wrangler secret put MEETLY_ADMIN_TOKEN     # unlocks the admin console
wrangler secret put RESEND_API_KEY         # sends confirmation + reminder email

# Optional — only for Google Calendar / Meet:
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
```

| Secret | Required? | Purpose |
|--------|-----------|---------|
| `MEETLY_ADMIN_TOKEN` | For admin | Password for the admin console; admin is refused until it's set. |
| `RESEND_API_KEY` | For email | Confirmation + reminder emails (shared with the portal). |
| `GOOGLE_CLIENT_ID` | Optional | Google Calendar sync + Meet links. |
| `GOOGLE_CLIENT_SECRET` | Optional | Google Calendar sync + Meet links. |
| `MEETLY_BASE_URL` | Optional | Base URL in email links. Defaults to `https://radiant-mpc.com/calendly-clone`. |

> **⚠️ Keep these private** — The **admin token** is the only thing protecting
> your settings and bookings list; treat it like a password. The **calendar
> feed URL** also contains this token, so don't share it publicly.

## Step 3 · Confirm the database + cron

Two dashboard checks on the Worker (**Settings**):

- **Bindings** → a D1 binding named `DB` pointing at `radiant-licenses`.
  Meetly's tables create themselves on first request — nothing to run.
- **Triggers** → a Cron Trigger `*/15 * * * *` (every 15 minutes). This drives
  the reminder emails; confirm it's present after the deploy that added it.

## Step 4 · (Optional) Connect Google Calendar

Skip this unless you want Meetly to hide times you're busy and add a Google Meet
link to each booking.

1. In **console.cloud.google.com**, create an **OAuth 2.0 Client ID** (type:
   Web application).
2. Add the authorized redirect URI (exact string):
   ```
   https://radiant-mpc.com/api/meetly/oauth/google/callback
   ```
3. Enable the **Google Calendar API** for the project.
4. Set the `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` secrets (Step 2).
5. Open the admin console → **Google Calendar** card → **Connect**, and approve.

## Step 5 · Smoke-test the live site

Five minutes to prove it end-to-end:

- Visit `https://radiant-mpc.com/calendly-clone/booking.html` and make a test
  booking with a real email.
- Confirm the **confirmation email arrives** (check spam once).
- Open `https://radiant-mpc.com/calendly-clone/admin.html`, enter your
  `MEETLY_ADMIN_TOKEN`, and confirm the booking appears.
- In admin, try **Export CSV**, and open the booking's **Manage** link to test
  reschedule/cancel.
- If you connected Google: confirm the event appears on your calendar with a
  Meet link.

> **✅ You're live** — Once a booking creates a row in admin and an email lands
> in your inbox, the full path (booking → database → email → admin → feed) is
> working.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Admin page won't accept the token | The `MEETLY_ADMIN_TOKEN` secret isn't set (or is different). Set it in Step 2 and retry. |
| No confirmation email | `RESEND_API_KEY` not set, or the address bounced. Check the Worker logs (Deployments → Logs). |
| Bookings don't persist / disappear on refresh | The backend isn't reachable, so the site fell back to per-browser storage. Confirm the deploy succeeded and D1 is bound. |
| Reminders never send | The Cron Trigger isn't active. Confirm `*/15 * * * *` under Settings → Triggers. |
| Google connect fails | The redirect URI in Google must exactly match `https://radiant-mpc.com/api/meetly/oauth/google/callback`, and the Calendar API must be enabled. |

## Customizing later

- **Brand name** lives in the HTML.
- **Colors** in `calendly-clone/styles.css` (the `:root` block).
- **Default host, event types, and rules** at the top of `worker/meetly.js`
  (mirrored in `calendly-clone/store.js`).
- You can also change most of this from the admin console once you're live.

---

*Not affiliated with Calendly. "Meetly" is a placeholder brand for this personal
project. See [`README.md`](./README.md) for the full feature and architecture
reference.*
