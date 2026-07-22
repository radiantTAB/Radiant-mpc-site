// Self-check for the Meetly scheduling backend: `node worker/meetly.test.mjs`
// Drives the real handlers against an in-memory D1 mock — no network, no
// wrangler. Covers slots, buffers, double-booking, cancel, admin gating,
// guardrails (min-notice / horizon / daily cap), honeypot, rate limiting,
// .ics generation, and reminder selection + sending (Resend fetch mocked).
import assert from "node:assert";
import { handleMeetlyApi, computeSlots, ensureMeetlySchema, hostInstant, buildIcs, dueReminders, handleMeetlyReminders } from "./meetly.js";

// ---- Minimal in-memory D1 mock (only the queries meetly.js issues) --------
function makeDb() {
  const state = { settings: null, events: [], bookings: [] };

  function exec(sql, a) {
    a = a || [];
    if (/^\s*CREATE TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };
    if (/^\s*ALTER TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };

    if (/SELECT id FROM meetly_settings/.test(sql)) return { _first: state.settings ? { id: 1 } : null };
    if (/INSERT INTO meetly_settings/.test(sql)) { state.settings = { id: a[0], json: a[1] }; return { _run: { meta: { changes: 1 } } }; }
    if (/SELECT json FROM meetly_settings/.test(sql)) return { _first: state.settings ? { json: state.settings.json } : null };
    if (/UPDATE meetly_settings SET json/.test(sql)) { state.settings.json = a[0]; return { _run: { meta: { changes: 1 } } }; }

    if (/SELECT id FROM meetly_event_types LIMIT 1/.test(sql)) return { _first: state.events[0] || null };
    if (/INSERT INTO meetly_event_types/.test(sql)) {
      state.events.push({ id: a[0], name: a[1], duration: a[2], description: a[3], location: a[4], sort: a[5], active: a[6] === undefined ? 1 : a[6] });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM meetly_event_types/.test(sql)) { const n = state.events.length; state.events = []; return { _run: { meta: { changes: n } } }; }
    if (/SELECT id, name, duration, description, location, sort FROM meetly_event_types WHERE active = 1/.test(sql))
      return { _all: state.events.filter((e) => e.active === 1).sort(bySort) };
    if (/SELECT id, name, duration, description, location, sort, active FROM meetly_event_types/.test(sql))
      return { _all: [...state.events].sort(bySort) };

    if (/INSERT INTO meetly_bookings/.test(sql)) {
      state.bookings.push({ id: a[0], event_id: a[1], name: a[2], email: a[3], notes: a[4], date: a[5], start_min: a[6], end_min: a[7], tz: a[8], created_at: a[9], canceled: 0, ip: a[10], reminded_24: 0, reminded_1: 0 });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/SELECT COUNT\(\*\) AS n FROM meetly_bookings WHERE ip = \? AND created_at > \?/.test(sql)) {
      const n = state.bookings.filter((b) => b.ip === a[0] && b.created_at > a[1]).length;
      return { _first: { n } };
    }
    if (/SELECT start_min, end_min, canceled FROM meetly_bookings.*date = \?/s.test(sql))
      return { _all: state.bookings.filter((b) => b.date === a[0] && b.canceled === 0) };
    if (/UPDATE meetly_bookings SET canceled = 1 WHERE id = \? AND canceled = 0/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[0] && x.canceled === 0);
      if (b) { b.canceled = 1; return { _run: { meta: { changes: 1 } } }; }
      return { _run: { meta: { changes: 0 } } };
    }
    if (/UPDATE meetly_bookings SET reminded_24 = 1 WHERE id = \?/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[0]); if (b) b.reminded_24 = 1; return { _run: { meta: { changes: 1 } } };
    }
    if (/UPDATE meetly_bookings SET reminded_1 = 1 WHERE id = \?/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[0]); if (b) b.reminded_1 = 1; return { _run: { meta: { changes: 1 } } };
    }
    if (/SELECT \* FROM meetly_bookings WHERE canceled = 0 AND \(reminded_24 = 0 OR reminded_1 = 0\)/.test(sql))
      return { _all: state.bookings.filter((b) => b.canceled === 0 && (b.reminded_24 === 0 || b.reminded_1 === 0)) };
    if (/SELECT id FROM meetly_bookings WHERE id = \?/.test(sql))
      return { _first: state.bookings.find((b) => b.id === a[0]) ? { id: a[0] } : null };
    if (/SELECT \* FROM meetly_bookings WHERE id = \?/.test(sql))
      return { _first: state.bookings.find((b) => b.id === a[0]) || null };
    if (/SELECT \* FROM meetly_bookings ORDER BY/.test(sql)) return { _all: [...state.bookings] };
    if (/SELECT \* FROM meetly_bookings WHERE canceled = 0 ORDER BY/.test(sql)) return { _all: state.bookings.filter((b) => b.canceled === 0) };

    throw new Error("unhandled SQL: " + sql);
  }
  function bySort(a, b) { return (a.sort - b.sort) || String(a.name).localeCompare(b.name); }

  const DB = {
    prepare: (sql) => {
      const terminal = (args) => ({
        first: async () => { const r = exec(sql, args); return "_first" in r ? r._first : null; },
        run: async () => { const r = exec(sql, args); return r._run || { meta: { changes: 0 } }; },
        all: async () => { const r = exec(sql, args); return { results: r._all || [] }; },
      });
      const noArgs = terminal([]);
      return { bind: (...args) => terminal(args), first: noArgs.first, run: noArgs.run, all: noArgs.all };
    },
  };
  return { DB, state };
}

