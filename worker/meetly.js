// meetly.js — backend for the Meetly scheduling demo (calendly-clone/).
//
// A small, self-contained booking API mounted under /api/meetly/*. It is
// PUBLIC for reads and for creating/cancelling a booking (that's the whole
// point of a scheduling link), and gated by a bearer token for the admin
// settings writes (host details, event types, availability, rules).
//
// Storage is D1 (env.DB), three tables, all created on demand by
// ensureMeetlySchema so there is no separate migration step:
//   meetly_settings      one JSON row (host + availability + slot rules)
//   meetly_event_types   the bookable meeting types
//   meetly_bookings      confirmed bookings (soft-cancelled, never deleted)
//
// Guardrails (minimum notice, booking horizon, daily cap, per-IP rate limit,
// honeypot) protect the public endpoint. Confirmation mail goes out through
// Resend (reusing the RESEND_API_KEY secret the portal already uses); a Cron
// Trigger drives reminder mail via handleMeetlyReminders().
//
// The slot maths (computeSlots) and .ics/reminder selection are pure and
// covered by meetly.test.mjs. Actual mail delivery + cron firing only prove
// out on a real deploy.

import * as G from "./meetly-google.js";

const SETTINGS_ID = 1;
const MEETLY_FROM = "Meetly Scheduling <no-reply@send.radiant-mpc.com>";
const REMIND_24_MIN = 24 * 60; // send a reminder ~24h out
const REMIND_1_MIN = 60;       // and ~1h out
const RATE_MAX = 5;            // max bookings per IP per rolling hour
const RATE_WINDOW_MS = 60 * 60 * 1000;

// ---- Defaults seeded on first use (mirrors the front-end defaults) -------
const DEFAULT_SETTINGS = {
  host: { name: "Alex Lark", initials: "AL", title: "Product Advisor", timezone: "America/New_York", email: "" },
  slotStep: 30,        // minutes between slot starts
  buffer: 0,           // minutes kept free around each booking
  minNotice: 120,      // earliest a slot may be booked, minutes from now
  horizonDays: 60,     // furthest ahead a date may be booked
  dailyCap: 0,         // max bookings per day (0 = unlimited)
  webhookUrl: "",      // POST booking events here (Slack/Zapier/etc.)
  webhookSecret: "",   // sent as X-Meetly-Secret so the receiver can verify
  // Team members for round-robin / collective event types. Each is
  // { id, name, initials, email }. Availability + timezone are shared.
  team: [],
  // Date-specific exceptions keyed "YYYY-MM-DD". A value overrides that day's
  // weekly windows entirely; an empty array [] blocks the day (holiday/PTO).
  overrides: {},
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
      "description TEXT, location TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1, questions TEXT, hosts TEXT)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meetly_bookings (" +
      "id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL, " +
      "email TEXT NOT NULL, notes TEXT, date TEXT NOT NULL, " +
      "start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, tz TEXT, " +
      "created_at TEXT NOT NULL, canceled INTEGER DEFAULT 0, " +
      "ip TEXT, reminded_24 INTEGER DEFAULT 0, reminded_1 INTEGER DEFAULT 0, answers TEXT, host_id TEXT, meet_link TEXT)"
  ).run();
  // Self-healing: add newer columns if an older table exists.
  for (const col of ["ip TEXT", "reminded_24 INTEGER DEFAULT 0", "reminded_1 INTEGER DEFAULT 0", "answers TEXT", "host_id TEXT", "meet_link TEXT"]) {
    try { await env.DB.prepare("ALTER TABLE meetly_bookings ADD COLUMN " + col).run(); } catch (_) {}
  }
  for (const col of ["questions TEXT", "hosts TEXT"]) {
    try { await env.DB.prepare("ALTER TABLE meetly_event_types ADD COLUMN " + col).run(); } catch (_) {}
  }
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS meetly_google (id INTEGER PRIMARY KEY, refresh_token TEXT, calendar_id TEXT, email TEXT, connected_at TEXT, pending_state TEXT)"
  ).run();

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
  let s;
  if (!row) s = { ...DEFAULT_SETTINGS };
  else { try { s = JSON.parse(row.json); } catch (_) { s = { ...DEFAULT_SETTINGS }; } }
  // Fill any missing fields (settings rows saved by older versions).
  return {
    host: Object.assign({ timezone: "America/New_York", email: "" }, s.host),
    slotStep: s.slotStep != null ? s.slotStep : DEFAULT_SETTINGS.slotStep,
    buffer: s.buffer != null ? s.buffer : DEFAULT_SETTINGS.buffer,
    minNotice: s.minNotice != null ? s.minNotice : DEFAULT_SETTINGS.minNotice,
    horizonDays: s.horizonDays != null ? s.horizonDays : DEFAULT_SETTINGS.horizonDays,
    dailyCap: s.dailyCap != null ? s.dailyCap : DEFAULT_SETTINGS.dailyCap,
    webhookUrl: s.webhookUrl || "",
    webhookSecret: s.webhookSecret || "",
    team: Array.isArray(s.team) ? s.team : [],
    overrides: s.overrides && typeof s.overrides === "object" ? s.overrides : {},
    hours: s.hours || DEFAULT_SETTINGS.hours,
  };
}

