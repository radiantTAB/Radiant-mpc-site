// Self-check for the Meetly scheduling backend: `node worker/meetly.test.mjs`
// Drives the real handlers against an in-memory D1 mock — no network, no
// wrangler. Covers slots, buffers, double-booking, cancel, admin gating,
// guardrails (min-notice / horizon / daily cap), honeypot, rate limiting,
// .ics generation, and reminder selection + sending (Resend fetch mocked).
import assert from "node:assert";
import { handleMeetlyApi, computeSlots, ensureMeetlySchema, hostInstant, buildIcs, buildFeedIcs, busyMinutes, dueReminders, handleMeetlyReminders } from "./meetly.js";
import { googleAuthUrl, meetLinkFrom } from "./meetly-google.js";

// ---- Minimal in-memory D1 mock (only the queries meetly.js issues) --------
function makeDb() {
  const state = { settings: null, events: [], bookings: [], google: null };

  function exec(sql, a) {
    a = a || [];
    if (/^\s*CREATE TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };
    if (/^\s*ALTER TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };

    // ---- google connection ----
    if (/SELECT \* FROM meetly_google WHERE id = 1/.test(sql)) return { _first: state.google };
    if (/INSERT INTO meetly_google/.test(sql)) { state.google = { id: 1, calendar_id: "primary", pending_state: a[0], refresh_token: null, email: "" }; return { _run: { meta: { changes: 1 } } }; }
    if (/UPDATE meetly_google SET pending_state = \?/.test(sql)) { if (state.google) state.google.pending_state = a[0]; return { _run: { meta: { changes: 1 } } }; }
    if (/UPDATE meetly_google SET refresh_token/.test(sql)) { state.google = Object.assign(state.google || { id: 1, calendar_id: "primary" }, { refresh_token: a[0], email: a[1], connected_at: a[2], pending_state: null }); return { _run: { meta: { changes: 1 } } }; }
    if (/DELETE FROM meetly_google/.test(sql)) { state.google = null; return { _run: { meta: { changes: 1 } } }; }

    if (/SELECT id FROM meetly_settings/.test(sql)) return { _first: state.settings ? { id: 1 } : null };
    if (/INSERT INTO meetly_settings/.test(sql)) { state.settings = { id: a[0], json: a[1] }; return { _run: { meta: { changes: 1 } } }; }
    if (/SELECT json FROM meetly_settings/.test(sql)) return { _first: state.settings ? { json: state.settings.json } : null };
    if (/UPDATE meetly_settings SET json/.test(sql)) { state.settings.json = a[0]; return { _run: { meta: { changes: 1 } } }; }

    if (/SELECT id FROM meetly_event_types LIMIT 1/.test(sql)) return { _first: state.events[0] || null };
    if (/INSERT INTO meetly_event_types/.test(sql)) {
      state.events.push({ id: a[0], name: a[1], duration: a[2], description: a[3], location: a[4], sort: a[5], active: a[6] === undefined ? 1 : a[6], questions: a[7], hosts: a[8] });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM meetly_event_types/.test(sql)) { const n = state.events.length; state.events = []; return { _run: { meta: { changes: n } } }; }
    if (/FROM meetly_event_types WHERE active = 1/.test(sql))
      return { _all: state.events.filter((e) => e.active === 1).sort(bySort) };
    if (/FROM meetly_event_types ORDER BY sort, name/.test(sql))
      return { _all: [...state.events].sort(bySort) };

    if (/INSERT INTO meetly_bookings/.test(sql)) {
      state.bookings.push({ id: a[0], event_id: a[1], name: a[2], email: a[3], notes: a[4], date: a[5], start_min: a[6], end_min: a[7], tz: a[8], created_at: a[9], canceled: 0, ip: a[10], reminded_24: 0, reminded_1: 0, answers: a[11], host_id: a[12] });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/SELECT COUNT\(\*\) AS n FROM meetly_bookings WHERE ip = \? AND created_at > \?/.test(sql)) {
      const n = state.bookings.filter((b) => b.ip === a[0] && b.created_at > a[1]).length;
      return { _first: { n } };
    }
    if (/FROM meetly_bookings WHERE date = \? AND canceled = 0/.test(sql))
      return { _all: state.bookings.filter((b) => b.date === a[0] && b.canceled === 0) };
    if (/UPDATE meetly_bookings SET canceled = 1 WHERE id = \? AND canceled = 0/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[0] && x.canceled === 0);
      if (b) { b.canceled = 1; return { _run: { meta: { changes: 1 } } }; }
      return { _run: { meta: { changes: 0 } } };
    }
    if (/UPDATE meetly_bookings SET meet_link = \? WHERE id = \?/.test(sql)) {
      const b = state.bookings.find((x) => x.id === a[1]); if (b) b.meet_link = a[0]; return { _run: { meta: { changes: 1 } } };
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
    if (/SELECT \* FROM meetly_bookings WHERE canceled = 0 AND date >= \?/.test(sql))
      return { _all: state.bookings.filter((b) => b.canceled === 0 && b.date >= a[0]).sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.start_min - y.start_min)) };
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

  // --- date overrides (block / custom hours) ---
  const ovr = makeDb(); const env5 = { DB: ovr.DB, MEETLY_ADMIN_TOKEN: "t" };
  seed(ovr.state);
  ok((await call(env5, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots.length === 14, "override baseline 14 slots");
  await call(env5, "PUT", "/api/meetly/admin/settings", { token: "t", body: { overrides: { [MON]: [] } } });
  ok((await call(env5, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots.length === 0, "blocked date -> 0 slots");
  await call(env5, "PUT", "/api/meetly/admin/settings", { token: "t", body: { overrides: { [MON]: [[14, 16]] } } });
  r = await call(env5, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(r.data.slots.length === 4 && r.data.slots[0].start === 840, "custom-hours override -> 4 afternoon slots from 14:00");
  r = await call(env5, "GET", "/api/meetly/config");
  ok(r.data.overrides && r.data.overrides[MON] && r.data.overrides[MON][0][0] === 14, "config exposes overrides");

  // --- custom questions per event type + answers on bookings ---
  const qd = makeDb(); const env7 = { DB: qd.DB, MEETLY_ADMIN_TOKEN: "t" };
  seed(qd.state);
  await call(env7, "PUT", "/api/meetly/admin/events", { token: "t", body: { events: [
    { id: "meeting-30", name: "30 Minute Meeting", duration: 30, location: "Zoom", questions: [{ label: "Topic", type: "text", required: true }, { label: "Extra", type: "textarea", required: false }] },
  ] } });
  r = await call(env7, "GET", "/api/meetly/config");
  ok(r.data.events[0].questions.length === 2 && r.data.events[0].questions[0].required === true, "config exposes event questions");
  const qslots = (await call(env7, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  r = await call(env7, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: qslots[0].start, name: "Q", email: "q@x.com" } });
  ok(r.status === 400 && /Topic/.test(r.data.error), "required question enforced (400)");
  r = await call(env7, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: qslots[0].start, name: "Q", email: "q@x.com", answers: { Topic: "Pricing", Extra: "" } } });
  ok(r.status === 201 && r.data.booking.answers.Topic === "Pricing", "answer stored on booking");
  ok(r.data.booking.answers.Extra === undefined, "empty optional answer omitted");
  r = await call(env7, "GET", "/api/meetly/bookings/" + r.data.booking.id);
  ok(r.data.booking.answers.Topic === "Pricing", "answer readable via lookup");

  // --- outbound webhooks (fetch mocked) ---
  const wh = makeDb(); const env8 = { DB: wh.DB, MEETLY_ADMIN_TOKEN: "t" };
  seed(wh.state);
  await call(env8, "PUT", "/api/meetly/admin/settings", { token: "t", body: { webhookUrl: "https://hook.example.com/x", webhookSecret: "shh" } });
  r = await call(env8, "GET", "/api/meetly/admin/settings", { token: "t" });
  ok(r.data.settings.webhookUrl === "https://hook.example.com/x", "webhook url saved");
  await call(env8, "PUT", "/api/meetly/admin/settings", { token: "t", body: { webhookUrl: "ftp://bad" } });
  r = await call(env8, "GET", "/api/meetly/admin/settings", { token: "t" });
  ok(r.data.settings.webhookUrl === "https://hook.example.com/x", "non-http webhook url rejected (kept previous)");
  let hookCalls = [];
  const realFetch2 = globalThis.fetch;
  globalThis.fetch = async (u, init) => { hookCalls.push({ url: String(u), body: JSON.parse(init.body), headers: init.headers }); return new Response("{}", { status: 200 }); };
  const ws = (await call(env8, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  r = await call(env8, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: ws[0].start, name: "W", email: "w@x.com" } });
  const created = hookCalls.find((c) => c.body.type === "booking.created");
  ok(r.status === 201 && created && created.url === "https://hook.example.com/x", "webhook fired on booking.created");
  ok(created.headers["x-meetly-secret"] === "shh", "webhook carries signing secret header");
  ok(created.body.booking.email === "w@x.com", "webhook payload includes booking");
  hookCalls = [];
  await call(env8, "POST", "/api/meetly/bookings/" + r.data.booking.id + "/cancel");
  ok(hookCalls.some((c) => c.body.type === "booking.cancelled"), "webhook fired on booking.cancelled");
  globalThis.fetch = realFetch2;

  // --- round-robin / multi-host ---
  const rr = makeDb(); const env9 = { DB: rr.DB, MEETLY_ADMIN_TOKEN: "t" };
  seed(rr.state);
  await call(env9, "PUT", "/api/meetly/admin/settings", { token: "t", body: { team: [{ name: "Ada Lovelace" }, { name: "Ben Reed" }] } });
  const cfgA = (await call(env9, "GET", "/api/meetly/admin/settings", { token: "t" })).data;
  const ada = cfgA.settings.team[0], ben = cfgA.settings.team[1];
  ok(ada.id && ben.id && ada.initials === "AL", "team members created with ids + initials");
  await call(env9, "PUT", "/api/meetly/admin/events", { token: "t", body: { events: [{ id: "meeting-30", name: "30 Minute Meeting", duration: 30, hosts: [ada.id, ben.id] }] } });
  r = await call(env9, "GET", "/api/meetly/config");
  ok(r.data.team.length === 2 && r.data.team[0].email === undefined, "config exposes team without emails");
  const rslots = (await call(env9, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  const st = rslots[0].start;
  const rb1 = await call(env9, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: st, name: "C1", email: "c1@x.com" } });
  const rb2 = await call(env9, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: st, name: "C2", email: "c2@x.com" } });
  ok(rb1.status === 201 && rb2.status === 201, "two members -> two concurrent bookings at one slot");
  ok(rb1.data.booking.host_id !== rb2.data.booking.host_id, "round-robin assigns different members");
  ok([ada.name, ben.name].indexOf(rb1.data.booking.hostName) > -1, "booking carries assigned host name");
  const rb3 = await call(env9, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: st, name: "C3", email: "c3@x.com" } });
  ok(rb3.status === 409, "third booking at full slot -> 409 (capacity 2)");
  r = await call(env9, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(!r.data.slots.some((x) => x.start === st), "full slot removed from availability");
  const otherStart = rslots[1].start;
  ok(r.data.slots.some((x) => x.start === otherStart), "other slots still available");

  // --- Google Calendar: pure helpers ---
  const gTz = "America/New_York";
  const bStart = new Date(hostInstant(MON, 600, gTz)).toISOString(); // 10:00
  const bEnd = new Date(hostInstant(MON, 660, gTz)).toISOString();   // 11:00
  const bm = busyMinutes([{ start: bStart, end: bEnd }], MON, gTz);
  ok(bm.length === 1 && bm[0].start_min === 600 && bm[0].end_min === 660, "busyMinutes maps a UTC busy period to host-local minutes");
  const gSettings = { hours: { 1: [[9, 12]] }, slotStep: 30, buffer: 0, host: { timezone: gTz } };
  const withoutBusy = computeSlots(gSettings, ev30, MON, [], 0);
  const withBusy = computeSlots(gSettings, ev30, MON, [], 0, bm);
  ok(withoutBusy.some((s) => s.start === 600) && !withBusy.some((s) => s.start === 600), "external busy removes the 10:00 slot");
  const au = googleAuthUrl({ GOOGLE_CLIENT_ID: "cid" }, new URL("https://ex.com/x"), "STATE1");
  ok(au.indexOf("accounts.google.com") > -1 && au.indexOf("client_id=cid") > -1 && au.indexOf("state=STATE1") > -1 && au.indexOf("access_type=offline") > -1, "googleAuthUrl builds the consent URL");

  // --- Google admin endpoints + slots integration (fetch mocked) ---
  const gd = makeDb(); const env10 = { DB: gd.DB, MEETLY_ADMIN_TOKEN: "t", GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" };
  seed(gd.state);
  r = await call(env10, "GET", "/api/meetly/admin/google/status", { token: "t" });
  ok(r.data.configured === true && r.data.connected === false, "status: configured but not connected");
  r = await call(env10, "GET", "/api/meetly/admin/google/auth", { token: "t" });
  ok(/accounts\.google\.com/.test(r.data.url) && gd.state.google && gd.state.google.pending_state, "auth returns URL + stores pending state");

  // Simulate the OAuth callback with the matching state (token exchange mocked).
  const savedState = gd.state.google.pending_state;
  const realFetch3 = globalThis.fetch;
  globalThis.fetch = async (u) => {
    u = String(u);
    if (u.indexOf("oauth2.googleapis.com/token") > -1) return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), { status: 200 });
    if (u.indexOf("userinfo") > -1) return new Response(JSON.stringify({ email: "host@example.com" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  let cb = await handleMeetlyApi(req("GET", "/api/meetly/oauth/google/callback?code=abc&state=" + savedState), env10, U("/api/meetly/oauth/google/callback?code=abc&state=" + savedState));
  ok(cb.status === 302 && /google=connected/.test(cb.headers.get("location") || ""), "callback with valid state connects + redirects");
  ok(gd.state.google.refresh_token === "rt" && gd.state.google.email === "host@example.com", "refresh token + email stored");
  r = await call(env10, "GET", "/api/meetly/admin/google/status", { token: "t" });
  ok(r.data.connected === true && r.data.email === "host@example.com", "status now connected");

  // meetLinkFrom (pure)
  ok(meetLinkFrom({ hangoutLink: "https://meet.google.com/aaa" }) === "https://meet.google.com/aaa", "meetLinkFrom reads hangoutLink");
  ok(meetLinkFrom({ conferenceData: { entryPoints: [{ entryPointType: "video", uri: "https://meet.google.com/bbb" }] } }) === "https://meet.google.com/bbb", "meetLinkFrom reads entryPoints");

  // Now slots should exclude the host's Google busy time (freebusy mocked),
  // and a booking on a free slot gets a Meet link from the created event.
  globalThis.fetch = async (u, init) => {
    u = String(u);
    if (u.indexOf("oauth2.googleapis.com/token") > -1) return new Response(JSON.stringify({ access_token: "at2", expires_in: 3600 }), { status: 200 });
    if (u.indexOf("freeBusy") > -1) return new Response(JSON.stringify({ calendars: { primary: { busy: [{ start: bStart, end: bEnd }] } } }), { status: 200 });
    if (u.indexOf("/events") > -1) return new Response(JSON.stringify({ id: "ev1", hangoutLink: "https://meet.google.com/abc-defg-hij" }), { status: 200 });
    return new Response("{}", { status: 200 });
  };
  r = await call(env10, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON);
  ok(!r.data.slots.some((s) => s.start === 600), "slots endpoint hides Google-busy 10:00 slot");
  ok(r.data.slots.some((s) => s.start === 540), "other slots still offered");
  // Booking a busy slot is refused.
  r = await call(env10, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: 600, name: "Z", email: "z@x.com" } });
  ok(r.status === 409, "booking a Google-busy slot -> 409");
  // Booking a free slot gets a Meet link.
  r = await call(env10, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: 540, name: "M", email: "m@x.com" } });
  ok(r.status === 201 && r.data.booking.meetLink === "https://meet.google.com/abc-defg-hij", "booking gets a Meet link");
  const mlBooking = gd.state.bookings.find((b) => b.id === r.data.booking.id);
  ok(mlBooking && mlBooking.meet_link === "https://meet.google.com/abc-defg-hij", "meet link persisted on the booking");
  globalThis.fetch = realFetch3;

  // Callback with a bad state is rejected.
  r = await handleMeetlyApi(req("GET", "/api/meetly/oauth/google/callback?code=abc&state=WRONG"), env10, U("/api/meetly/oauth/google/callback?code=abc&state=WRONG"));
  ok(r.status === 302 && /google=error/.test(r.headers.get("location") || ""), "callback with wrong state -> error redirect");
  // Disconnect.
  r = await call(env10, "POST", "/api/meetly/admin/google/disconnect", { token: "t" });
  ok(r.data.connected === false && gd.state.google === null, "disconnect clears the connection");

  // --- .ics generation ---
  const ics = buildIcs({ id: "ml_x", event_id: "meeting-30", event_name: "30 Minute Meeting", date: MON, start_min: 540, end_min: 570, location: "Zoom" }, { host: { name: "Alex Lark", timezone: "America/New_York" } });
  ok(/BEGIN:VCALENDAR/.test(ics) && /BEGIN:VEVENT/.test(ics) && /DTSTART:\d{8}T\d{6}Z/.test(ics), "ics has calendar + event + DTSTART");
  ok(/SUMMARY:.*Alex Lark/.test(ics) && /LOCATION:Zoom/.test(ics), "ics summary + location present");

  // --- calendar feed (multi-event .ics) ---
  const bf = buildFeedIcs(
    [{ id: "b1", event_id: "meeting-30", name: "Ann", email: "a@x.com", notes: "", date: MON, start_min: 540, end_min: 570, canceled: 0 },
     { id: "b2", event_id: "meeting-30", name: "Bob", date: MON, start_min: 600, end_min: 630, canceled: 1 }],
    [{ id: "meeting-30", name: "30 Minute Meeting", location: "Zoom" }],
    { host: { timezone: "America/New_York" } });
  ok(/BEGIN:VCALENDAR/.test(bf) && (bf.match(/BEGIN:VEVENT/g) || []).length === 1, "feed skips cancelled -> 1 event");
  ok(/SUMMARY:30 Minute Meeting — Ann/.test(bf), "feed summary has event + booker");

  const fe = makeDb(); const env6 = { DB: fe.DB, MEETLY_ADMIN_TOKEN: "ft" };
  seed(fe.state);
  const fslots = (await call(env6, "GET", "/api/meetly/slots?event=meeting-30&date=" + MON)).data.slots;
  await call(env6, "POST", "/api/meetly/bookings", { body: { event: "meeting-30", date: MON, start: fslots[0].start, name: "Feed Guy", email: "f@x.com" } });
  let fresp = await handleMeetlyApi(req("GET", "/api/meetly/feed.ics"), env6, U("/api/meetly/feed.ics"));
  ok(fresp.status === 401, "feed without token -> 401");
  fresp = await handleMeetlyApi(req("GET", "/api/meetly/feed.ics?token=wrong"), env6, U("/api/meetly/feed.ics?token=wrong"));
  ok(fresp.status === 401, "feed with wrong token -> 401");
  fresp = await handleMeetlyApi(req("GET", "/api/meetly/feed.ics?token=ft"), env6, U("/api/meetly/feed.ics?token=ft"));
  ok(fresp.status === 200 && /text\/calendar/.test(fresp.headers.get("content-type") || ""), "feed with token -> 200 text/calendar");
  const ftext = await fresp.text();
  ok(/BEGIN:VEVENT/.test(ftext) && /Feed Guy/.test(ftext), "feed contains the booking");

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