function req(method, path, { body, token, ip } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = "Bearer " + token;
  if (ip) headers["cf-connecting-ip"] = ip;
  return new Request("https://example.com" + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
}
const U = (path) => new URL("https://example.com" + path);
async function call(env, method, path, opts) {
  const resp = await handleMeetlyApi(req(method, path, opts), env, U(path));
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// A Monday at least 5 days out (within the 60-day horizon; > the 120-min
// minimum notice), so time-based rules don't touch the core CRUD checks.
function futureMonday() {
  let d = new Date(Date.now() + 5 * 86400000);
  while (d.getUTCDay() !== 1) d = new Date(d.getTime() + 86400000);
  return d.toISOString().slice(0, 10);
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

(async () => {
  const { DB } = makeDb();
  const env = { DB, MEETLY_ADMIN_TOKEN: "s3cret" }; // no RESEND_API_KEY -> mail is a no-op here
  await ensureMeetlySchema(env);
  const MON = futureMonday();

  // --- computeSlots pure checks (minNotice 0 -> no time filtering) ---
  const settings = { hours: { 1: [[9, 12], [13, 17]] }, slotStep: 30, buffer: 0 };
  const ev30 = { id: "meeting-30", duration: 30 };
  ok(computeSlots(settings, ev30, MON, []).length === 14, "30-min Monday yields 14 slots");
  ok(computeSlots({ ...settings }, { id: "d", duration: 60 }, MON, []).length === 12, "60-min yields 12 slots");
  const withBooking = computeSlots({ ...settings, buffer: 15 }, ev30, MON, [{ start_min: 600, end_min: 630, canceled: 0 }]);
  ok(!withBooking.some((s) => s.start === 600) && !withBooking.some((s) => s.start === 570), "buffer removes booked + neighbour");

  // --- minimum notice: a huge notice window removes everything ---
  const nowFixed = hostInstant(MON, 540, "America/New_York") - 60 * 60000; // 1h before 9:00
  const tzSettings = { hours: { 1: [[9, 12]] }, slotStep: 30, buffer: 0, minNotice: 120, host: { timezone: "America/New_York" } };
  // 1h before 9:00 with 2h notice: 9:00 and 9:30 fall inside the window, 10:00+ survive.
  const notice2h = computeSlots(tzSettings, ev30, MON, [], nowFixed);
  ok(!notice2h.some((s) => s.start === 540 || s.start === 570) && notice2h.some((s) => s.start === 600), "min-notice hides slots inside the window, keeps later ones");
  ok(computeSlots({ ...tzSettings, minNotice: 100000 }, ev30, MON, [], nowFixed).length === 0, "a huge notice window hides every slot");
  ok(computeSlots({ ...tzSettings, minNotice: 0 }, ev30, MON, [], nowFixed).length === 6, "min-notice 0 keeps all 6");

  // --- config / slots / booking (seeded defaults incl. minNotice 120) ---
  let r = await call(env, "GET", "/api/meetly/config");
  ok(r.status === 200 && r.data.events.length === 3, "config returns 3 events");
  ok(r.data.host.email === undefined, "host.email is NOT exposed in public config");
  ok(r.data.minNotice === 120 && r.data.horizonDays === 60, "config exposes guardrail values");

  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.status === 200 && r.data.slots.length === 14, "slots endpoint returns 14 for a future Monday");
  const start = r.data.slots[0].start;

  // --- horizon: a date 200 days out is beyond the 60-day window ---
  const far = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + far);
  ok(r.status === 200 && r.data.slots.length === 0, "beyond-horizon date yields no slots");

  // --- create booking + double-book + cancel ---
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start, name: "Sam Lee", email: "sam@example.com", tz: "UTC" } });
  ok(r.status === 201 && r.data.ok, "booking created");
  const bid = r.data.booking.id;
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start, name: "Other", email: "o@example.com" } });
  ok(r.status === 409, "double-book rejected with 409");

  // --- honeypot: a filled hidden field is silently ignored ---
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: start + 30, name: "Bot", email: "bot@example.com", company: "SpamCo" } });
  ok(r.status === 200 && r.data.ignored && r.data.booking === null, "honeypot booking ignored");
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.data.slots.some((s) => s.start === start + 30), "honeypot did not actually book the slot");

  // --- cancel frees the slot ---
  r = await call(env, "POST", "/api/meetly/bookings/" + bid + "/cancel");
  ok(r.status === 200 && r.data.canceled, "cancel works");
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.data.slots.some((s) => s.start === start), "cancelled slot available again");

  // --- rate limit: 6th booking from one IP in the hour is refused ---
  // ensureMeetlySchema memoises per process, so fresh mock DBs won't re-seed;
  // seed their state directly instead.
  const rl = makeDb(); const env2 = { DB: rl.DB };
  seed(rl.state);
  const slotsR = (await call(env2, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  let rlStatus = 201;
  for (let i = 0; i < 6; i++) {
    const res = await call(env2, "POST", "/api/meetly/bookings", { ip: "9.9.9.9", body: { event: "meeting-30", date: MON, start: slotsR[i].start, name: "U" + i, email: "u" + i + "@x.com" } });
    rlStatus = res.status;
  }
  ok(rlStatus === 429, "6th booking from same IP is rate-limited (429), got " + rlStatus);

  // --- daily cap ---
  const cap = makeDb(); const env3 = { DB: cap.DB, MEETLY_ADMIN_TOKEN: "t" };
  seed(cap.state);
  await call(env3, "PUT", "/api/meetly/admin/settings", { token: "t", body: { dailyCap: 1 } });
  const s3 = (await call(env3, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  r = await call(env3, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: s3[0].start, name: "A", email: "a@x.com" } });
  ok(r.status === 201, "first booking under cap ok");
  r = await call(env3, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.data.slots.length === 0, "daily cap reached -> no more slots");
  r = await call(env3, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: s3[1].start, name: "B", email: "b@x.com" } });
  ok(r.status === 409, "booking over daily cap refused");

  // --- .ics generation ---
  const ics = buildIcs({ id: "ml_x", event_id: "meeting-30", event_name: "30 Minute Meeting", date: MON, start_min: 540, end_min: 570, location: "Zoom" }, { host: { name: "Alex Lark", timezone: "America/New_York" } });
  ok(/BEGIN:VCALENDAR/.test(ics) && /BEGIN:VEVENT/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics), "ics has calendar + event + DTSTART");
  ok(/SUMMARY:.*Alex Lark/.test(ics) && /LOCATION:Zoom/.test(ics), "ics summary + location present");

  // --- reminder selection (pure) ---
  const rSettings = { host: { timezone: "America/New_York" } };
  const inst = hostInstant(MON, 540, "America/New_York");
  const bk = { id: "b1", date: MON, start_min: 540, canceled: 0, reminded_24: 0, reminded_1: 0 };
  ok(dueReminders([bk], rSettings, inst - 23 * 3600000)[0].kind === 24, "23h out -> 24h reminder");
  ok(dueReminders([bk], rSettings, inst - 30 * 60000)[0].kind === 1, "30m out -> 1h reminder");
  ok(dueReminders([bk], rSettings, inst - 40 * 3600000).length === 0, "40h out -> nothing yet");
  ok(dueReminders([{ ...bk, reminded_24: 1 }], rSettings, inst - 23 * 3600000).length === 0, "already-24h-reminded -> nothing");

  // --- handleMeetlyReminders sends + marks (Resend fetch mocked) ---
  const rem = makeDb(); const env4 = { DB: rem.DB, RESEND_API_KEY: "test", MEETLY_BASE_URL: "https://x/calendly-clone" };
  rem.state.bookings.push({ id: "rb1", event_id: "meeting-30", name: "R", email: "r@x.com", notes: "", date: MON, start_min: 540, end_min: 570, tz: "UTC", created_at: "2020-01-01T00:00:00Z", canceled: 0, ip: "", reminded_24: 0, reminded_1: 0 });
  let sentMails = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { if (String(url).includes("resend.com")) { sentMails++; return new Response("{}", { status: 200 }); } return new Response("{}", { status: 200 }); };
  const out = await handleMeetlyReminders(env4, inst - 23 * 3600000);
  globalThis.fetch = realFetch;
  ok(out.sent === 1, "one reminder sent, got " + out.sent);
  ok(sentMails === 1, "Resend called once");
  ok(rem.state.bookings[0].reminded_24 === 1, "booking marked reminded_24");

  console.log("\n✓ all " + pass + " Meetly backend checks passed");
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });

// ensureMeetlySchema memoises per-process, so fresh mock DBs won't be seeded
// through it. Populate their state directly with the defaults we need.
function seed(state) {
  state.settings = { id: 1, json: JSON.stringify({
    host: { name: "Alex Lark", initials: "AL", title: "", timezone: "America/New_York", email: "" },
    slotStep: 30, buffer: 0, minNotice: 120, horizonDays: 60, dailyCap: 0,
    hours: { 0: [], 1: [[9, 12], [13, 17]], 2: [[9, 12], [13, 17]], 3: [[9, 12], [13, 17]], 4: [[9, 12], [13, 17]], 5: [[9, 12], [13, 16]], 6: [] },
  }) };
  state.events.push({ id: "meeting-30", name: "30 Minute Meeting", duration: 30, description: "", location: "Zoom", sort: 0, active: 1 });
}
