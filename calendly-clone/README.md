# Meetly — a Calendly-style scheduling app (personal clone)

A self-contained, static clone of a Calendly-style meeting-scheduling website,
built for **personal / learning use**. No build step, no dependencies, no
backend — just open the HTML files in a browser.

> Not affiliated with, endorsed by, or connected to Calendly. All copy, styling,
> and assets here are original. "Meetly" is a placeholder brand for the demo.

## What's inside

| File | Purpose |
|------|---------|
| `index.html` | Marketing landing page — hero, features, how-it-works, pricing, footer. |
| `booking.html` | The scheduling experience (mounts the app). |
| `app.js` | The full booking flow logic (vanilla JS, no libraries). |
| `styles.css` | All styling for both pages. |

## The booking flow

`booking.html` reproduces the core Calendly experience entirely client-side:

1. **Choose an event type** — 15-min intro, 30-min meeting, or 60-min deep dive.
2. **Pick a date** — a month calendar highlights days that have open slots;
   past days and days off are disabled. Navigate months with ‹ / ›.
3. **Pick a time** — time slots are generated from the host's business hours and
   the selected event's duration. Some slots are deterministically marked
   "busy" so availability looks realistic; past times on the current day are
   hidden. Click a slot, then **Next** (Calendly-style two-tap confirm).
4. **Enter details** — name + email (validated) and optional notes.
5. **Confirmation** — a success screen with a booking summary and confirmation
   code, plus "book another meeting".

Everything runs in memory — nothing is sent anywhere, and there's no persistence.

## Customizing

Open `app.js` and edit the data near the top:

- `HOST` — name, initials, title (timezone is auto-detected from the browser).
- `EVENT_TYPES` — add/remove meeting types, change durations and locations.
- `HOURS` — weekly availability windows per weekday (`[startHour, endHour]`,
  24-hour clock). An empty array means a day off.
- `SLOT_STEP` — minutes between slot start times.

Branding (name, colors) lives in `styles.css` (`:root` variables) and the
markup in `index.html` / `booking.html`.

## Running it

No server needed:

```bash
# just open the file
open calendly-clone/index.html      # macOS
xdg-open calendly-clone/index.html  # Linux
```

Or serve the folder statically if you prefer:

```bash
python3 -m http.server 8000
# then visit http://localhost:8000/calendly-clone/
```