// The availability windows in effect for a date: a date-specific override
// (which may be [] to block the day) wins over the weekly recurring hours.
function windowsFor(settings, date) {
  if (settings.overrides && Object.prototype.hasOwnProperty.call(settings.overrides, date)) {
    return settings.overrides[date] || [];
  }
  return (settings.hours && settings.hours[weekdayOf(date)]) || [];
}

async function readEventTypes(env) {
  const { results } = await env.DB.prepare(
    "SELECT id, name, duration, description, location, sort, questions, hosts FROM meetly_event_types WHERE active = 1 ORDER BY sort, name"
  ).all();
  return (results || []).map((e) => ({ ...e, questions: parseQuestions(e.questions), hosts: parseJsonArray(e.hosts) }));
}
function parseJsonArray(s) {
  try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
// The team members who can host an event type. Empty assignment (or no team)
// falls back to the primary host as a single pseudo-member with id "".
function eventMembers(settings, event) {
  const team = settings.team || [];
  const ids = event.hosts || [];
  const members = ids.map((id) => team.find((m) => m.id === id)).filter(Boolean);
  if (members.length) return members;
  const h = settings.host || {};
  return [{ id: "", name: h.name, initials: h.initials, email: h.email || "" }];
}
function memberById(settings, id) {
  const h = settings.host || {};
  if (!id) return { id: "", name: h.name, initials: h.initials, email: h.email || "" };
  const m = (settings.team || []).find((x) => x.id === id);
  return m || { id: "", name: h.name, initials: h.initials, email: h.email || "" };
}
function parseQuestions(s) {
  try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch (_) { return []; }
}
function parseAnswers(s) {
  try { const o = JSON.parse(s || "{}"); return o && typeof o === "object" ? o : {}; } catch (_) { return {}; }
}
function sanitizeQuestions(qs) {
  if (!Array.isArray(qs)) return [];
  const out = [];
  for (const q of qs) {
    const label = String((q && q.label) || "").trim().slice(0, 120);
    if (!label) continue;
    out.push({ label, type: q && q.type === "textarea" ? "textarea" : "text", required: !!(q && q.required) });
    if (out.length >= 10) break;
  }
  return out;
}
function sanitizeTeam(team, fallback) {
  if (!Array.isArray(team)) return fallback || [];
  const out = [];
  for (const m of team) {
    const name = String((m && m.name) || "").trim().slice(0, 80);
    if (!name) continue;
    let initials = String((m && m.initials) || "").trim().slice(0, 3).toUpperCase();
    if (!initials) initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
    const emailRaw = String((m && m.email) || "").trim().slice(0, 160);
    out.push({ id: String((m && m.id) || "").trim() || makeId("mem_"), name, initials, email: emailRaw && isEmail(emailRaw) ? emailRaw : "" });
    if (out.length >= 25) break;
  }
  return out;
}
function sanitizeHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  const out = [];
  for (const h of hosts) { const id = String(h || "").trim(); if (id && out.indexOf(id) === -1) out.push(id); }
  return out;
}

// ---------------------------------------------------- slot computation -----
// Pure function so it is unit-testable and identical to the browser copy.
// `date` is "YYYY-MM-DD"; `bookings` are that day's non-cancelled bookings.
// nowMs lets the minimum-notice rule (and tests) be deterministic.
export function computeSlots(settings, event, date, bookings, nowMs, busy) {
  const windows = windowsFor(settings, date);
  const step = settings.slotStep || 30;
  const buffer = settings.buffer || 0;
  const minNotice = settings.minNotice || 0;
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const now = nowMs != null ? nowMs : Date.now();
  const dur = event.duration;
  const members = eventMembers(settings, event);
  const taken = (bookings || []).filter((b) => !b.canceled);
  const ext = busy || []; // external (calendar) busy blocks, block every member
  const out = [];
  for (const w of windows) {
    const startMin = w[0] * 60;
    const endMin = w[1] * 60;
    for (let m = startMin; m + dur <= endMin; m += step) {
      const s = m;
      const e = m + dur;
      // Blocked entirely if it overlaps the host's external calendar busy time.
      if (ext.some((x) => s < x.end_min + buffer && x.start_min - buffer < e)) continue;
      // Offered if at least one assigned member is free — no booking of theirs
      // (matched by host_id) overlaps [s,e] expanded by the buffer.
      const anyFree = members.some((mem) =>
        !taken.some((b) => (b.host_id || "") === mem.id && s < b.end_min + buffer && b.start_min - buffer < e));
      if (!anyFree) continue;
      // Minimum notice: the slot's real instant must be far enough ahead.
      if (minNotice > 0) {
        const instant = hostInstant(date, s, tz);
        if (instant - now < minNotice * 60000) continue;
      }
      out.push({ start: s, end: e, label: minutesLabel(s) });
    }
  }
  return out;
}
// Choose which member gets a new booking: a free member, load-balanced
// (fewest bookings that day), stable by team order on ties.
export function assignMember(settings, event, start, end, dayBookings) {
  const buffer = settings.buffer || 0;
  const members = eventMembers(settings, event);
  const taken = (dayBookings || []).filter((b) => !b.canceled);
  const free = members.filter((mem) =>
    !taken.some((b) => (b.host_id || "") === mem.id && start < b.end_min + buffer && b.start_min - buffer < end));
  if (!free.length) return null;
  const loadOf = (mem) => taken.filter((b) => (b.host_id || "") === mem.id).length;
  free.sort((a, b) => loadOf(a) - loadOf(b));
  return free[0];
}

