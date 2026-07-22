/* ==========================================================================
   Meetly data layer.

   One interface, two backends:
     • ApiStore   — talks to /api/meetly/* (used when the Worker is deployed)
     • LocalStore — localStorage, fully offline (the default static demo)

   MeetlyStore.create() probes the API once (GET /api/meetly/config); if it
   answers it uses ApiStore, otherwise it falls back to LocalStore. Either
   way the rest of the app calls the same methods and never knows which.

   The slot algorithm here is a deliberate mirror of worker/meetly.js
   computeSlots — keep the two in sync. It is covered server-side by
   worker/meetly.test.mjs.
   ========================================================================== */
(function (global) {
  "use strict";

  var LS_SETTINGS = "meetly.settings.v1";
  var LS_EVENTS = "meetly.events.v1";
  var LS_BOOKINGS = "meetly.bookings.v1";
  var LS_MINE = "meetly.mybookings.v1"; // ids this browser created

  var DEFAULT_SETTINGS = {
    host: { name: "Alex Lark", initials: "AL", title: "Product Advisor", timezone: "America/New_York" },
    slotStep: 30,
    buffer: 0,
    hours: { 0: [], 1: [[9, 12], [13, 17]], 2: [[9, 12], [13, 17]], 3: [[9, 12], [13, 17]], 4: [[9, 12], [13, 17]], 5: [[9, 12], [13, 16]], 6: [] }
  };
  var DEFAULT_EVENTS = [
    { id: "intro-15", name: "15 Minute Intro Call", duration: 15, description: "A quick introduction to see if we're a good fit.", location: "Google Meet (link sent after booking)", sort: 0, active: 1 },
    { id: "meeting-30", name: "30 Minute Meeting", duration: 30, description: "A focused conversation about your project or question.", location: "Zoom (link sent after booking)", sort: 1, active: 1 },
    { id: "deep-60", name: "60 Minute Deep Dive", duration: 60, description: "An in-depth working session. Bring your questions.", location: "Phone call", sort: 2, active: 1 }
  ];

  // ---------- shared helpers ----------
  function minutesLabel(min) {
    var h = Math.floor(min / 60), m = min % 60;
    var ampm = h >= 12 ? "pm" : "am";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m === 0 ? "00" : String(m).padStart(2, "0")) + ampm;
  }
  function weekdayOf(dateStr) {
    var p = dateStr.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
  }
  function computeSlots(settings, event, dateStr, bookings) {
    var windows = (settings.hours && settings.hours[weekdayOf(dateStr)]) || [];
    var step = settings.slotStep || 30, buffer = settings.buffer || 0, dur = event.duration;
    var taken = (bookings || []).filter(function (b) { return !b.canceled; });
    var out = [];
    windows.forEach(function (w) {
      var startMin = w[0] * 60, endMin = w[1] * 60;
      for (var m = startMin; m + dur <= endMin; m += step) {
        var s = m, e = m + dur;
        var clash = taken.some(function (b) { return s < b.end_min + buffer && b.start_min - buffer < e; });
        if (!clash) out.push({ start: s, end: e, label: minutesLabel(s) });
      }
    });
    return out;
  }
  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function makeId(prefix) {
    var rnd = (global.crypto && global.crypto.randomUUID) ? global.crypto.randomUUID().replace(/-/g, "") : Math.random().toString(36).slice(2);
    return prefix + rnd.slice(0, 12);
  }
  function readJSON(key, fallback) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; }
  }
  function writeJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (_) {} }

  // ============================ LocalStore ============================
  function LocalStore() {
    this.mode = "local";
    if (!localStorage.getItem(LS_SETTINGS)) writeJSON(LS_SETTINGS, DEFAULT_SETTINGS);
    if (!localStorage.getItem(LS_EVENTS)) writeJSON(LS_EVENTS, DEFAULT_EVENTS);
    if (!localStorage.getItem(LS_BOOKINGS)) writeJSON(LS_BOOKINGS, []);
  }
  LocalStore.prototype._settings = function () { return readJSON(LS_SETTINGS, DEFAULT_SETTINGS); };
  LocalStore.prototype._events = function () { return readJSON(LS_EVENTS, DEFAULT_EVENTS); };
  LocalStore.prototype._bookings = function () { return readJSON(LS_BOOKINGS, []); };

  LocalStore.prototype.getConfig = function () {
    var s = this._settings();
    var events = this._events().filter(function (e) { return e.active !== 0; })
      .sort(function (a, b) { return (a.sort - b.sort) || a.name.localeCompare(b.name); });
    return Promise.resolve({ host: s.host, slotStep: s.slotStep, buffer: s.buffer, hours: s.hours, events: events });
  };
  LocalStore.prototype.getSlots = function (eventId, date) {
    var s = this._settings();
    var event = this._events().find(function (e) { return e.id === eventId; });
    if (!event) return Promise.reject(new Error("Unknown event type."));
    var todays = this._bookings().filter(function (b) { return b.date === date && !b.canceled; });
    return Promise.resolve(computeSlots(s, event, date, todays));
  };
  LocalStore.prototype.createBooking = function (data) {
    var s = this._settings();
    var event = this._events().find(function (e) { return e.id === data.event; });
    if (!event) return Promise.reject(new Error("Unknown event type."));
    if (!data.name) return Promise.reject(new Error("Please enter your name."));
    if (!isEmail(data.email)) return Promise.reject(new Error("Please enter a valid email address."));
    var bookings = this._bookings();
    var todays = bookings.filter(function (b) { return b.date === data.date && !b.canceled; });
    var free = computeSlots(s, event, data.date, todays);
    if (!free.some(function (x) { return x.start === data.start; })) {
      return Promise.reject(new Error("That time was just taken. Please pick another."));
    }
    var b = {
      id: makeId("ml_"), event_id: event.id, name: data.name, email: data.email,
      notes: data.notes || "", date: data.date, start_min: data.start, end_min: data.start + event.duration,
      tz: data.tz || "", created_at: new Date().toISOString(), canceled: 0
    };
    bookings.push(b);
    writeJSON(LS_BOOKINGS, bookings);
    var mine = readJSON(LS_MINE, []); mine.push(b.id); writeJSON(LS_MINE, mine);
    return Promise.resolve(shape(b, event));
  };
  LocalStore.prototype.getBooking = function (id) {
    var b = this._bookings().find(function (x) { return x.id === id; });
    if (!b) return Promise.reject(new Error("No booking found with that code."));
    var event = this._events().find(function (e) { return e.id === b.event_id; }) || { name: b.event_id, duration: b.end_min - b.start_min, location: "" };
    return Promise.resolve(shape(b, event));
  };
  LocalStore.prototype.cancelBooking = function (id) {
    var bookings = this._bookings();
    var b = bookings.find(function (x) { return x.id === id; });
    if (!b) return Promise.reject(new Error("No booking found with that code."));
    b.canceled = 1; writeJSON(LS_BOOKINGS, bookings);
    return Promise.resolve({ ok: true, id: id, canceled: true });
  };
  // Admin (local mode is inherently local-only; token ignored)
  LocalStore.prototype.adminGet = function () {
    var s = this._settings();
    var events = this._events().slice().sort(function (a, b) { return a.sort - b.sort; });
    return Promise.resolve({ settings: s, events: events });
  };
  LocalStore.prototype.adminSaveSettings = function (settings) {
    var next = sanitizeSettings(settings, this._settings());
    writeJSON(LS_SETTINGS, next);
    return Promise.resolve({ ok: true, settings: next });
  };
  LocalStore.prototype.adminSaveEvents = function (events) {
    var clean = sanitizeEvents(events);
    if (!clean.length) return Promise.reject(new Error("Keep at least one event type."));
    writeJSON(LS_EVENTS, clean);
    return Promise.resolve({ ok: true, events: clean });
  };
  LocalStore.prototype.adminBookings = function (all) {
    var list = this._bookings().filter(function (b) { return all ? true : !b.canceled; });
    list.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : b.start_min - a.start_min; });
    return Promise.resolve(list.map(function (b) { return shape(b, { name: b.event_id, duration: b.end_min - b.start_min, location: "" }); }));
  };

  // ============================ ApiStore ============================
  function ApiStore(config) { this.mode = "api"; this._config = config; }
  function api(method, path, body, token) {
    var opts = { method: method, headers: {} };
    if (body) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
    if (token) opts.headers["authorization"] = "Bearer " + token;
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (data) {
        if (!r.ok) throw new Error((data && data.error) || ("Request failed (" + r.status + ")"));
        return data;
      });
    });
  }
  ApiStore.prototype.getConfig = function () { return Promise.resolve(this._config); };
  ApiStore.prototype.getSlots = function (eventId, date) {
    return api("GET", "/api/meetly/slots?event=" + encodeURIComponent(eventId) + "&date=" + encodeURIComponent(date)).then(function (d) { return d.slots; });
  };
  ApiStore.prototype.createBooking = function (data) {
    return api("POST", "/api/meetly/bookings", data).then(function (d) {
      var b = d.booking;
      var mine = readJSON(LS_MINE, []); mine.push(b.id); writeJSON(LS_MINE, mine);
      return normalizeApiBooking(b);
    });
  };
  ApiStore.prototype.getBooking = function (id) {
    return api("GET", "/api/meetly/bookings/" + encodeURIComponent(id)).then(function (d) { return normalizeApiBooking(d.booking); });
  };
  ApiStore.prototype.cancelBooking = function (id) {
    return api("POST", "/api/meetly/bookings/" + encodeURIComponent(id) + "/cancel");
  };
  ApiStore.prototype.adminGet = function (token) { return api("GET", "/api/meetly/admin/settings", null, token); };
  ApiStore.prototype.adminSaveSettings = function (settings, token) { return api("PUT", "/api/meetly/admin/settings", settings, token); };
  ApiStore.prototype.adminSaveEvents = function (events, token) { return api("PUT", "/api/meetly/admin/events", { events: events }, token); };
  ApiStore.prototype.adminBookings = function (all, token) {
    return api("GET", "/api/meetly/admin/bookings" + (all ? "?all=1" : ""), null, token).then(function (d) { return d.bookings.map(normalizeApiBooking); });
  };

  // ---------- normalizers so both stores return the same booking shape ----------
  function shape(b, event) {
    return {
      id: b.id, event: b.event_id, eventName: event.name, duration: event.duration, location: event.location,
      name: b.name, email: b.email, notes: b.notes || "", date: b.date,
      start: b.start_min, end: b.end_min, label: minutesLabel(b.start_min), tz: b.tz || "",
      created_at: b.created_at, canceled: !!b.canceled
    };
  }
  function normalizeApiBooking(b) {
    return {
      id: b.id, event: b.event, eventName: b.eventName || b.event, duration: b.duration || (b.end - b.start),
      location: b.location || "", name: b.name, email: b.email, notes: b.notes || "", date: b.date,
      start: b.start, end: b.end, label: b.label || minutesLabel(b.start), tz: b.tz || "",
      created_at: b.created_at, canceled: !!b.canceled
    };
  }

  // ---------- sanitizers (local admin mirrors the worker's) ----------
  function clampInt(v, min, max, fb) { var n = parseInt(v, 10); return Number.isInteger(n) ? Math.max(min, Math.min(max, n)) : fb; }
  function sanitizeSettings(body, current) {
    body = body || {};
    var host = body.host || {};
    var name = String(host.name || current.host.name || "Host").trim().slice(0, 80) || "Host";
    var initials = String(host.initials || "").trim().slice(0, 3).toUpperCase();
    if (!initials) initials = name.split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
    var hours = {};
    for (var d = 0; d <= 6; d++) {
      var ws = Array.isArray(body.hours && body.hours[d]) ? body.hours[d] : [];
      hours[d] = ws.map(function (w) { return [clampInt(w[0], 0, 24, 0), clampInt(w[1], 0, 24, 0)]; }).filter(function (w) { return w[1] > w[0]; });
    }
    var timezone = String(host.timezone || current.host.timezone || "America/New_York").trim().slice(0, 64) || "America/New_York";
    return {
      host: { name: name, initials: initials, title: String(host.title || current.host.title || "").trim().slice(0, 120), timezone: timezone },
      slotStep: clampInt(body.slotStep, 5, 240, current.slotStep),
      buffer: clampInt(body.buffer, 0, 240, current.buffer),
      hours: hours
    };
  }
  function sanitizeEvents(list) {
    list = Array.isArray(list) ? list : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i] || {};
      var name = String(e.name || "").trim();
      if (!name) continue;
      out.push({
        id: String(e.id || "").trim() || makeId("evt_"), name: name,
        duration: clampInt(e.duration, 5, 480, 30),
        description: String(e.description || "").trim(),
        location: String(e.location || "").trim(),
        sort: i, active: e.active === false || e.active === 0 ? 0 : 1
      });
    }
    return out;
  }

  // ============================ factory ============================
  var MeetlyStore = {
    minutesLabel: minutesLabel,
    myBookingIds: function () { return readJSON(LS_MINE, []); },
    create: function () {
      // Probe the API; fall back to localStorage on any failure.
      return fetch("/api/meetly/config", { method: "GET" })
        .then(function (r) { if (!r.ok) throw new Error("no api"); return r.json(); })
        .then(function (cfg) {
          if (!cfg || !Array.isArray(cfg.events)) throw new Error("bad api");
          return new ApiStore(cfg);
        })
        .catch(function () { return new LocalStore(); });
    }
  };

  global.MeetlyStore = MeetlyStore;
})(typeof window !== "undefined" ? window : this);
