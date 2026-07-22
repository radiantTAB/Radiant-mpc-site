// meetly.js — backend for the Meetly scheduling demo (calendly-clone/).
//
// A small, self-contained booking API mounted under /api/meetly/*. It is
// PUBLIC for reads and for creating/cancelling a booking (that's the whole
// point of a scheduling link), and gated by a bearer token for the admin
// settings writes (host details, event types, availability).
//
// Storage is D1 (env.DB), three tables, all created on demand by
// ensureMeetlySchema so there is no separate migration step:
//   meetly_settings      one JSON row (host + availability + slot rules)
//   meetly_event_types   the bookable meeting types
//   meetly_bookings      confirmed bookings (soft-cancelled, never deleted)
//
// The slot maths (slotsForDate / booking validation) live here so the
// server is the source of truth; the browser mirrors the same algorithm
// for its offline localStorage mode. Both are covered by meetly.test.mjs.

const SETTINGS_ID = 1;

// ---- Defaults seeded on first use (mirrors the front-end defaults) -------
const DEFAULT_SETTINGS = {
  host: { name: "Alex Lark", initials: "AL", title: "Product Advisor", timezone: "America/New_York" },
  slotStep: 30, // minutes between slot starts
  buffer: 0, // minutes of padding kept free around each booking
  // Weekly availability. Keys are weekday numbers (0=Sun..6=Sat); each is a
  // list of [startHour, endHour] windows in the host's local clock.
  hours: {
    0: [],
    1: [[9, 12], [13, 17]],
    2: [[9, 12], [13, 17]],
    3: [[9, 12], [13, 17]],
    4: [[9, 12], [13, 17]],
    5: [[9, 12], [13, 16]],
    6: [],
  },
};

const DEFAULT_EVENT_TYPES = [
  { id: "intro-15", name: "15 Minute Intro Call", duration: 15, description: "A quick introduction to see if we're a good fit.", location: "Google Meet (link sent after booking)", sort: 0 },
  { id: "meeting-30", name: "30 Minute Meeting", duration: 30, description: "A focused conversation about your project or question.", location: "Zoom (link sent after booking)", sort: 1 },
  { id: "deep-60", name: "60 Minute Deep Dive", duration: 60, description: "An in-depth working session. Bring your questions.", location: "Phone call", sort: 2 },
];

// ---------------------------------------------------------------- schema ---
let _meetlySchemaEnsured = false;
export async function ensureMeetlySchema(env) {
  if (_meetlySchemaEnsured || !env.DB) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meetly_settings (id INTEGER PRIMARY KEY, json TEXT NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meetly_event_types (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, duration INTEGER NOT NULL, " +
      "description TEXT, location TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meetly_bookings (" +
      "id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL, " +
      "email TEXT NOT NULL, notes TEXT, date TEXT NOT NULL, " +
      "start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, tz TEXT, " +
      "created_at TEXT NOT NULL, canceled INTEGER DEFAULT 0)"
  ).run();

  // Seed settings + event types the first time only.
  const s = await env.DB.prepare("SELECT id FROM meetly_settings WHERE id = ?").bind(SETTINGS_ID).first();
  if (!s) {
    await env.DB.prepare("INSERT INTO meetly_settings (id, json) VALUES (?, ?)")
      .bind(SETTINGS_ID, JSON.stringify(DEFAULT_SETTINGS)).run();
  }
  const anyType = await env.DB.prepare("SELECT id FROM meetly_event_types LIMIT 1").first();
  if (!anyType) {
    for (const e of DEFAULT_EVENT_TYPES) {
      await env.DB.prepare(
        "INSERT INTO meetly_event_types (id, name, duration, description, location, sort, active) VALUES (?, ?, ?, ?, ?, ?, 1)"
      ).bind(e.id, e.name, e.duration, e.description, e.location, e.sort).run();
    }
  }
  _meetlySchemaEnsured = true;
}

async function readSettings(env) {
  const row = await env.DB.prepare("SELECT json FROM meetly_settings WHERE id = ?").bind(SETTINGS_ID).first();
  if (!row) return { ...DEFAULT_SETTINGS };
  try { return JSON.parse(row.json); } catch (_) { return { ...DEFAULT_SETTINGS }; }
}

async function readEventTypes(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, duration, description, location, sort FROM meetly_event_types WHERE active = 1 ORDER BY sort, name"
  ).all();
  return results || [];
}

// ---------------------------------------------------- slot computation -----
// Pure function so it is unit-testable and identical to the browser copy.
// `date` is a "YYYY-MM-DD" string; returns [{start, end, label}] in host
// local clock minutes. `bookings` are that day's non-cancelled bookings.
export function computeSlots(settings, event, date, bookings) {
  const weekday = weekdayOf(date);
  const windows = (settings.hours && settings.hours[weekday]) || [];
  const step = settings.slotStep || 30;
  const buffer = settings.buffer || 0;
  const dur = event.duration;
  const taken = (bookings || []).filter((b) => !b.canceled);
  const out = [];
  for (const w of windows) {
    const startMin = w[0] * 60;
    const endMin = w[1] * 60;
    for (let m = startMin; m + dur <= endMin; m += step) {
      const s = m;
      const e = m + dur;
      // Conflict if the [s,e] interval overlaps any booking expanded by buffer.
      const clash = taken.some((b) => s < b.end_min + buffer && b.start_min - buffer < e);
      if (clash) continue;
      out.push({ start: s, end: e, label: minutesLabel(s) });
    }
  }
  return out;
}

