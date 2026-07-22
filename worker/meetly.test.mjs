// Self-check for the Meetly scheduling backend: `node worker/meetly.test.mjs`
// Drives the real handleMeetlyApi against an in-memory D1 mock — no network,
// no wrangler. Covers config, slot computation, double-booking prevention,
// cancel-frees-slot, and admin token gating.
import assert from "node:assert";
import { handleMeetlyApi, computeSlots, ensureMeetlySchema } from "./meetly.js";

// ---- Minimal in-memory D1 mock (only the queries meetly.js issues) --------
function makeDb() {
  const state = { settings: null, events: [], bookings: [] };

  function exec(sql, a) {
    a = a || [];
    if (/^\s*CREATE TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };

    // ---- settings ----
    if (/SELECT id FROM meetly_settings/.test(sql)) return { _first: state.settings ? { id: 1 } : null };
    if (/INSERT INTO meetly_settings/.test(sql)) { state.settings = { id: a[0], json: a[1] }; return { _run: { meta: { changes: 1 } } }; }
    if (/SELECT json FROM meetly_settings/.test(sql)) return { _first: state.settings ? { json: state.settings.json } : null };
    if (/UPDATE meetly_settings SET json/.test(sql)) { state.settings.json = a[0]; return { _run: { meta: { changes: 1 } } }; }

    // ---- event types ----
    if (/SELECT id FROM meetly_event_types LIMIT 1/.test(sql)) return { _first: state.events[0] || null };
    if (/INSERT INTO meetly_event_types/.test(sql)) {
      // The seed INSERT hardcodes active as a literal 1 (6 params); the admin
      // INSERT binds it (7 params). Mirror both.
      state.events.push({ id: a[0], name: a[1], duration: a[2], description: a[3], location: a[4], sort: a[5], active: a[6] === undefined ? 1 : a[6] });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM meetly_event_types/.test(sql)) { const n = state.events.length; state.events = []; return { _run: { meta: { changes: n } } }; }
    if (/SELECT id, name, duration, description, location, sort FROM meetly_event_types WHERE active = 1/.test(sql))
      return { _all: state.events.filter((e) => e.active === 1).sort(bySort) };
    if (/SELECT id, name, duration, description, location, sort, active FROM meetly_event_types/.test(sql))
      return { _all: [...state.events].sort(bySort) };

    // ---- bookings ----
    if (/INSERT INTO meetly_bookings/.test(sql)) {
      state.bookings.push({ id: a[0], event_id: a[1], name: a[2], email: a[3], notes: a[4], date: a[5], start_min: a[6], end_min: a[7], tz: a[8], created_at: a[9], canceled: 0 });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/SELECT start_min, end_min, canceled FROM meetly_bookings.*date = \?/s.test(sql))
      return { _all: state.bookings.filter((b) => b.date === a[0] && b.canceled === 0) };
    if (/UPDATE meetly_bookings SET canceled = 1 WHERE id = \? AND canceled = 0/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[0] && x.canceled === 0);
      if (b) { b.canceled = 1; return { _run: { meta: { changes: 1 } } }; }
      return { _run: { meta: { changes: 0 } } };
    }
    if (/SELECT id FROM meetly_bookings WHERE id = \?/.test(sql))
      return { _first: state.bookings.find((b) => b.id === a[0]) ? { id: a[0] } : null };
    if (/SELECT \* FROM meetly_bookings WHERE id = \?/.test(sql))
      return { _first: state.bookings.find((b) => b.id === a[0]) || null };
    if (/SELECT \* FROM meetly_bookings ORDER BY/.test(sql))
      return { _all: [...state.bookings] };
    if (/SELECT \* FROM meetly_bookings WHERE canceled = 0/.test(sql))
      return { _all: state.bookings.filter((b) => b.canceled === 0) };

    throw new Error("unhandled SQL: " + sql);
  }

  function bySort(a, b) { return (a.sort - b.sort) || String(a.name).localeCompare(b.name); }

  const DB = {
    prepare: (sql) => {
      // Terminals execute lazily — only when awaited — so merely preparing an
      // INSERT (to build the no-arg handle) never mutates state.
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

function req(method, path, { body, token } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = "Bearer " + token;
  return new Request("https://example.com" + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
}
const U = (path) => new URL("https://example.com" + path);
async function call(env, method, path, opts) {
  const r = req(method, path, opts);
  const resp = await handleMeetlyApi(r, env, U(path));
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

// A Monday, so the default availability (9-12, 13-17) applies.
function nextMonday() {
  for (let d = 1; d <= 14; d++) {
    const s = "2026-07-" + String(d).padStart(2, "0");
    const [y, mo, da] = s.split("-").map(Number);
    if (new Date(Date.UTC(y, mo - 1, da)).getUTCDay() === 1) return s;
  }
  throw new Error("no monday found");
}

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

(async () => {
  const { DB } = makeDb();
  const env = { DB, MEETLY_ADMIN_TOKEN: "s3cret" };
  await ensureMeetlySchema(env);
  const MON = nextMonday();

  // --- computeSlots pure-function checks ---
  const settings = { hours: { 1: [[9, 12], [13, 17]] }, slotStep: 30, buffer: 0 };
  const ev30 = { id: "meeting-30", duration: 30 };
  let slots = computeSlots(settings, ev30, MON, []);
  ok(slots.length === 14, "30-min Monday yields 14 slots, got " + slots.length);
  ok(slots[0].label === "9:00am", "first slot labelled 9:00am, got " + slots[0].label);
  const ev60 = { id: "deep-60", duration: 60 };
  ok(computeSlots(settings, ev60, MON, []).length === 12, "60-min yields 12 slots");
  // Buffer removes neighbours of a booking.
  const withBooking = computeSlots({ ...settings, buffer: 15 }, ev30, MON, [{ start_min: 600, end_min: 630, canceled: 0 }]);
  ok(!withBooking.some((s) => s.start === 600), "booked 10:00 slot removed");
  ok(!withBooking.some((s) => s.start === 570), "buffer removes 9:30 neighbour");

  // --- config ---
  let r = await call(env, "GET", "/api/meetly/config");
  ok(r.status === 200 && r.data.events.length === 3, "config returns 3 seeded events");
  ok(r.data.host.name === "Alex Lark", "config returns host");

  // --- slots endpoint ---
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.status === 200 && r.data.slots.length === 14, "slots endpoint returns 14");
  const start = r.data.slots[0].start;

  // --- create booking ---
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start, name: "Sam Lee", email: "sam@example.com", notes: "hi", tz: "UTC" } });
  ok(r.status === 201 && r.data.ok, "booking created");
  const bid = r.data.booking.id;
  ok(r.data.booking.end === start + 30, "end = start + duration");

  // --- double booking is rejected ---
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start, name: "Other", email: "o@example.com" } });
  ok(r.status === 409, "double-book rejected with 409, got " + r.status);

  // --- that slot no longer offered ---
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(!r.data.slots.some((s) => s.start === start), "booked slot removed from availability");

  // --- validation ---
  r = await call(env, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: 540, name: "", email: "bad" } });
  ok(r.status === 400, "missing name rejected");

  // --- lookup + cancel frees the slot ---
  r = await call(env, "GET", "/api/meetly/bookings/" + bid);
  ok(r.status === 200 && r.data.booking.name === "Sam Lee", "lookup by id works");
  r = await call(env, "POST", "/api/meetly/bookings/" + bid + "/cancel");
  ok(r.status === 200 && r.data.canceled, "cancel works");
  r = await call(env, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.data.slots.some((s) => s.start === start), "cancelled slot is available again");

  // --- admin gating ---
  r = await call(env, "GET", "/api/meetly/admin/bookings");
  ok(r.status === 401, "admin without token is 401");
  r = await call(env, "GET", "/api/meetly/admin/bookings", { token: "wrong" });
  ok(r.status === 401, "admin with wrong token is 401");
  r = await call(env, "GET", "/api/meetly/admin/bookings?all=1", { token: "s3cret" });
  ok(r.status === 200, "admin with token is 200");
  ok(r.data.bookings.length >= 1, "admin sees bookings (incl. cancelled)");
  ok(r.data.bookings.some((b) => b.canceled), "cancelled booking visible with all=1");

  // --- admin edits settings + events ---
  r = await call(env, "PUT", "/api/meetly/admin/settings", { token: "s3cret", body: { host: { name: "Dr. Rivera", title: "Dosimetrist" }, slotStep: 20, buffer: 10, hours: { 1: [[10, 12]] } } });
  ok(r.status === 200 && r.data.settings.host.initials === "DR", "settings saved, initials derived");
  ok(r.data.settings.slotStep === 20, "slotStep saved");
  r = await call(env, "PUT", "/api/meetly/admin/events", { token: "s3cret", body: { events: [{ name: "Quick chat", duration: 15, location: "Phone" }] } });
  ok(r.status === 200 && r.data.events.length === 1, "events replaced");
  r = await call(env, "GET", "/api/meetly/config");
  ok(r.data.events.length === 1 && r.data.events[0].name === "Quick chat", "config reflects new events");
  ok(r.data.host.name === "Dr. Rivera", "config reflects new host");

  console.log("\n✓ all " + pass + " Meetly backend checks passed");
})().catch((e) => { console.error("✗ " + e.message); process.exit(1); });