// Is `date` within [today, today+horizon] in the host timezone?
function withinHorizon(date, settings, nowMs) {
  const horizon = settings.horizonDays || 0;
  if (horizon <= 0) return true;
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const today = dateInZone(nowMs != null ? nowMs : Date.now(), tz);
  if (date < today) return false;
  const maxMs = hostInstant(today, 0, tz) + horizon * 86400000;
  const maxDate = dateInZone(maxMs, tz);
  return date <= maxDate;
}

function weekdayOf(dateStr) {
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

// ---- timezone: host wall-clock -> real UTC instant (mirrors the browser) --
function tzOffsetMinutes(tz, date) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = {};
  dtf.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
  const hour = p.hour === "24" ? 0 : parseInt(p.hour, 10);
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
  return (asUTC - date.getTime()) / 60000;
}
export function hostInstant(dateStr, minutes, tz) {
  const p = dateStr.split("-").map(Number);
  const guess = Date.UTC(p[0], p[1] - 1, p[2], Math.floor(minutes / 60), minutes % 60);
  const off = tzOffsetMinutes(tz, new Date(guess));
  let utc = guess - off * 60000;
  const off2 = tzOffsetMinutes(tz, new Date(utc));
  if (off2 !== off) utc = guess - off2 * 60000;
  return utc;
}
function dateInZone(utcMs, tz) {
  const p = {};
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(utcMs)).forEach((x) => { p[x.type] = x.value; });
  return p.year + "-" + p.month + "-" + p.day;
}
// Map Google busy periods (RFC3339 UTC instants) to host-local minute ranges
// for a single date, clamped to that day. Pure + unit-tested.
export function busyMinutes(busy, dateStr, tz) {
  const dayStart = hostInstant(dateStr, 0, tz);
  const dayEnd = dayStart + 1440 * 60000;
  const out = [];
  for (const b of busy || []) {
    const bs = Date.parse(b.start), be = Date.parse(b.end);
    if (isNaN(bs) || isNaN(be)) continue;
    const s = Math.max(dayStart, bs), e = Math.min(dayEnd, be);
    if (e <= s) continue;
    out.push({ start_min: Math.floor((s - dayStart) / 60000), end_min: Math.ceil((e - dayStart) / 60000) });
  }
  return out;
}
function humanDate(dateStr) {
  const p = dateStr.split("-").map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2])).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric", year: "numeric" });
}

function isValidDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function makeId(prefix) {
  const uuid = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, "")
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return prefix + uuid.slice(0, 12);
}

// ------------------------------------------------------------- .ics ---------
export function buildIcs(booking, settings, opts) {
  opts = opts || {};
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const startUtc = hostInstant(booking.date, booking.start_min, tz);
  const endUtc = hostInstant(booking.date, booking.end_min, tz);
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s) => String(s == null ? "" : s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const meet = booking.meet_link || "";
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Meetly//Scheduling//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    "BEGIN:VEVENT", "UID:" + booking.id + "@meetly", "DTSTAMP:" + z(opts.stampMs || startUtc),
    "DTSTART:" + z(startUtc), "DTEND:" + z(endUtc),
    "SUMMARY:" + esc((booking.event_name || booking.event_id) + " with " + settings.host.name),
    "DESCRIPTION:" + esc("Booked via Meetly." + (booking.notes ? " Notes: " + booking.notes : "") + (meet ? " Join: " + meet : "")),
    (booking.location || meet) ? "LOCATION:" + esc(booking.location || meet) : "",
    meet ? "URL:" + esc(meet) : "",
    "END:VEVENT", "END:VCALENDAR",
  ].filter(Boolean);
  return lines.join("\r\n");
}

// Multi-event VCALENDAR feed the host can subscribe to in their calendar app.
export function buildFeedIcs(bookings, events, settings) {
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const evById = {};
  (events || []).forEach((e) => { evById[e.id] = e; });
  const esc2 = (s) => String(s == null ? "" : s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const z = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Meetly//Feed//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Meetly bookings"];
  for (const b of bookings) {
    if (b.canceled) continue;
    const ev = evById[b.event_id] || { name: b.event_id, location: "" };
    const startUtc = hostInstant(b.date, b.start_min, tz);
    const endUtc = hostInstant(b.date, b.end_min, tz);
    out.push(
      "BEGIN:VEVENT", "UID:" + b.id + "@meetly", "DTSTAMP:" + z(startUtc),
      "DTSTART:" + z(startUtc), "DTEND:" + z(endUtc),
      "SUMMARY:" + esc2(ev.name + " — " + b.name),
      "DESCRIPTION:" + esc2((b.email || "") + (b.notes ? " · " + b.notes : "")),
      ev.location ? "LOCATION:" + esc2(ev.location) : "",
      "END:VEVENT"
    );
  }
  out.push("END:VCALENDAR");
  return out.filter(Boolean).join("\r\n");
}

// ------------------------------------------------------------- mail ---------
async function resendSend(env, payload) {
  if (!env.RESEND_API_KEY) return { ok: false, skipped: true };
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: "Bearer " + env.RESEND_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) { console.error("meetly mail failed:", res.status, await res.text().catch(() => "")); return { ok: false }; }
    return { ok: true };
  } catch (err) { console.error("meetly mail error:", String((err && err.message) || err)); return { ok: false }; }
}

