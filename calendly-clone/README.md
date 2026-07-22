# Meetly — a Calendly-style scheduling app (personal clone)

A self-contained clone of a Calendly-style meeting-scheduling website, built
for **personal / learning use**. It runs with **no backend at all** (bookings
persist in the browser via `localStorage`) and **auto-upgrades to a real D1
backend** when the Cloudflare Worker is deployed — the front end never changes.

> Not affiliated with, endorsed by, or connected to Calendly. All copy, styling,
> and assets here are original. "Meetly" is a placeholder brand for the demo.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Marketing landing page. |
| `booking.html` | The public booking experience (mounts `app.js`). |
| `admin.html` | Admin / settings console (mounts `admin.js`). |
| `store.js` | Data layer — one interface, two backends (localStorage / API). |
| `app.js` | Booking flow logic. |
| `admin.js` | Settings + bookings management. |
| `styles.css` | All styling, light + dark themes. |

The backend lives with the rest of the site's Worker code:

| File | Purpose |
|------|---------|
| `../worker/meetly.js` | D1-backed API under `/api/meetly/*`. |
| `../worker/meetly.test.mjs` | Node test for the booking logic (`node worker/meetly.test.mjs`). |

## The booking flow (`booking.html`)

1. **Choose an event type** — 15-min intro, 30-min meeting, 60-min deep dive (editable).
2. **Pick a date** — month calendar highlights days with availability; past/off days disabled; keyboard-navigable (arrow keys).
3. **Pick a time** — slots come from the host's availability, the event duration, the **slot interval**, and a **buffer** kept free around existing bookings. Times are **converted to the visitor's timezone** (selector in the sidebar), with a `+1d/−1d` marker when the local day differs. Past times on the current day are hidden.
4. **Enter details** — name + email (validated) and optional notes.
5. **Confirmation** — summary with a confirmation code, an **Add to calendar** `.ics` download, and a **Manage booking** link.

**Manage / reschedule / cancel** — the confirmation's *Manage booking* link
(`booking.html?manage=<id>`) reopens a booking to **reschedule** (pick a new
time; the old slot is freed only after the new one is confirmed) or **cancel**
it (which frees the slot for others).

## Admin / settings (`admin.html`)

Opens on a **dashboard summary** — upcoming bookings, next-7-days, confirmed
total, cancellations, and a by-event-type breakdown (all computed from the
bookings list). Below it you can edit the **host** (name, title, initials,
timezone, notification email), **scheduling rules** (slot interval, buffer,
minimum notice, booking horizon, daily cap), **weekly availability** (per-day
time windows), **availability exceptions**, and **event types** (add / edit /
activate / remove), plus review and **cancel bookings**. Changes drive the
public booking page immediately.

The Bookings panel also offers **Export CSV** (all bookings, works in every
mode) and — when the backend is deployed — a **calendar subscription URL**.

### Calendar subscription feed