function weekdayOf(dateStr) {
  // Parse as a plain calendar date (no timezone shifting).
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

function minutesLabel(min) {
  let h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + (m === 0 ? "00" : String(m).padStart(2, "0")) + ampm;
}

function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

function makeId(prefix) {
  // Random, URL-safe id. crypto.randomUUID exists in Workers and Node 18+.
  const uuid = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + uuid.slice(0, 12);
}

// ------------------------------------------------------------- routing -----
function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extra || {}),
  });
}

// Admin writes require the shared bearer token when one is configured.
// If MEETLY_ADMIN_TOKEN is unset the admin API is refused entirely (the
// operator manages the demo from the browser's localStorage instead),
// so an unconfigured deploy can never expose open settings writes.
function adminOk(request, env) {
  const token = env && env.MEETLY_ADMIN_TOKEN;
  if (!token) return false;
  const hdr = request.headers.get("authorization") || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  return !!m && timingSafeEqual(m[1], token);
}

function timingSafeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function handleMeetlyApi(request, env, url) {
  if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
  await ensureMeetlySchema(env);
  const path = url.pathname;
  const method = request.method;

  // ---- Public: booking-side reads + writes ----

  // GET /api/meetly/config — host, active event types, availability rules.
  if (path === "/api/meetly/config" && method === "GET") {
    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    return json({ host: settings.host, slotStep: settings.slotStep, buffer: settings.buffer, hours: settings.hours, events });
  }

  // GET /api/meetly/slots?event=<id>&date=<YYYY-MM-DD>
  if (path === "/api/meetly/slots" && method === "GET") {
    const eventId = url.searchParams.get("event") || "";
    const date = url.searchParams.get("date") || "";
    if (!isValidDate(date)) return json({ error: "A valid date (YYYY-MM-DD) is required." }, 400);
    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    const event = events.find((e) => e.id === eventId);
    if (!event) return json({ error: "Unknown event type." }, 404);
    const { results } = await env.DB.prepare(
      "SELECT start_min, end_min, canceled FROM meetly_bookings WHERE event_id IS NOT NULL AND date = ? AND canceled = 0"
    ).bind(date).all();
    const slots = computeSlots(settings, event, date, results || []);
    return json({ date, event: event.id, slots });
  }

  // POST /api/meetly/bookings — create a booking (re-validates the slot).
  if (path === "/api/meetly/bookings" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const eventId = String(body.event || "").trim();
    const date = String(body.date || "").trim();
    const start = parseInt(body.start, 10);
    const name = String(body.name || "").trim();
    const email = String(body.email || "").trim();
    const notes = String(body.notes || "").trim();
    const tz = String(body.tz || "").trim().slice(0, 64);

    if (!name) return json({ error: "Please enter your name." }, 400);
    if (!isEmail(email)) return json({ error: "Please enter a valid email address." }, 400);
    if (!isValidDate(date)) return json({ error: "A valid date is required." }, 400);
    if (!Number.isInteger(start)) return json({ error: "A valid start time is required." }, 400);

    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    const event = events.find((e) => e.id === eventId);
    if (!event) return json({ error: "Unknown event type." }, 404);

    const { results } = await env.DB.prepare(
      "SELECT start_min, end_min, canceled FROM meetly_bookings WHERE date = ? AND canceled = 0"
    ).bind(date).all();
    const free = computeSlots(settings, event, date, results || []);
    if (!free.some((s) => s.start === start)) {
      return json({ error: "That time was just taken. Please pick another." }, 409);
    }

    const id = makeId("ml_");
    const end = start + event.duration;
    const createdAt = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO meetly_bookings (id, event_id, name, email, notes, date, start_min, end_min, tz, created_at, canceled) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)"
    ).bind(id, event.id, name, email, notes, date, start, end, tz, createdAt).run();

    return json({
      ok: true,
      booking: {
        id, event: event.id, eventName: event.name, duration: event.duration,
        location: event.location, name, email, notes, date, start, end,
        label: minutesLabel(start), tz, created_at: createdAt,
      },
    }, 201);
  }

  // GET /api/meetly/bookings/<id> — look up one booking (for manage/cancel).
  const mGet = path.match(/^\/api\/meetly\/bookings\/([^/]+)$/);
  if (mGet && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM meetly_bookings WHERE id = ?").bind(mGet[1]).first();
    if (!row) return json({ error: "No booking found with that code." }, 404);
    return json({ booking: bookingOut(row) });
  }

  // POST /api/meetly/bookings/<id>/cancel — soft-cancel, freeing the slot.
  const mCancel = path.match(/^\/api\/meetly\/bookings\/([^/]+)\/cancel$/);
  if (mCancel && method === "POST") {
    const res = await env.DB.prepare(
      "UPDATE meetly_bookings SET canceled = 1 WHERE id = ? AND canceled = 0"
    ).bind(mCancel[1]).run();
    const changes = res && res.meta ? res.meta.changes : undefined;
    if (changes === 0) {
      const exists = await env.DB.prepare("SELECT id FROM meetly_bookings WHERE id = ?").bind(mCancel[1]).first();
      if (!exists) return json({ error: "No booking found with that code." }, 404);
      return json({ ok: true, id: mCancel[1], canceled: true, already: true });
    }
    return json({ ok: true, id: mCancel[1], canceled: true });
  }

  // ---- Admin: settings + event types + booking list (token-gated) ----
  if (path.startsWith("/api/meetly/admin/")) {
    if (!adminOk(request, env)) {
      return json({ error: "Admin access requires a valid token." }, 401);
    }

    if (path === "/api/meetly/admin/settings" && method === "GET") {
      const settings = await readSettings(env);
      const { results } = await env.DB.prepare(
        "SELECT id, name, duration, description, location, sort, active FROM meetly_event_types ORDER BY sort, name"
      ).all();
      return json({ settings, events: results || [] });
    }

    if (path === "/api/meetly/admin/settings" && method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const current = await readSettings(env);
      const next = {
        host: sanitizeHost(body.host, current.host),
        slotStep: clampInt(body.slotStep, 5, 240, current.slotStep),
        buffer: clampInt(body.buffer, 0, 240, current.buffer),
        hours: sanitizeHours(body.hours, current.hours),
      };
      await env.DB.prepare("UPDATE meetly_settings SET json = ? WHERE id = ?")
        .bind(JSON.stringify(next), SETTINGS_ID).run();
      return json({ ok: true, settings: next });
    }

    if (path === "/api/meetly/admin/events" && method === "PUT") {
      // Replace the whole event-type set with the supplied list.
      const body = await request.json().catch(() => ({}));
      const list = Array.isArray(body.events) ? body.events : [];
      const clean = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i] || {};
        const name = String(e.name || "").trim();
        const duration = clampInt(e.duration, 5, 480, 30);
        if (!name) continue;
        clean.push({
          id: String(e.id || "").trim() || makeId("evt_"),
          name, duration,
          description: String(e.description || "").trim(),
          location: String(e.location || "").trim(),
          sort: i,
          active: e.active === false ? 0 : 1,
        });
      }
      if (!clean.length) return json({ error: "Keep at least one event type." }, 400);
      await env.DB.prepare("DELETE FROM meetly_event_types").run();
      for (const e of clean) {
        await env.DB.prepare(
          "INSERT INTO meetly_event_types (id, name, duration, description, location, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(e.id, e.name, e.duration, e.description, e.location, e.sort, e.active).run();
      }
      return json({ ok: true, events: clean });
    }

    if (path === "/api/meetly/admin/bookings" && method === "GET") {
      const includeCanceled = url.searchParams.get("all") === "1";
      const q = includeCanceled
        ? "SELECT * FROM meetly_bookings ORDER BY date DESC, start_min DESC"
        : "SELECT * FROM meetly_bookings WHERE canceled = 0 ORDER BY date DESC, start_min DESC";
      const { results } = await env.DB.prepare(q).all();
      return json({ bookings: (results || []).map(bookingOut) });
    }

    return json({ error: "Not found." }, 404);
  }

  return json({ error: "Not found." }, 404);
}