function baseUrl(env) { return env.MEETLY_BASE_URL || "https://radiant-mpc.com/calendly-clone"; }

// ---- Google Calendar connection (single row) ----
async function readGoogle(env) {
  try { return await env.DB.prepare("SELECT * FROM meetly_google WHERE id = 1").first(); } catch (_) { return null; }
}
function googleConnected(row) { return !!(row && row.refresh_token); }

// Host's busy minute-ranges for a date, from Google (empty on any failure so
// an outage never blocks bookings — fail-open, documented in the README).
async function googleBusyFor(env, settings, dateStr) {
  if (!G.googleConfigured(env)) return [];
  const row = await readGoogle(env);
  if (!googleConnected(row)) return [];
  try {
    const tz = (settings.host && settings.host.timezone) || "America/New_York";
    const token = await G.accessToken(env, row.refresh_token);
    const minISO = new Date(hostInstant(dateStr, 0, tz)).toISOString();
    const maxISO = new Date(hostInstant(dateStr, 1440, tz)).toISOString();
    const busy = await G.freeBusy(token, row.calendar_id, minISO, maxISO);
    return busyMinutes(busy, dateStr, tz);
  } catch (err) {
    console.error("meetly google freebusy error:", String((err && err.message) || err));
    return [];
  }
}