`GET /api/meetly/feed.ics?token=<admin-token>` returns a live iCal feed of
recent + upcoming bookings that the host can subscribe to in Google / Apple /
Outlook Calendar, so bookings show up on their own calendar automatically. The
token is passed in the URL (calendar clients can't send auth headers), so treat
the whole URL as a secret. The admin console shows the ready-made URL with a
copy button when running against the deployed backend.

### Availability exceptions (date overrides)

Override a specific date on top of the weekly schedule: **block** it entirely
(a holiday or day off) or set **custom hours** just for that day. An override
wins over the recurring weekly windows for that date. Enforced on the API and
the offline path, and reflected in the booking calendar (blocked dates are
disabled).

## Guardrails (public endpoint protection)

Because a scheduling link is public, `POST /bookings` is protected by:

- **Minimum notice** — slots too soon (default: within 120 min) are hidden and refused.
- **Booking horizon** — dates beyond N days out (default 60) are disabled.
- **Daily cap** — an optional per-day booking limit (0 = unlimited).
- **Per-IP rate limit** — at most 5 bookings per IP per rolling hour.
- **Honeypot** — a hidden `company` field; if a bot fills it, the request is silently ignored.

The first three are enforced on both the API and the offline localStorage path;
the rate limit and honeypot are server-side.

## Email (confirmations + reminders)

When deployed with a `RESEND_API_KEY` (the same secret the site's portal already
uses), booking sends a **confirmation email** to the invitee — with the `.ics`
attached and a manage/cancel link — plus a **notification** to the host's email
if one is set. A **Cloudflare Cron Trigger** (every 15 min, in `wrangler.jsonc`)
drives **reminder emails** ~24h and ~1h before each meeting, each sent once.
Mail failures never block a booking. With no `RESEND_API_KEY`, email is simply
skipped and everything else works.

## Storage: works now, scales later

`store.js` probes `GET /api/meetly/config` once on load:

- **No backend (default)** — falls back to **`localStorage`**. Bookings persist
  in that browser, slots are blocked so the same time can't be double-booked,
  and the admin page edits the local copy. Perfect for a personal, single-user
  link or a static host (GitHub Pages, etc.).
- **Worker deployed** — uses the **`/api/meetly/*` D1 API**, so bookings are
  shared across everyone and double-booking is prevented server-side.

Either way the app calls the same methods; it never knows which backend it's on.

## Deploying the real backend (optional)

The API is already wired into this repo's Worker (`worker/index.js` routes
`/api/meetly/*` to `worker/meetly.js`) and uses the existing `DB` D1 binding —
no new infrastructure. Tables are created on first use.

1. Deploy the Worker as usual (the repo is Git-connected to the
   `radiant-mpc-site` Worker).
2. To use the admin console against the live backend, set a secret:
   ```
   npx wrangler secret put MEETLY_ADMIN_TOKEN
   ```
   Then open `admin.html`, and enter that token when prompted. **If the secret
   is unset, the admin API is refused entirely** — an unconfigured deploy can
   never expose open settings writes. (The public booking endpoints stay open,
   as a scheduling link should.)
3. **Email (optional)** — set `RESEND_API_KEY` (already used by the site's
   portal) to turn on confirmation + reminder mail. Reminders run off the Cron
   Trigger declared in `wrangler.jsonc`. Optionally set `MEETLY_BASE_URL` (the
   public base URL of the `calendly-clone/` folder) so the manage/cancel links
   in emails are correct; it defaults to `https://radiant-mpc.com/calendly-clone`.

### Secrets / vars

| Name | Required | Purpose |
|------|----------|---------|
| `MEETLY_ADMIN_TOKEN` | for admin | Unlocks the admin API; admin refused when unset. |
| `RESEND_API_KEY` | for email | Enables confirmation + reminder mail (shared with the portal). |
| `MEETLY_BASE_URL` | optional | Base URL used in email links. |

Endpoints:

| Method + path | Auth | Purpose |
|---------------|------|---------|
| `GET /api/meetly/config` | public | Host, event types, availability. |
| `GET /api/meetly/slots?event=&date=` | public | Free slots for a day. |
| `POST /api/meetly/bookings` | public | Create a booking (re-validates the slot). |
| `GET /api/meetly/bookings/<id>` | public | Look up a booking. |
| `POST /api/meetly/bookings/<id>/cancel` | public | Cancel a booking. |
| `GET /api/meetly/admin/settings` | token | Read settings + all event types. |
| `PUT /api/meetly/admin/settings` | token | Update host / rules / availability. |
| `PUT /api/meetly/admin/events` | token | Replace the event-type set. |
| `GET /api/meetly/admin/bookings[?all=1]` | token | List bookings. |

The slot algorithm in `worker/meetly.js` (`computeSlots`) is mirrored in
`store.js` for the offline path; both are covered by `worker/meetly.test.mjs`.

## Customizing without the admin UI

Defaults live at the top of `worker/meetly.js` (`DEFAULT_SETTINGS`,
`DEFAULT_EVENT_TYPES`) and mirror `store.js`. `styles.css` `:root` holds the
palette; the brand name is in the HTML.

## Running locally

No build step. Open `calendly-clone/index.html` directly, or serve the folder:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/calendly-clone/
```

Run the backend test:

```bash
node worker/meetly.test.mjs
```