function bookingOut(row) {
  return {
    id: row.id, event: row.event_id, name: row.name, email: row.email,
    notes: row.notes || "", date: row.date, start: row.start_min, end: row.end_min,
    label: minutesLabel(row.start_min), tz: row.tz || "", created_at: row.created_at,
    canceled: !!row.canceled,
  };
}

function sanitizeHost(host, fallback) {
  host = host || {};
  const name = String(host.name || fallback.name || "Host").trim().slice(0, 80) || "Host";
  let initials = String(host.initials || "").trim().slice(0, 3).toUpperCase();
  if (!initials) initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const timezone = String(host.timezone || fallback.timezone || "America/New_York").trim().slice(0, 64) || "America/New_York";
  return { name, initials, title: String(host.title || fallback.title || "").trim().slice(0, 120), timezone };
}

function sanitizeHours(hours, fallback) {
  if (!hours || typeof hours !== "object") return fallback;
  const out = {};
  for (let d = 0; d <= 6; d++) {
    const windows = Array.isArray(hours[d]) ? hours[d] : [];
    out[d] = windows
      .map((w) => [clampInt(w[0], 0, 24, 0), clampInt(w[1], 0, 24, 0)])
      .filter((w) => w[1] > w[0]);
  }
  return out;
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isInteger(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