// Create a Google Calendar event for a booking, requesting a Meet link.
// Returns the join URL (or "" if unavailable / not connected / on failure).
async function googleCreateEvent(env, settings, booking, event) {
  if (!G.googleConfigured(env)) return "";
  const row = await readGoogle(env);
  if (!googleConnected(row)) return "";
  try {
    const tz = (settings.host && settings.host.timezone) || "America/New_York";
    const token = await G.accessToken(env, row.refresh_token);
    const startUtc = hostInstant(booking.date, booking.start_min, tz);
    const endUtc = hostInstant(booking.date, booking.end_min, tz);
    const created = await G.insertEvent(token, row.calendar_id, {
      summary: (event.name || "Meeting") + " with " + booking.name,
      description: "Booked via Meetly." + (booking.notes ? " Notes: " + booking.notes : ""),
      location: event.location || "",
      start: { dateTime: new Date(startUtc).toISOString() },
      end: { dateTime: new Date(endUtc).toISOString() },
      attendees: [{ email: booking.email }],
      conferenceData: { createRequest: { requestId: makeId("mt_"), conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    return G.meetLinkFrom(created);
  } catch (err) {
    console.error("meetly google event error:", String((err && err.message) || err));
    return "";
  }
}

// Fire an outbound webhook for a booking lifecycle event. Fire-and-forget;
// failures are logged, never surfaced to the booker.
async function sendWebhook(settings, type, booking, event) {
  const urlStr = settings.webhookUrl;
  if (!urlStr || !/^https?:\/\//i.test(urlStr)) return { skipped: true };
  const payload = {
    type, // "booking.created" | "booking.cancelled"
    booking: {
      id: booking.id, event: booking.event_id, eventName: (event && event.name) || booking.event_id,
      name: booking.name, email: booking.email, date: booking.date,
      start: booking.start_min, end: booking.end_min, tz: booking.tz || "",
      notes: booking.notes || "", answers: booking.answers || {}, meetLink: booking.meet_link || "",
    },
  };
  const headers = { "content-type": "application/json", "user-agent": "Meetly-Webhook" };
  if (settings.webhookSecret) headers["x-meetly-secret"] = settings.webhookSecret;
  try {
    const res = await fetch(urlStr, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) console.error("meetly webhook non-2xx:", res.status);
    return { ok: res.ok };
  } catch (err) { console.error("meetly webhook error:", String((err && err.message) || err)); return { ok: false }; }
}

async function sendConfirmation(env, booking, settings, event) {
  const assigned = memberById(settings, booking.host_id || "");
  const hostName = assigned.name;
  const when = displayLine(booking, settings);
  const manage = baseUrl(env) + "/booking.html?manage=" + encodeURIComponent(booking.id);
  const ics = buildIcs({ ...booking, event_name: event.name, location: event.location }, settings, { stampMs: Date.now() });
  const icsB64 = b64(ics);
  const meet = booking.meet_link || "";
  const text =
    "Your meeting is booked.\n\n" +
    event.name + " with " + hostName + "\n" + when + "\n" +
    (event.location ? event.location + "\n" : "") +
    (meet ? "Join: " + meet + "\n" : "") +
    "\nManage or cancel: " + manage + "\n";
  const html =
    "<h2>You're booked</h2><p><strong>" + esc(event.name) + "</strong> with " + esc(hostName) + "</p>" +
    "<p>" + esc(when) + "<br>" + (event.location ? esc(event.location) : "") + "</p>" +
    (meet ? '<p><a href="' + esc(meet) + '">Join the video call</a></p>' : "") +
    '<p><a href="' + manage + '">Manage or cancel your booking</a></p>' +
    "<p>Added to your calendar? The invite is attached.</p>";
  const attachments = [{ filename: "meeting.ics", content: icsB64 }];

  // Invitee confirmation.
  await resendSend(env, { from: MEETLY_FROM, to: [booking.email], subject: "Confirmed: " + event.name + " with " + hostName, text, html, attachments });
  // Host notification — to the assigned member if they have an email, else the primary host.
  const notifyEmail = (assigned.email && isEmail(assigned.email)) ? assigned.email : (settings.host.email && isEmail(settings.host.email) ? settings.host.email : "");
  if (notifyEmail) {
    const ans = booking.answers && typeof booking.answers === "object" ? Object.entries(booking.answers) : [];
    const ansText = ans.length ? "\n" + ans.map(([k, v]) => k + ": " + v).join("\n") + "\n" : "";
    const ansHtml = ans.length ? "<ul>" + ans.map(([k, v]) => "<li><strong>" + esc(k) + ":</strong> " + esc(v) + "</li>").join("") + "</ul>" : "";
    await resendSend(env, {
      from: MEETLY_FROM, to: [notifyEmail],
      subject: "New booking: " + booking.name + " — " + event.name,
      text: booking.name + " (" + booking.email + ") booked " + event.name + "\n" + when + "\n" + (booking.notes ? "\nNotes: " + booking.notes + "\n" : "") + ansText + "\nManage: " + manage,
      html: "<p><strong>" + esc(booking.name) + "</strong> (" + esc(booking.email) + ") booked <strong>" + esc(event.name) + "</strong></p><p>" + esc(when) + "</p>" + (booking.notes ? "<p>Notes: " + esc(booking.notes) + "</p>" : "") + ansHtml,
      attachments,
    });
  }
}

function displayLine(booking, settings) {
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const utc = hostInstant(booking.date, booking.start_min, tz);
  const t = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(utc));
  const abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date(utc)).find((p) => p.type === "timeZoneName");
  return t + (abbr ? " " + abbr.value : "") + ", " + humanDate(booking.date);
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function b64(str) {
  if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
  return Buffer.from(str, "utf8").toString("base64");
}

// ---- reminders (driven by the Cron Trigger via handleMeetlyReminders) -----
// Exposed as a pure selector so tests can assert which bookings are due
// without touching the clock or the network.
export function dueReminders(bookings, settings, nowMs) {
  const tz = (settings.host && settings.host.timezone) || "America/New_York";
  const due = [];
  for (const b of bookings) {
    if (b.canceled) continue;
    const instant = hostInstant(b.date, b.start_min, tz);
    const minsAway = (instant - nowMs) / 60000;
    if (minsAway <= 0) continue;
    // Fire each reminder once, in a window so a periodic cron can't miss it.
    if (!b.reminded_24 && minsAway <= REMIND_24_MIN && minsAway > REMIND_1_MIN) due.push({ booking: b, kind: 24 });
    else if (!b.reminded_1 && minsAway <= REMIND_1_MIN) due.push({ booking: b, kind: 1 });
  }
  return due;
}

export async function handleMeetlyReminders(env, nowMs) {
  if (!env.DB) return { sent: 0 };
  await ensureMeetlySchema(env);
  const now = nowMs != null ? nowMs : Date.now();
  const settings = await readSettings(env);
  const events = await readEventTypes(env);
  const evById = {};
  events.forEach((e) => { evById[e.id] = e; });
  // Only future, non-cancelled, not-yet-fully-reminded bookings.
  const { results } = await env.DB.prepare(
    "SELECT * FROM meetly_bookings WHERE canceled = 0 AND (reminded_24 = 0 OR reminded_1 = 0)"
  ).all();
  const due = dueReminders(results || [], settings, now);
  let sent = 0;
  for (const item of due) {
    const b = item.booking;
    const event = evById[b.event_id] || { name: b.event_id, location: "" };
    const when = displayLine(b, settings);
    const manage = baseUrl(env) + "/booking.html?manage=" + encodeURIComponent(b.id);
    const label = item.kind === 24 ? "tomorrow" : "in about an hour";
    const r = await resendSend(env, {
      from: MEETLY_FROM, to: [b.email],
      subject: "Reminder: " + event.name + " " + label,
      text: "Reminder — your meeting is " + label + ".\n\n" + event.name + " with " + settings.host.name + "\n" + when + "\n" + (event.location ? event.location + "\n" : "") + "\nManage or cancel: " + manage,
      html: "<p>Reminder — your meeting is <strong>" + label + "</strong>.</p><p><strong>" + esc(event.name) + "</strong> with " + esc(settings.host.name) + "<br>" + esc(when) + "</p>" + (event.location ? "<p>" + esc(event.location) + "</p>" : "") + '<p><a href="' + manage + '">Manage or cancel</a></p>',
    });
    if (r.ok || r.skipped) {
      const col = item.kind === 24 ? "reminded_24" : "reminded_1";
      await env.DB.prepare("UPDATE meetly_bookings SET " + col + " = 1 WHERE id = ?").bind(b.id).run();
      if (r.ok) sent++;
    }
  }
  return { sent, due: due.length };
}

// ------------------------------------------------------------- routing -----
function json(data, status = 200, extra) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, extra || {}),
  });
}
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

