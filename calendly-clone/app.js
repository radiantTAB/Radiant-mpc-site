/* ==========================================================================
   Meetly — Calendly-style scheduling flow (personal clone)

   Uses MeetlyStore (store.js) for all data, so it runs on localStorage
   offline and on the /api/meetly/* Worker backend when deployed. Adds:
   timezone conversion, reschedule/cancel, buffers (via the store), keyboard
   + screen-reader support, and step transitions.

   States: loading -> list -> schedule -> confirm -> success
           (plus manage, reached from a ?manage=<id> link)
   ========================================================================== */
(function () {
  "use strict";

  var app = document.getElementById("app");
  var store = null;
  var CFG = null; // { host, slotStep, buffer, hours, events }

  var state = {
    view: "loading",
    event: null,
    monthCursor: startOfMonth(new Date()),
    selectedDate: null, // "YYYY-MM-DD"
    selectedTime: null,  // { start, end, label }
    form: { name: "", email: "", notes: "" },
    booking: null,
    tz: detectTz(),
    rescheduleId: null,  // set when the user is moving an existing booking
  };

  var TZ_LIST = buildTzList();

  // ---------- boot ----------
  render(); // shows loading
  MeetlyStore.create().then(function (s) {
    store = s;
    return store.getConfig();
  }).then(function (cfg) {
    CFG = cfg;
    // Deep link: /booking.html?manage=<id> jumps straight to a booking.
    var manageId = new URLSearchParams(location.search).get("manage");
    if (manageId) return openManage(manageId);
    state.view = "list";
    render();
  }).catch(function (err) {
    app.innerHTML = '<div class="empty-hint" role="alert">Could not load scheduling data.<br>' + escapeHtml(err.message || "") + "</div>";
  });

  // ---------- router ----------
  function render() {
    if (state.view === "loading") return renderLoading();
    if (state.view === "list") return renderList();
    if (state.view === "schedule") return renderSchedule();
    if (state.view === "confirm") return renderConfirm();
    if (state.view === "success") return renderSuccess();
    if (state.view === "manage") return renderManage();
  }

  // Fade the panel in on each step (honours prefers-reduced-motion in CSS).
  function transition() {
    app.classList.remove("step-in");
    void app.offsetWidth; // reflow so the animation restarts
    app.classList.add("step-in");
  }
  function focusHeading() {
    var h = app.querySelector("[data-autofocus]");
    if (h) { h.setAttribute("tabindex", "-1"); h.focus({ preventScroll: true }); }
  }
  function done() { transition(); focusHeading(); }

  function hostBadge(size) {
    return '<div class="avatar-lg' + (size === "sm" ? " sm" : "") + '" aria-hidden="true">' + escapeHtml(CFG.host.initials) + "</div>";
  }

  // ---------- loading ----------
  function renderLoading() {
    app.innerHTML = '<div class="loading" role="status" aria-live="polite">' +
      '<div class="spinner" aria-hidden="true"></div><p>Loading availability…</p></div>';
  }

  // ---------- event type list ----------
  function renderList() {
    app.innerHTML =
      '<div class="event-list"><div class="host-card">' + hostBadge() +
      '<h1 data-autofocus tabindex="-1">' + escapeHtml(CFG.host.name) + "</h1>" +
      '<p>' + escapeHtml(CFG.host.title || "") + (CFG.host.title ? " · " : "") + "Pick a meeting type to get started</p></div>" +
      '<div class="event-types" role="list">' + CFG.events.map(function (e) {
        return '<button class="event-type" role="listitem" data-id="' + escapeAttr(e.id) + '">' +
          '<div class="et-body"><h3>' + escapeHtml(e.name) + "</h3>" +
          (e.description ? "<p>" + escapeHtml(e.description) + "</p>" : "") +
          '<div class="et-meta"><span>⏱ ' + e.duration + " min</span>" +
          (e.location ? '<span>📍 ' + escapeHtml(e.location) + "</span>" : "") + "</div></div>" +
          '<span class="et-arrow" aria-hidden="true">›</span></button>';
      }).join("") + "</div></div>";
    app.querySelectorAll(".event-type").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.event = CFG.events.find(function (e) { return e.id === btn.dataset.id; });
        state.monthCursor = startOfMonth(new Date());
        state.selectedDate = null; state.selectedTime = null;
        state.view = "schedule"; render();
      });
    });
    done();
  }

  // ---------- calendar + slots ----------
  function renderSchedule() {
    var rescheduleNote = state.rescheduleId
      ? '<div class="reschedule-note" role="status">↻ Rescheduling — pick a new time. Your current booking is kept until you confirm.</div>'
      : "";
    app.innerHTML =
      '<div class="scheduler"><aside class="sched-aside"><button class="back-link" id="back">‹ Back</button>' +
      hostBadge("sm") + '<p class="host-name">' + escapeHtml(CFG.host.name) + "</p>" +
      '<h2 data-autofocus tabindex="-1">' + escapeHtml(state.event.name) + "</h2>" +
      '<div class="sched-meta">' +
      '<div><span class="mi" aria-hidden="true">⏱</span><span>' + state.event.duration + " minutes</span></div>" +
      (state.event.location ? '<div><span class="mi" aria-hidden="true">📍</span><span>' + escapeHtml(state.event.location) + "</span></div>" : "") +
      '<div><span class="mi" aria-hidden="true">🌐</span>' + tzSelect() + "</div></div></aside>" +
      '<div class="sched-main">' + rescheduleNote +
      '<h3>Select a Date &amp; Time</h3>' +
      '<div class="cal-head"><strong id="monthLabel" aria-live="polite"></strong>' +
      '<div class="cal-nav"><button id="prevMonth" aria-label="Previous month">‹</button>' +
      '<button id="nextMonth" aria-label="Next month">›</button></div></div>' +
      '<div class="cal-grid" id="calGrid" role="grid" aria-label="Choose a date"></div>' +
      '<div id="slotsPanel" aria-live="polite"></div></div></div>';

    app.querySelector("#back").addEventListener("click", function () {
      if (state.rescheduleId) { state.rescheduleId = null; }
      state.view = "list"; render();
    });
    app.querySelector("#prevMonth").addEventListener("click", function () { moveMonth(-1); });
    app.querySelector("#nextMonth").addEventListener("click", function () { moveMonth(1); });
    wireTzSelect();
    drawCalendar();
    done();
  }

  function moveMonth(delta) {
    state.monthCursor = addMonths(state.monthCursor, delta);
    state.selectedDate = null; state.selectedTime = null;
    drawCalendar();
  }

  function drawCalendar() {
    var grid = app.querySelector("#calGrid");
    var label = app.querySelector("#monthLabel");
    var prev = app.querySelector("#prevMonth");
    label.textContent = state.monthCursor.toLocaleString(undefined, { month: "long", year: "numeric" });
    var thisMonth = startOfMonth(new Date());
    prev.disabled = state.monthCursor <= thisMonth;

    var dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    var html = dows.map(function (d) { return '<div class="dow" role="columnheader" aria-hidden="true">' + d + "</div>"; }).join("");
    var firstDow = state.monthCursor.getDay();
    for (var i = 0; i < firstDow; i++) html += '<div class="cal-empty" aria-hidden="true"></div>';

    var year = state.monthCursor.getFullYear(), month = state.monthCursor.getMonth();
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    var today = midnight(new Date());

    for (var day = 1; day <= daysInMonth; day++) {
      var date = new Date(year, month, day);
      var iso = isoDate(date);
      var past = date < today;
      var hasSlots = !past && dayHasWindows(iso) && withinHorizon(iso); // cheap check; exact slots load on click
      var isToday = sameDay(date, today);
      var isSel = state.selectedDate === iso;
      var cls = ["cal-day"];
      if (hasSlots) cls.push("available");
      if (isToday) cls.push("today");
      if (isSel) cls.push("selected");
      html += '<button class="' + cls.join(" ") + '" role="gridcell" data-date="' + iso + '" ' +
        (hasSlots ? "" : "disabled ") + 'aria-label="' +
        date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        (hasSlots ? ", available" : ", unavailable") + '"' + (isSel ? ' aria-current="date"' : "") + ">" + day + "</button>";
    }
    grid.innerHTML = html;

    var buttons = Array.prototype.slice.call(grid.querySelectorAll(".cal-day"));
    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.disabled) return;
        state.selectedDate = btn.dataset.date; state.selectedTime = null;
        drawCalendar(); loadSlots();
      });
    });
    // Keyboard: arrow keys move focus across enabled days.
    grid.addEventListener("keydown", function (e) {
      var idx = buttons.indexOf(document.activeElement);
      if (idx < 0) return;
      var delta = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? 7 : e.key === "ArrowUp" ? -7 : 0;
      if (!delta) return;
      e.preventDefault();
      var i = idx + delta;
      while (i >= 0 && i < buttons.length && buttons[i].disabled) i += (delta > 0 ? 1 : -1);
      if (i >= 0 && i < buttons.length && !buttons[i].disabled) buttons[i].focus();
    });

    if (state.selectedDate) loadSlots(); else drawSlotsEmpty();
  }

  function drawSlotsEmpty() {
    var panel = app.querySelector("#slotsPanel");
    if (panel) panel.innerHTML = '<p class="empty-hint">Pick a highlighted date to see available times.</p>';
  }

  function loadSlots() {
    var panel = app.querySelector("#slotsPanel");
    if (!panel) return;
    var date = state.selectedDate;
    panel.innerHTML = '<p class="slots-date">' + humanDate(date) + '</p><p class="empty-hint">Loading times…</p>';
    store.getSlots(state.event.id, date).then(function (slots) {
      if (state.selectedDate !== date) return; // user moved on
      renderSlots(panel, date, slots);
    }).catch(function (err) {
      panel.innerHTML = '<p class="empty-hint" role="alert">' + escapeHtml(err.message || "Could not load times.") + "</p>";
    });
  }

  function renderSlots(panel, date, slots) {
    // Hide past times when the selected day is today (host local clock).
    var now = new Date();
    if (date === isoDate(now)) {
      var nowMin = now.getHours() * 60 + now.getMinutes();
      slots = slots.filter(function (s) { return s.start > nowMin; });
    }
    var tzLabel = shortTz(state.tz);
    if (!slots.length) {
      panel.innerHTML = '<p class="slots-date">' + humanDate(date) + '</p><p class="empty-hint">No times available on this day.</p>';
      return;
    }
    panel.innerHTML = '<div class="slots-panel"><p class="slots-date">' + humanDate(date) + "</p>" +
      '<p class="slots-tz">Times in ' + escapeHtml(tzLabel) + "</p>" +
      '<div class="slots-list" role="list">' + slots.map(function (s) {
        var disp = displayTime(date, s.start);
        return '<button class="slot-btn" role="listitem" data-start="' + s.start + '">' +
          escapeHtml(disp.time) + (disp.dayDelta ? ' <span class="day-delta">' + (disp.dayDelta > 0 ? "+1d" : "−1d") + "</span>" : "") + "</button>";
      }).join("") + "</div></div>";

    panel.querySelectorAll(".slot-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var already = btn.classList.contains("confirming");
        panel.querySelectorAll(".slot-btn").forEach(function (b) {
          b.classList.remove("confirming"); b.innerHTML = b.dataset.html || b.innerHTML;
        });
        if (already) return;
        var start = parseInt(btn.dataset.start, 10);
        var disp = displayTime(date, start);
        btn.dataset.html = escapeHtml(disp.time);
        btn.classList.add("confirming");
        btn.innerHTML = '<span class="slot-time">' + escapeHtml(disp.time) + '</span><span class="slot-next">Next</span>';
        btn.querySelector(".slot-next").addEventListener("click", function (ev) {
          ev.stopPropagation();
          var slot = slots.find(function (x) { return x.start === start; });
          state.selectedTime = { start: slot.start, end: slot.end, label: slot.label };
          state.view = "confirm"; render();
        });
      });
    });
  }

  // ---------- confirm ----------
  function renderConfirm() {
    var when = whenLabel();
    app.innerHTML =
      '<div class="scheduler"><aside class="sched-aside"><button class="back-link" id="back">‹ Back</button>' +
      hostBadge("sm") + '<p class="host-name">' + escapeHtml(CFG.host.name) + "</p>" +
      '<h2>' + escapeHtml(state.event.name) + "</h2><div class=\"sched-meta\">" +
      '<div><span class="mi" aria-hidden="true">⏱</span><span>' + state.event.duration + " minutes</span></div>" +
      '<div><span class="mi" aria-hidden="true">📅</span><span>' + escapeHtml(when) + "</span></div>" +
      (state.event.location ? '<div><span class="mi" aria-hidden="true">📍</span><span>' + escapeHtml(state.event.location) + "</span></div>" : "") +
      '<div><span class="mi" aria-hidden="true">🌐</span><span>' + escapeHtml(shortTz(state.tz)) + "</span></div></div></aside>" +
      '<div class="sched-main"><h3 data-autofocus tabindex="-1">Enter Details</h3>' +
      '<form class="confirm-form" id="confirmForm" novalidate>' +
      '<div class="hp-field" aria-hidden="true"><label>Company<input type="text" name="company" tabindex="-1" autocomplete="off" /></label></div>' +
      field("name", "Name", "text", state.form.name, true, "Please enter your name.") +
      field("email", "Email", "email", state.form.email, true, "Please enter a valid email address.") +
      '<div class="field" id="f-notes"><label for="i-notes">Please share anything that will help prepare for our meeting</label>' +
      '<textarea id="i-notes" name="notes" placeholder="Optional">' + escapeHtml(state.form.notes) + "</textarea></div>" +
      '<div class="form-actions"><button type="submit" class="btn btn-primary btn-lg" id="submitBtn">' +
      (state.rescheduleId ? "Confirm Reschedule" : "Schedule Event") + "</button></div></form></div></div>";

    app.querySelector("#back").addEventListener("click", function () { state.view = "schedule"; render(); });

    var form = app.querySelector("#confirmForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var name = form.name.value.trim(), email = form.email.value.trim(), notes = form.notes.value.trim();
      state.form = { name: name, email: email, notes: notes };
      var ok = true;
      var nf = app.querySelector("#f-name"), ef = app.querySelector("#f-email");
      nf.classList.remove("invalid"); ef.classList.remove("invalid");
      if (!name) { nf.classList.add("invalid"); ok = false; }
      if (!isEmail(email)) { ef.classList.add("invalid"); ok = false; }
      if (!ok) { var bad = app.querySelector(".field.invalid input"); if (bad) bad.focus(); return; }

      var btn = app.querySelector("#submitBtn");
      btn.disabled = true; btn.textContent = "Scheduling…";
      var payload = { event: state.event.id, date: state.selectedDate, start: state.selectedTime.start, name: name, email: email, notes: notes, tz: state.tz, company: form.company ? form.company.value : "" };
      store.createBooking(payload).then(function (booking) {
        // Reschedule: the new booking is in, cancel the old one.
        if (state.rescheduleId) {
          var old = state.rescheduleId; state.rescheduleId = null;
          return store.cancelBooking(old).catch(function () {}).then(function () { return booking; });
        }
        return booking;
      }).then(function (booking) {
        state.booking = booking; state.view = "success"; render();
      }).catch(function (err) {
        btn.disabled = false; btn.textContent = state.rescheduleId ? "Confirm Reschedule" : "Schedule Event";
        var box = app.querySelector(".form-actions");
        var msg = box.querySelector(".form-error") || document.createElement("p");
        msg.className = "form-error"; msg.setAttribute("role", "alert");
        msg.textContent = err.message || "Something went wrong. Please try another time.";
        if (!msg.parentNode) box.appendChild(msg);
        // A taken slot means our view is stale — send them back to pick again.
        if (/just taken|already/i.test(err.message || "")) {
          setTimeout(function () { state.view = "schedule"; render(); }, 1400);
        }
      });
    });
    done();
  }

  // ---------- success ----------
  function renderSuccess() {
    var b = state.booking;
    var when = bookingWhen(b);
    var manageUrl = location.pathname + "?manage=" + encodeURIComponent(b.id);
    app.innerHTML =
      '<div class="success-panel"><div class="success-check" aria-hidden="true">✓</div>' +
      '<h2 data-autofocus tabindex="-1">You\'re booked!</h2>' +
      '<p>A calendar invitation has been sent to <strong>' + escapeHtml(b.email) + "</strong>.</p>" +
      summaryCard(b, when) +
      '<div class="success-actions">' +
      '<a class="btn btn-outline" id="dlIcs" href="#" download="meetly-booking.ics">Add to calendar</a>' +
      '<a class="btn btn-ghost" href="' + escapeAttr(manageUrl) + '">Manage booking</a>' +
      "</div>" +
      '<div class="form-actions" style="justify-content:center;margin-top:10px;">' +
      '<button class="btn btn-ghost" id="again">Book another meeting</button></div></div>';

    // Build the .ics on click so the download reflects this exact booking.
    var dl = app.querySelector("#dlIcs");
    dl.addEventListener("click", function (e) {
      e.preventDefault();
      var blob = new Blob([buildIcs(b)], { type: "text/calendar" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = "meetly-" + b.id + ".ics"; a.click();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    });
    app.querySelector("#again").addEventListener("click", function () {
      resetToList();
    });
    done();
  }

  // ---------- manage (cancel / reschedule an existing booking) ----------
  function openManage(id) {
    state.view = "loading"; render();
    return store.getBooking(id).then(function (b) {
      state.booking = b; state.view = "manage"; render();
    }).catch(function () {
      state.booking = null; state.view = "manage"; render();
    });
  }

  function renderManage() {
    var b = state.booking;
    if (!b) {
      app.innerHTML = '<div class="success-panel"><h2 data-autofocus tabindex="-1">Booking not found</h2>' +
        '<p>We couldn\'t find a booking with that code. It may have been made in a different browser.</p>' +
        '<div class="form-actions" style="justify-content:center;"><button class="btn btn-primary" id="toList">Book a meeting</button></div></div>';
      app.querySelector("#toList").addEventListener("click", resetToList);
      done(); return;
    }
    if (b.canceled) {
      app.innerHTML = '<div class="success-panel"><div class="success-check canceled" aria-hidden="true">✕</div>' +
        '<h2 data-autofocus tabindex="-1">This booking was cancelled</h2>' +
        summaryCard(b, bookingWhen(b)) +
        '<div class="form-actions" style="justify-content:center;"><button class="btn btn-primary" id="toList">Book a new time</button></div></div>';
      app.querySelector("#toList").addEventListener("click", resetToList);
      done(); return;
    }
    app.innerHTML = '<div class="success-panel"><h2 data-autofocus tabindex="-1">Manage your booking</h2>' +
      summaryCard(b, bookingWhen(b)) +
      '<div class="success-actions">' +
      '<button class="btn btn-outline" id="reschedule">Reschedule</button>' +
      '<button class="btn btn-danger" id="cancel">Cancel booking</button></div></div>';

    app.querySelector("#reschedule").addEventListener("click", function () {
      state.event = CFG.events.find(function (e) { return e.id === b.event; }) || { id: b.event, name: b.eventName, duration: b.duration, location: b.location };
      state.rescheduleId = b.id;
      state.form = { name: b.name, email: b.email, notes: b.notes };
      state.monthCursor = startOfMonth(new Date());
      state.selectedDate = null; state.selectedTime = null;
      state.view = "schedule"; render();
    });
    app.querySelector("#cancel").addEventListener("click", function () {
      var btn = app.querySelector("#cancel");
      btn.disabled = true; btn.textContent = "Cancelling…";
      store.cancelBooking(b.id).then(function () { b.canceled = true; render(); done(); })
        .catch(function (err) { btn.disabled = false; btn.textContent = "Cancel booking"; alert(err.message || "Could not cancel."); });
    });
    done();
  }

  function resetToList() {
    state.event = null; state.selectedDate = null; state.selectedTime = null;
    state.form = { name: "", email: "", notes: "" }; state.booking = null; state.rescheduleId = null;
    if (location.search) history.replaceState(null, "", location.pathname);
    state.view = "list"; render();
  }

  // ---------- small view helpers ----------
  function field(name, label, type, value, required, err) {
    return '<div class="field" id="f-' + name + '"><label for="i-' + name + '">' + label +
      (required ? ' <span class="req" aria-hidden="true">*</span>' : "") + "</label>" +
      '<input id="i-' + name + '" type="' + type + '" name="' + name + '" value="' + escapeAttr(value) + '" ' +
      'autocomplete="' + name + '"' + (required ? " required" : "") + " />" +
      '<div class="err">' + err + "</div></div>";
  }
  function summaryCard(b, when) {
    return '<div class="summary-card">' +
      '<div class="row"><span class="mi" aria-hidden="true">📋</span><div><b>' + escapeHtml(b.eventName || b.event) + "</b><span>Confirmation " + escapeHtml(b.id) + "</span></div></div>" +
      '<div class="row"><span class="mi" aria-hidden="true">👤</span><div><b>' + escapeHtml(CFG.host.name) + "</b><span>with " + escapeHtml(b.name) + "</span></div></div>" +
      '<div class="row"><span class="mi" aria-hidden="true">📅</span><div><b>' + escapeHtml(when) + "</b><span>" + b.duration + " minutes · " + escapeHtml(shortTz(b.tz || state.tz)) + "</span></div></div>" +
      (b.location ? '<div class="row"><span class="mi" aria-hidden="true">📍</span><div><b>' + escapeHtml(b.location) + "</b><span>Details in your invitation</span></div></div>" : "") +
      (b.notes ? '<div class="row"><span class="mi" aria-hidden="true">📝</span><div><b>Notes</b><span>' + escapeHtml(b.notes) + "</span></div></div>" : "") +
      "</div>";
  }
  function tzSelect() {
    var opts = TZ_LIST.map(function (z) {
      return '<option value="' + escapeAttr(z) + '"' + (z === state.tz ? " selected" : "") + ">" + escapeHtml(shortTz(z)) + "</option>";
    }).join("");
    return '<select class="tz-select" id="tzSelect" aria-label="Time zone">' + opts + "</select>";
  }
  function wireTzSelect() {
    var sel = app.querySelector("#tzSelect");
    if (sel) sel.addEventListener("change", function () {
      state.tz = sel.value;
      if (state.selectedDate) loadSlots();
    });
  }

  // ---------- timezone conversion ----------
  // Host availability is defined in the host's local clock. We convert each
  // slot's wall-clock time to the viewer's chosen zone for display.
  function hostTz() { return (CFG.host && CFG.host.timezone) || "America/New_York"; }

  function tzOffsetMinutes(tz, date) {
    var dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var p = {};
    dtf.formatToParts(date).forEach(function (x) { p[x.type] = x.value; });
    var hour = p.hour === "24" ? 0 : parseInt(p.hour, 10);
    var asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, hour, +p.minute, +p.second);
    return (asUTC - date.getTime()) / 60000;
  }
  function hostInstant(dateStr, minutes) {
    var tz = hostTz();
    var p = dateStr.split("-").map(Number);
    var guess = Date.UTC(p[0], p[1] - 1, p[2], Math.floor(minutes / 60), minutes % 60);
    var off = tzOffsetMinutes(tz, new Date(guess));
    var utc = guess - off * 60000;
    var off2 = tzOffsetMinutes(tz, new Date(utc));
    if (off2 !== off) utc = guess - off2 * 60000;
    return utc;
  }
  function displayTime(dateStr, minutes) {
    try {
      var utc = hostInstant(dateStr, minutes);
      var d = new Date(utc);
      var time = new Intl.DateTimeFormat(undefined, { timeZone: state.tz, hour: "numeric", minute: "2-digit" }).format(d).replace(/\s+/g, "").toLowerCase();
      var viewerDate = dateInZone(utc, state.tz);
      var delta = viewerDate < dateStr ? -1 : viewerDate > dateStr ? 1 : 0;
      return { time: time, dayDelta: delta };
    } catch (_) {
      return { time: minutesLabel(minutes), dayDelta: 0 };
    }
  }
  function dateInZone(utcMs, tz) {
    var p = {};
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(utcMs)).forEach(function (x) { p[x.type] = x.value; });
    return p.year + "-" + p.month + "-" + p.day;
  }
  function whenLabel() {
    var disp = displayTime(state.selectedDate, state.selectedTime.start);
    var extra = disp.dayDelta ? (disp.dayDelta > 0 ? " (next day)" : " (previous day)") : "";
    return disp.time + extra + ", " + humanDate(state.selectedDate);
  }
  function bookingWhen(b) {
    var disp = displayTimeIn(b.date, b.start, b.tz || state.tz);
    return disp + ", " + humanDate(b.date);
  }
  function displayTimeIn(dateStr, minutes, tz) {
    try {
      var utc = hostInstant(dateStr, minutes);
      return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(utc)).replace(/\s+/g, "").toLowerCase();
    } catch (_) { return minutesLabel(minutes); }
  }

  // ---------- .ics generation ----------
  function buildIcs(b) {
    var startUtc = hostInstant(b.date, b.start);
    var endUtc = startUtc + b.duration * 60000;
    function z(ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
    var lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Meetly//Scheduling Demo//EN", "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT", "UID:" + b.id + "@meetly.demo", "DTSTAMP:" + z(Date.now()),
      "DTSTART:" + z(startUtc), "DTEND:" + z(endUtc),
      "SUMMARY:" + icsEsc(b.eventName || b.event) + " with " + icsEsc(CFG.host.name),
      "DESCRIPTION:" + icsEsc("Booked via Meetly." + (b.notes ? " Notes: " + b.notes : "")),
      b.location ? "LOCATION:" + icsEsc(b.location) : "",
      "END:VEVENT", "END:VCALENDAR"
    ].filter(Boolean);
    return lines.join("\r\n");
  }
  function icsEsc(s) { return String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n"); }

  // ---------- date utils ----------
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }
  function isoDate(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function humanDate(iso) {
    var p = iso.split("-").map(Number);
    return new Date(p[0], p[1] - 1, p[2]).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  }
  function dayHasWindows(iso) {
    var p = iso.split("-").map(Number);
    var wd = new Date(p[0], p[1] - 1, p[2]).getDay();
    var w = CFG.hours && CFG.hours[wd];
    return !!(w && w.length);
  }
  function withinHorizon(iso) {
    var horizon = CFG.horizonDays || 0;
    if (horizon <= 0) return true;
    var tz = hostTz();
    var today = dateInZone(Date.now(), tz);
    if (iso < today) return false;
    var maxDate = dateInZone(hostInstant(today, 0) + horizon * 86400000, tz);
    return iso <= maxDate;
  }
  function minutesLabel(min) {
    var h = Math.floor(min / 60), m = min % 60, ampm = h >= 12 ? "pm" : "am";
    h = h % 12; if (h === 0) h = 12;
    return h + ":" + (m === 0 ? "00" : String(m).padStart(2, "0")) + ampm;
  }

  // ---------- tz list / labels ----------
  function detectTz() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York"; } catch (_) { return "America/New_York"; } }
  function buildTzList() {
    var common = [
      "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York",
      "America/Sao_Paulo", "Europe/London", "Europe/Paris", "Europe/Berlin",
      "Africa/Johannesburg", "Asia/Dubai", "Asia/Kolkata", "Asia/Singapore",
      "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "UTC"
    ];
    var mine = detectTz();
    if (common.indexOf(mine) === -1) common.unshift(mine);
    return common;
  }
  function shortTz(tz) {
    if (!tz) return "Local time";
    var city = tz.split("/").pop().replace(/_/g, " ");
    try {
      var abbr = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date())
        .find(function (p) { return p.type === "timeZoneName"; });
      return city + (abbr ? " (" + abbr.value + ")" : "");
    } catch (_) { return city; }
  }

  // ---------- misc ----------
  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
  function escapeHtml(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function escapeAttr(s) { return escapeHtml(s); }
})();
