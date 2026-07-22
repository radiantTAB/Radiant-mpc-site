/* ==========================================================================
   Meetly admin / settings.

   Edit host details, scheduling rules, weekly availability, and event types;
   review and cancel bookings. Uses the same MeetlyStore as the booking page:
   in localStorage mode it just works; in API mode it asks for the admin token
   (MEETLY_ADMIN_TOKEN) and keeps it in sessionStorage for the session.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("admin");
  var badge = document.getElementById("modeBadge");
  var store = null;
  var token = sessionStorage.getItem("meetly.adminToken") || "";
  var settings = null; // { host, slotStep, buffer, hours }
  var events = [];     // full list incl. inactive
  var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var TZ_LIST = [
    "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
    "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin",
    "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore",
    "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC"
  ];

  loading();
  MeetlyStore.create().then(function (s) {
    store = s;
    badge.textContent = s.mode === "api" ? "Live backend" : "Local (this browser)";
    badge.className = "admin-mode " + (s.mode === "api" ? "live" : "local");
    return ensureAccess();
  }).then(loadAll).catch(function (err) {
    if (err && err.message === "NEED_TOKEN") return promptToken();
    fail(err);
  });

  // ---- access ----
  function ensureAccess() {
    if (store.mode !== "api") return Promise.resolve();
    if (!token) return Promise.reject(new Error("NEED_TOKEN"));
    // Validate the token with a cheap admin read.
    return store.adminGet(token).then(function () {}).catch(function () {
      token = ""; sessionStorage.removeItem("meetly.adminToken");
      throw new Error("NEED_TOKEN");
    });
  }

  function promptToken() {
    root.innerHTML =
      '<div class="admin-gate"><h1>Admin access</h1>' +
      '<p>This Meetly backend is protected. Enter the admin token (the <code>MEETLY_ADMIN_TOKEN</code> secret) to continue.</p>' +
      '<form id="tokForm"><input type="password" id="tok" placeholder="Admin token" autocomplete="off" />' +
      '<button class="btn btn-primary" type="submit">Unlock</button></form>' +
      '<p class="gate-err" id="gateErr" role="alert"></p></div>';
    root.querySelector("#tokForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var val = root.querySelector("#tok").value.trim();
      if (!val) return;
      store.adminGet(val).then(function () {
        token = val; sessionStorage.setItem("meetly.adminToken", val); loadAll();
      }).catch(function () {
        root.querySelector("#gateErr").textContent = "That token was rejected. Check the MEETLY_ADMIN_TOKEN secret.";
      });
    });
  }

  // ---- load ----
  function loadAll() {
    loading();
    return store.adminGet(token).then(function (d) {
      settings = d.settings; events = (d.events || []).slice();
      return store.adminBookings(true, token);
    }).then(function (bookings) {
      renderAll(bookings);
    }).catch(fail);
  }

  function loading() { root.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading settings…</p></div>'; }
  function fail(err) { root.innerHTML = '<div class="empty-hint" role="alert">' + esc((err && err.message) || "Something went wrong.") + "</div>"; }

  // ---- render ----
  function renderAll(bookings) {
    root.innerHTML =
      '<div class="admin-wrap">' +
      '<h1>Dashboard</h1>' +
      '<p class="admin-sub">Changes here drive the public booking page.' +
      (store.mode === "local" ? " You're editing this browser's local copy." : "") + "</p>" +
      summarySection(bookings) +
      hostSection() +
      rulesSection() +
      availabilitySection() +
      overridesSection() +
      eventsSection() +
      bookingsSection(bookings) +
      "</div>";
    wireHost(); wireRules(); wireAvailability(); wireOverrides(); wireEvents(); wireBookings(bookings);
  }

  // ---- summary / analytics (computed client-side from the bookings list) ----
  function summarySection(bookings) {
    var today = new Date().toISOString().slice(0, 10);
    var weekEnd = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    var active = bookings.filter(function (b) { return !b.canceled; });
    var upcoming = active.filter(function (b) { return b.date >= today; });
    var next7 = upcoming.filter(function (b) { return b.date <= weekEnd; });
    var cancelled = bookings.filter(function (b) { return b.canceled; }).length;

    var byEvent = {};
    active.forEach(function (b) { var k = b.eventName || b.event; byEvent[k] = (byEvent[k] || 0) + 1; });
    var breakdown = Object.keys(byEvent).sort(function (a, c) { return byEvent[c] - byEvent[a]; })
      .map(function (k) { return '<div class="bd-row"><span>' + esc(k) + '</span><b>' + byEvent[k] + "</b></div>"; }).join("");

    return '<section class="admin-card summary-card-wrap"><h2><span aria-hidden="true">📈</span> At a glance</h2>' +
      '<div class="stat-row">' +
      stat(upcoming.length, "Upcoming") +
      stat(next7.length, "Next 7 days") +
      stat(active.length, "Confirmed total") +
      stat(cancelled, "Cancelled") +
      "</div>" +
      (breakdown ? '<div class="breakdown"><h3>By event type</h3>' + breakdown + "</div>" : "") +
      "</section>";
  }
  function stat(n, label) {
    return '<div class="stat"><div class="stat-num">' + n + '</div><div class="stat-label">' + esc(label) + "</div></div>";
  }

  // ---- availability exceptions (date-specific overrides) ----
  function overridesSection() {
    var ov = settings.overrides || {};
    var dates = Object.keys(ov).sort();
    var rows = dates.map(function (d) { return overrideRow(d, ov[d]); }).join("");
    return card("Availability exceptions", "🚫",
      '<p class="hint">Override a specific date — block it (holiday / time off) or set custom hours just for that day. These win over the weekly schedule.</p>' +
      '<div class="ovr-list" id="ovrList">' + rows + "</div>" +
      '<button class="btn btn-ghost btn-sm" id="addOverride" type="button">+ Add exception</button>' +
      '<div class="card-actions"><button class="btn btn-primary" id="saveOverrides">Save exceptions</button>' +
      '<span class="save-note" id="ovrNote"></span></div>'
    );
  }
  function overrideRow(date, windows) {
    var blocked = !windows || windows.length === 0;
    var winHtml = (windows && windows.length ? windows : []).map(windowRow).join("");
    return '<div class="ovr-row" data-date="' + esc(date || "") + '">' +
      '<div class="ovr-head"><input type="date" class="ovr-date" value="' + esc(date || "") + '" aria-label="Exception date" />' +
      '<label class="ovr-block"><input type="checkbox" class="ovr-blocked"' + (blocked ? " checked" : "") + " /> Blocked (day off)</label>" +
      '<button class="win-remove ovr-remove" type="button" aria-label="Remove exception">✕</button></div>' +
      '<div class="ovr-windows"' + (blocked ? ' style="display:none"' : "") + ">" + winHtml +
      '<button class="btn btn-ghost btn-sm add-window" type="button">+ Add window</button></div></div>';
  }
  function wireOverrides() {
    var list = root.querySelector("#ovrList");
    list.querySelectorAll(".ovr-row").forEach(bindOverrideRow);
    root.querySelector("#addOverride").addEventListener("click", function () {
      var wrap = document.createElement("div"); wrap.innerHTML = overrideRow("", []);
      var rowEl = wrap.firstChild; list.appendChild(rowEl); bindOverrideRow(rowEl);
    });
    root.querySelector("#saveOverrides").addEventListener("click", function () {
      var overrides = {};
      list.querySelectorAll(".ovr-row").forEach(function (rowEl) {
        var date = rowEl.querySelector(".ovr-date").value;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
        if (rowEl.querySelector(".ovr-blocked").checked) { overrides[date] = []; return; }
        var ws = [];
        rowEl.querySelectorAll(".window-row").forEach(function (w) {
          var s = parseInt(w.querySelector(".win-start").value, 10);
          var e = parseInt(w.querySelector(".win-end").value, 10);
          if (Number.isInteger(s) && Number.isInteger(e) && e > s) ws.push([s, e]);
        });
        overrides[date] = ws;
      });
      saveSettings(Object.assign({}, settings, { overrides: overrides }), "ovrNote");
    });
  }
  function bindOverrideRow(rowEl) {
    rowEl.querySelector(".ovr-remove").addEventListener("click", function () { rowEl.remove(); });
    var cb = rowEl.querySelector(".ovr-blocked");
    var wins = rowEl.querySelector(".ovr-windows");
    cb.addEventListener("change", function () { wins.style.display = cb.checked ? "none" : ""; });
    wins.querySelector(".add-window").addEventListener("click", function () {
      var wrap = document.createElement("div"); wrap.innerHTML = windowRow(null);
      var r = wrap.firstChild; wins.insertBefore(r, wins.querySelector(".add-window")); bindRemove(r);
    });
    wins.querySelectorAll(".window-row").forEach(bindRemove);
  }

  // ---- host ----
  function hostSection() {
    var h = settings.host;
    return card("Host", "👤",
      row2(
        inp("host-name", "Name", h.name),
        inp("host-title", "Title", h.title || "")
      ) +
      row2(
        inp("host-initials", "Initials", h.initials || "", "2 letters shown in the avatar"),
        selectField("host-tz", "Timezone", TZ_LIST, h.timezone || "America/New_York")
      ) +
      inp("host-email", "Notification email", h.email || "", "Where new-booking alerts are sent (optional)", "email") +
      '<div class="card-actions"><button class="btn btn-primary" id="saveHost">Save host</button>' +
      '<span class="save-note" id="hostNote"></span></div>'
    );
  }
  function wireHost() {
    root.querySelector("#saveHost").addEventListener("click", function () {
      var next = Object.assign({}, settings, {
        host: {
          name: val("host-name"), title: val("host-title"),
          initials: val("host-initials"), timezone: val("host-tz"), email: val("host-email")
        }
      });
      saveSettings(next, "hostNote");
    });
  }

  // ---- rules ----
  function rulesSection() {
    return card("Scheduling rules", "⏱",
      row2(
        inp("rule-step", "Slot interval (minutes)", settings.slotStep, "Gap between start times, e.g. 30", "number"),
        inp("rule-buffer", "Buffer (minutes)", settings.buffer, "Padding kept free around each booking", "number")
      ) +
      row2(
        inp("rule-notice", "Minimum notice (minutes)", settings.minNotice, "Earliest a slot can be booked, e.g. 120", "number"),
        inp("rule-horizon", "Booking horizon (days)", settings.horizonDays, "How far ahead people can book", "number")
      ) +
      inp("rule-cap", "Daily cap", settings.dailyCap, "Max bookings per day (0 = unlimited)", "number") +
      '<div class="card-actions"><button class="btn btn-primary" id="saveRules">Save rules</button>' +
      '<span class="save-note" id="rulesNote"></span></div>'
    );
  }
  function wireRules() {
    root.querySelector("#saveRules").addEventListener("click", function () {
      var next = Object.assign({}, settings, {
        slotStep: parseInt(val("rule-step"), 10), buffer: parseInt(val("rule-buffer"), 10),
        minNotice: parseInt(val("rule-notice"), 10), horizonDays: parseInt(val("rule-horizon"), 10),
        dailyCap: parseInt(val("rule-cap"), 10)
      });
      saveSettings(next, "rulesNote");
    });
  }

  // ---- availability ----
  function availabilitySection() {
    var rows = "";
    for (var d = 0; d <= 6; d++) {
      var windows = (settings.hours && settings.hours[d]) || [];
      rows += '<div class="avail-day" data-day="' + d + '"><div class="avail-name">' + DAY_NAMES[d] + "</div>" +
        '<div class="avail-windows">' + windows.map(windowRow).join("") +
        '</div><button class="btn btn-ghost btn-sm add-window" type="button">+ Add window</button></div>';
    }
    return card("Weekly availability", "📅",
      '<p class="hint">Times use a 24-hour clock in the host\'s timezone. Leave a day empty for a day off.</p>' +
      '<div class="avail-list">' + rows + "</div>" +
      '<div class="card-actions"><button class="btn btn-primary" id="saveAvail">Save availability</button>' +
      '<span class="save-note" id="availNote"></span></div>'
    );
  }
  function windowRow(w) {
    return '<div class="window-row"><input type="number" class="win-start" min="0" max="24" value="' + (w ? w[0] : 9) + '" aria-label="Start hour" />' +
      '<span>to</span><input type="number" class="win-end" min="0" max="24" value="' + (w ? w[1] : 17) + '" aria-label="End hour" />' +
      '<button class="win-remove" type="button" aria-label="Remove window">✕</button></div>';
  }
  function wireAvailability() {
    root.querySelectorAll(".avail-day").forEach(function (dayEl) {
      dayEl.querySelector(".add-window").addEventListener("click", function () {
        var wrap = document.createElement("div");
        wrap.innerHTML = windowRow(null);
        var rowEl = wrap.firstChild;
        dayEl.querySelector(".avail-windows").appendChild(rowEl);
        bindRemove(rowEl);
      });
      dayEl.querySelectorAll(".window-row").forEach(bindRemove);
    });
    root.querySelector("#saveAvail").addEventListener("click", function () {
      var hours = {};
      root.querySelectorAll(".avail-day").forEach(function (dayEl) {
        var d = dayEl.dataset.day;
        var ws = [];
        dayEl.querySelectorAll(".window-row").forEach(function (rowEl) {
          var s = parseInt(rowEl.querySelector(".win-start").value, 10);
          var e = parseInt(rowEl.querySelector(".win-end").value, 10);
          if (Number.isInteger(s) && Number.isInteger(e) && e > s) ws.push([s, e]);
        });
        hours[d] = ws;
      });
      saveSettings(Object.assign({}, settings, { hours: hours }), "availNote");
    });
  }
  function bindRemove(rowEl) {
    rowEl.querySelector(".win-remove").addEventListener("click", function () { rowEl.remove(); });
  }

  // ---- event types ----
  function eventsSection() {
    return card("Event types", "🗂",
      '<div class="event-editor" id="eventEditor">' + events.map(eventRow).join("") + "</div>" +
      '<button class="btn btn-ghost btn-sm" id="addEvent" type="button">+ Add event type</button>' +
      '<div class="card-actions"><button class="btn btn-primary" id="saveEvents">Save event types</button>' +
      '<span class="save-note" id="eventsNote"></span></div>'
    );
  }
  function eventRow(e) {
    e = e || { name: "", duration: 30, description: "", location: "", active: 1 };
    return '<div class="event-edit-row" data-id="' + esc(e.id || "") + '">' +
      '<div class="eer-grid">' +
      '<input class="ee-name" placeholder="Name (e.g. 30 Minute Meeting)" value="' + esc(e.name) + '" aria-label="Event name" />' +
      '<input class="ee-duration" type="number" min="5" max="480" placeholder="Min" value="' + (e.duration || 30) + '" aria-label="Duration in minutes" />' +
      '<input class="ee-location" placeholder="Location (e.g. Zoom)" value="' + esc(e.location || "") + '" aria-label="Location" />' +
      '<input class="ee-desc" placeholder="Short description" value="' + esc(e.description || "") + '" aria-label="Description" />' +
      '<label class="ee-active"><input type="checkbox" class="ee-active-cb" ' + (e.active === 0 ? "" : "checked") + " /> Active</label>" +
      '<button class="win-remove ee-remove" type="button" aria-label="Remove event type">✕</button>' +
      "</div></div>";
  }
  function wireEvents() {
    var editor = root.querySelector("#eventEditor");
    editor.querySelectorAll(".event-edit-row").forEach(bindEventRemove);
    root.querySelector("#addEvent").addEventListener("click", function () {
      var wrap = document.createElement("div"); wrap.innerHTML = eventRow(null);
      var rowEl = wrap.firstChild; editor.appendChild(rowEl); bindEventRemove(rowEl);
    });
    root.querySelector("#saveEvents").addEventListener("click", function () {
      var list = [];
      editor.querySelectorAll(".event-edit-row").forEach(function (rowEl) {
        list.push({
          id: rowEl.dataset.id || "",
          name: rowEl.querySelector(".ee-name").value.trim(),
          duration: parseInt(rowEl.querySelector(".ee-duration").value, 10),
          location: rowEl.querySelector(".ee-location").value.trim(),
          description: rowEl.querySelector(".ee-desc").value.trim(),
          active: rowEl.querySelector(".ee-active-cb").checked
        });
      });
      var note = root.querySelector("#eventsNote");
      note.textContent = "Saving…"; note.className = "save-note";
      store.adminSaveEvents(list, token).then(function (d) {
        events = d.events; note.textContent = "Saved ✓"; note.className = "save-note ok";
        // Re-render just the editor with server-assigned ids.
        root.querySelector("#eventEditor").innerHTML = events.map(eventRow).join("");
        wireEvents();
      }).catch(function (err) { note.textContent = err.message || "Save failed"; note.className = "save-note err"; });
    });
  }
  function bindEventRemove(rowEl) {
    rowEl.querySelector(".ee-remove").addEventListener("click", function () { rowEl.remove(); });
  }

  // ---- bookings ----
  function bookingsSection(bookings) {
    var active = bookings.filter(function (b) { return !b.canceled; });
    var body;
    if (!bookings.length) {
      body = '<p class="hint">No bookings yet. They\'ll appear here as people book.</p>';
    } else {
      body = '<div class="table-scroll"><table class="bk-table"><thead><tr>' +
        "<th>When</th><th>Event</th><th>Who</th><th>Status</th><th></th></tr></thead><tbody>" +
        bookings.map(bookingTr).join("") + "</tbody></table></div>";
    }
    return card("Bookings", "📋",
      '<p class="hint">' + active.length + " upcoming · " + bookings.length + " total</p>" + body);
  }
  function bookingTr(b) {
    var when = humanDate(b.date) + " · " + b.label;
    return '<tr data-id="' + esc(b.id) + '" class="' + (b.canceled ? "bk-canceled" : "") + '">' +
      "<td>" + esc(when) + "</td>" +
      "<td>" + esc(b.eventName || b.event) + "</td>" +
      "<td>" + esc(b.name) + "<br><span class=\"bk-email\">" + esc(b.email) + "</span></td>" +
      "<td>" + (b.canceled ? '<span class="pill pill-off">Cancelled</span>' : '<span class="pill pill-on">Confirmed</span>') + "</td>" +
      "<td>" + (b.canceled ? "" : '<button class="btn btn-danger btn-sm bk-cancel" type="button">Cancel</button>') + "</td></tr>";
  }
  function wireBookings() {
    root.querySelectorAll(".bk-cancel").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var tr = btn.closest("tr");
        var id = tr.dataset.id;
        btn.disabled = true; btn.textContent = "…";
        store.cancelBooking(id).then(function () {
          tr.classList.add("bk-canceled");
          tr.querySelector("td:nth-child(4)").innerHTML = '<span class="pill pill-off">Cancelled</span>';
          tr.querySelector("td:last-child").innerHTML = "";
        }).catch(function (err) { btn.disabled = false; btn.textContent = "Cancel"; alert(err.message || "Could not cancel."); });
      });
    });
  }

  // ---- save helper ----
  function saveSettings(next, noteId) {
    var note = root.querySelector("#" + noteId);
    note.textContent = "Saving…"; note.className = "save-note";
    store.adminSaveSettings(next, token).then(function (d) {
      settings = d.settings; note.textContent = "Saved ✓"; note.className = "save-note ok";
    }).catch(function (err) { note.textContent = err.message || "Save failed"; note.className = "save-note err"; });
  }

  // ---- tiny html builders ----
  function card(title, icon, body) {
    return '<section class="admin-card"><h2><span aria-hidden="true">' + icon + "</span> " + esc(title) + "</h2>" + body + "</section>";
  }
  function row2(a, b) { return '<div class="row2">' + a + b + "</div>"; }
  function inp(id, label, value, hint, type) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
      '<input id="' + id + '" type="' + (type || "text") + '" value="' + esc(value) + '" />' +
      (hint ? '<div class="hint">' + esc(hint) + "</div>" : "") + "</div>";
  }
  function selectField(id, label, list, current) {
    return '<div class="field"><label for="' + id + '">' + esc(label) + "</label>" +
      '<select id="' + id + '" class="tz-select">' + list.map(function (z) {
        return '<option value="' + esc(z) + '"' + (z === current ? " selected" : "") + ">" + esc(z) + "</option>";
      }).join("") + "</select></div>";
  }
  function val(id) { var el = root.querySelector("#" + id); return el ? el.value.trim() : ""; }
  function humanDate(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
})();