export async function handleMeetlyApi(request, env, url, ctx) {
  if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
  await ensureMeetlySchema(env);
  const path = url.pathname;
  const method = request.method;

  // ---- Public: booking-side reads + writes ----

  if (path === "/api/meetly/config" && method === "GET") {
    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    // host.email is private — never exposed in the public config.
    const host = { name: settings.host.name, initials: settings.host.initials, title: settings.host.title, timezone: settings.host.timezone };
    const team = (settings.team || []).map((m) => ({ id: m.id, name: m.name, initials: m.initials })); // no emails
    return json({ host, team, slotStep: settings.slotStep, buffer: settings.buffer, minNotice: settings.minNotice, horizonDays: settings.horizonDays, overrides: settings.overrides, events });
  }

  // Host calendar subscription feed. Authenticated by a token in the URL
  // (calendar clients can't send Authorization headers). The whole URL is the
  // secret — same admin token, passed as ?token=.
  if (path === "/api/meetly/feed.ics" && method === "GET") {
    const token = url.searchParams.get("token") || "";
    if (!env.MEETLY_ADMIN_TOKEN || !timingSafeEqual(token, env.MEETLY_ADMIN_TOKEN)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    // Recent + upcoming, so the calendar isn't unbounded.
    const cutoff = dateInZone(Date.now() - 30 * 86400000, settings.host.timezone || "America/New_York");
    const { results } = await env.DB.prepare(
      "SELECT * FROM meetly_bookings WHERE canceled = 0 AND date >= ? ORDER BY date, start_min"
    ).bind(cutoff).all();
    const ics = buildFeedIcs(results || [], events, settings);
    return new Response(ics, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-cache" } });
  }

  // Google OAuth callback — Google redirects the browser here (public). The
  // state must match the pending value we stored when the admin started auth.
  if (path === "/api/meetly/oauth/google/callback" && method === "GET") {
    const code = url.searchParams.get("code") || "";
    const state = url.searchParams.get("state") || "";
    const dest = baseUrl(env) + "/admin.html";
    if (!G.googleConfigured(env)) return Response.redirect(dest + "?google=unconfigured", 302);
    const row = await readGoogle(env);
    if (!code || !state || !row || !row.pending_state || !timingSafeEqual(state, row.pending_state)) {
      return Response.redirect(dest + "?google=error", 302);
    }
    try {
      const tok = await G.exchangeCode(env, url, code);
      const email = tok.access_token ? await G.getEmail(tok.access_token) : "";
      // Keep any prior refresh_token if Google omits one on re-consent.
      const refresh = tok.refresh_token || row.refresh_token || "";
      await env.DB.prepare(
        "UPDATE meetly_google SET refresh_token = ?, email = ?, connected_at = ?, pending_state = NULL WHERE id = 1"
      ).bind(refresh, email, new Date().toISOString()).run();
      return Response.redirect(dest + "?google=connected", 302);
    } catch (err) {
      console.error("meetly google callback error:", String((err && err.message) || err));
      return Response.redirect(dest + "?google=error", 302);
    }
  }

  if (path === "/api/meetly/slots" && method === "GET") {
    const eventId = url.searchParams.get("event") || "";
    const date = url.searchParams.get("date") || "";
    if (!isValidDate(date)) return json({ error: "A valid date (YYYY-MM-DD) is required." }, 400);
    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    const event = events.find((e) => e.id === eventId);
    if (!event) return json({ error: "Unknown event type." }, 404);
    if (!withinHorizon(date, settings)) return json({ date, event: event.id, slots: [] });
    const { results } = await env.DB.prepare(
      "SELECT start_min, end_min, canceled, host_id FROM meetly_bookings WHERE date = ? AND canceled = 0"
    ).bind(date).all();
    if (settings.dailyCap > 0 && (results || []).length >= settings.dailyCap) {
      return json({ date, event: event.id, slots: [] });
    }
    const busy = await googleBusyFor(env, settings, date);
    const slots = computeSlots(settings, event, date, results || [], undefined, busy);
    return json({ date, event: event.id, slots });
  }

  if (path === "/api/meetly/bookings" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    // Honeypot: bots fill hidden fields. Real browsers leave it blank.
    if (String(body.company || "").trim()) return json({ ok: true, booking: null, ignored: true }, 200);

    const eventId = String(body.event || "").trim();
    const date = String(body.date || "").trim();
    const start = parseInt(body.start, 10);
    const name = String(body.name || "").trim().slice(0, 120);
    const email = String(body.email || "").trim().slice(0, 160);
    const notes = String(body.notes || "").trim().slice(0, 2000);
    const tz = String(body.tz || "").trim().slice(0, 64);

    if (!name) return json({ error: "Please enter your name." }, 400);
    if (!isEmail(email)) return json({ error: "Please enter a valid email address." }, 400);
    if (!isValidDate(date)) return json({ error: "A valid date is required." }, 400);
    if (!Number.isInteger(start)) return json({ error: "A valid start time is required." }, 400);

    const settings = await readSettings(env);
    const events = await readEventTypes(env);
    const event = events.find((e) => e.id === eventId);
    if (!event) return json({ error: "Unknown event type." }, 404);
    if (!withinHorizon(date, settings)) return json({ error: "That date is outside the booking window." }, 400);

    // Custom questions for this event type: validate required, collect answers.
    const answersIn = body.answers && typeof body.answers === "object" ? body.answers : {};
    const answers = {};
    for (const q of event.questions || []) {
      const v = String(answersIn[q.label] || "").trim().slice(0, 2000);
      if (q.required && !v) return json({ error: "Please answer: " + q.label }, 400);
      if (v) answers[q.label] = v;
    }

    // Per-IP rate limit over the last hour.
    const ip = request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for") || "";
    if (ip) {
      const sinceIso = new Date(Date.now() - RATE_WINDOW_MS).toISOString();
      const recent = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM meetly_bookings WHERE ip = ? AND created_at > ?"
      ).bind(ip, sinceIso).first();
      if (recent && recent.n >= RATE_MAX) {
        return json({ error: "Too many bookings from your connection. Please try again later." }, 429);
      }
    }

    const { results } = await env.DB.prepare(
      "SELECT start_min, end_min, canceled, host_id FROM meetly_bookings WHERE date = ? AND canceled = 0"
    ).bind(date).all();
    if (settings.dailyCap > 0 && (results || []).length >= settings.dailyCap) {
      return json({ error: "No more bookings are available on that day." }, 409);
    }
    const end = start + event.duration;
    // Re-check the host's external calendar so a slot that filled up on Google
    // between listing and booking is refused.
    const buffer = settings.buffer || 0;
    const busy = await googleBusyFor(env, settings, date);
    if (busy.some((x) => start < x.end_min + buffer && x.start_min - buffer < end)) {
      return json({ error: "That time is no longer available. Please pick another." }, 409);
    }
    // Pick a free team member (round-robin). Null means no capacity left.
    const member = assignMember(settings, event, start, end, results || []);
    if (!member) {
      return json({ error: "That time is no longer available. Please pick another." }, 409);
    }

    const id = makeId("ml_");
    const createdAt = new Date().toISOString();
    const answersJson = JSON.stringify(answers);
    await env.DB.prepare(
      "INSERT INTO meetly_bookings (id, event_id, name, email, notes, date, start_min, end_min, tz, created_at, canceled, ip, answers, host_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)"
    ).bind(id, event.id, name, email, notes, date, start, end, tz, createdAt, ip, answersJson, member.id).run();

    const bookingRow = { id, event_id: event.id, name, email, notes, date, start_min: start, end_min: end, tz, created_at: createdAt, answers, host_id: member.id };
    // Create the calendar event synchronously so a Meet link (if any) is ready
    // for the confirmation + email. Fail-open: no link on error / when off.
    let meetLink = "";
    try { meetLink = await googleCreateEvent(env, settings, bookingRow, event); } catch (_) {}
    if (meetLink) {
      bookingRow.meet_link = meetLink;
      try { await env.DB.prepare("UPDATE meetly_bookings SET meet_link = ? WHERE id = ?").bind(meetLink, id).run(); } catch (_) {}
    }
    // Fire-and-forget confirmation mail + webhook so neither blocks the response.
    const side = Promise.all([
      sendConfirmation(env, bookingRow, settings, event).catch(() => {}),
      sendWebhook(settings, "booking.created", bookingRow, event).catch(() => {}),
    ]);
    if (ctx && ctx.waitUntil) ctx.waitUntil(side); else await side;

    return json({
      ok: true,
      booking: {
        id, event: event.id, eventName: event.name, duration: event.duration,
        location: event.location, name, email, notes, date, start, end,
        label: minutesLabel(start), tz, created_at: createdAt, answers,
        host_id: member.id, hostName: member.name, meetLink,
      },
    }, 201);
  }

  const mGet = path.match(/^\/api\/meetly\/bookings\/([^/]+)$/);
  if (mGet && method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM meetly_bookings WHERE id = ?").bind(mGet[1]).first();
    if (!row) return json({ error: "No booking found with that code." }, 404);
    const settings = await readSettings(env);
    return json({ booking: bookingOut(row, settings) });
  }

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
    // Notify the webhook (if configured) that a booking was cancelled.
    const settings = await readSettings(env);
    if (settings.webhookUrl) {
      const row = await env.DB.prepare("SELECT * FROM meetly_bookings WHERE id = ?").bind(mCancel[1]).first();
      if (row) {
        row.answers = parseAnswers(row.answers);
        const hook = sendWebhook(settings, "booking.cancelled", row, null);
        if (ctx && ctx.waitUntil) ctx.waitUntil(hook); else await hook.catch(() => {});
      }
    }
    return json({ ok: true, id: mCancel[1], canceled: true });
  }

  // ---- Admin (token-gated) ----
  if (path.startsWith("/api/meetly/admin/")) {
    if (!adminOk(request, env)) return json({ error: "Admin access requires a valid token." }, 401);

    if (path === "/api/meetly/admin/settings" && method === "GET") {
      const settings = await readSettings(env);
      const { results } = await env.DB.prepare(
        "SELECT id, name, duration, description, location, sort, active, questions, hosts FROM meetly_event_types ORDER BY sort, name"
      ).all();
      const evs = (results || []).map((e) => ({ ...e, questions: parseQuestions(e.questions), hosts: parseJsonArray(e.hosts) }));
      return json({ settings, events: evs });
    }

    if (path === "/api/meetly/admin/settings" && method === "PUT") {
      const body = await request.json().catch(() => ({}));
      const current = await readSettings(env);
      const next = {
        host: sanitizeHost(body.host, current.host),
        slotStep: clampInt(body.slotStep, 5, 240, current.slotStep),
        buffer: clampInt(body.buffer, 0, 240, current.buffer),
        minNotice: clampInt(body.minNotice, 0, 43200, current.minNotice),
        horizonDays: clampInt(body.horizonDays, 1, 730, current.horizonDays),
        dailyCap: clampInt(body.dailyCap, 0, 100, current.dailyCap),
        webhookUrl: sanitizeUrl(body.webhookUrl, current.webhookUrl),
        webhookSecret: String(body.webhookSecret != null ? body.webhookSecret : current.webhookSecret || "").trim().slice(0, 200),
        team: sanitizeTeam(body.team, current.team),
        overrides: sanitizeOverrides(body.overrides, current.overrides),
        hours: sanitizeHours(body.hours, current.hours),
      };
      await env.DB.prepare("UPDATE meetly_settings SET json = ? WHERE id = ?")
        .bind(JSON.stringify(next), SETTINGS_ID).run();
      return json({ ok: true, settings: next });
    }

    if (path === "/api/meetly/admin/events" && method === "PUT") {
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
          questions: sanitizeQuestions(e.questions),
          hosts: sanitizeHosts(e.hosts),
        });
      }
      if (!clean.length) return json({ error: "Keep at least one event type." }, 400);
      await env.DB.prepare("DELETE FROM meetly_event_types").run();
      for (const e of clean) {
        await env.DB.prepare(
          "INSERT INTO meetly_event_types (id, name, duration, description, location, sort, active, questions, hosts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(e.id, e.name, e.duration, e.description, e.location, e.sort, e.active, JSON.stringify(e.questions), JSON.stringify(e.hosts)).run();
      }
      return json({ ok: true, events: clean });
    }

    if (path === "/api/meetly/admin/google/status" && method === "GET") {
      const row = await readGoogle(env);
      return json({ configured: G.googleConfigured(env), connected: googleConnected(row), email: (row && row.email) || "", calendarId: (row && row.calendar_id) || "primary" });
    }

    // Start OAuth: store a fresh state, hand back the consent URL.
    if (path === "/api/meetly/admin/google/auth" && method === "GET") {
      if (!G.googleConfigured(env)) return json({ error: "Google is not configured (set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)." }, 400);
      const state = makeId("st_");
      const row = await readGoogle(env);
      if (row) await env.DB.prepare("UPDATE meetly_google SET pending_state = ? WHERE id = 1").bind(state).run();
      else await env.DB.prepare("INSERT INTO meetly_google (id, calendar_id, pending_state) VALUES (1, 'primary', ?)").bind(state).run();
      return json({ url: G.googleAuthUrl(env, url, state) });
    }

    if (path === "/api/meetly/admin/google/disconnect" && method === "POST") {
      await env.DB.prepare("DELETE FROM meetly_google WHERE id = 1").run();
      return json({ ok: true, connected: false });
    }

    if (path === "/api/meetly/admin/bookings" && method === "GET") {
      const includeCanceled = url.searchParams.get("all") === "1";
      const q = includeCanceled
        ? "SELECT * FROM meetly_bookings ORDER BY date DESC, start_min DESC"
        : "SELECT * FROM meetly_bookings WHERE canceled = 0 ORDER BY date DESC, start_min DESC";
      const { results } = await env.DB.prepare(q).all();
      const settings = await readSettings(env);
      return json({ bookings: (results || []).map((row) => bookingOut(row, settings)) });
    }

    return json({ error: "Not found." }, 404);
  }

  return json({ error: "Not found." }, 404);
}

function bookingOut(row, settings) {
  return {
    id: row.id, event: row.event_id, name: row.name, email: row.email,
    notes: row.notes || "", date: row.date, start: row.start_min, end: row.end_min,
    label: minutesLabel(row.start_min), tz: row.tz || "", created_at: row.created_at,
    canceled: !!row.canceled, answers: parseAnswers(row.answers),
    host_id: row.host_id || "", hostName: settings ? memberById(settings, row.host_id || "").name : undefined,
    meetLink: row.meet_link || "",
  };
}

function sanitizeHost(host, fallback) {
  host = host || {};
  const name = String(host.name || fallback.name || "Host").trim().slice(0, 80) || "Host";
  let initials = String(host.initials || "").trim().slice(0, 3).toUpperCase();
  if (!initials) initials = name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const timezone = String(host.timezone || fallback.timezone || "America/New_York").trim().slice(0, 64) || "America/New_York";
  const emailRaw = String(host.email || "").trim().slice(0, 160);
  const email = emailRaw && isEmail(emailRaw) ? emailRaw : "";
  return { name, initials, title: String(host.title || fallback.title || "").trim().slice(0, 120), timezone, email };
}
function sanitizeUrl(v, fallback) {
  const s = String(v != null ? v : "").trim().slice(0, 500);
  if (!s) return v != null ? "" : (fallback || ""); // explicit empty clears it
  return /^https?:\/\//i.test(s) ? s : (fallback || "");
}
function sanitizeOverrides(ov, fallback) {
  if (!ov || typeof ov !== "object") return fallback || {};
  const out = {};
  for (const [date, windows] of Object.entries(ov)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const ws = Array.isArray(windows) ? windows : [];
    // Empty array is kept intentionally — it blocks the day.
    out[date] = ws.map((w) => [clampInt(w[0], 0, 24, 0), clampInt(w[1], 0, 24, 0)]).filter((w) => w[1] > w[0]);
  }
  return out;
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
