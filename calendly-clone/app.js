/* ==========================================================================
   Meetly — Calendly-style scheduling flow (personal clone)
   Pure client-side. Mock host, event types, and availability.
   States: list -> schedule (calendar + slots) -> confirm -> success
   ========================================================================== */

(function () {
  "use strict";

  // ---------- Mock data ----------
  const HOST = {
    name: "Alex Lark",
    initials: "AL",
    title: "Product Advisor",
    timezone: guessTimezone(),
  };

  const EVENT_TYPES = [
    {
      id: "intro-15",
      name: "15 Minute Intro Call",
      duration: 15,
      description: "A quick introduction to see if we're a good fit.",
      location: "Google Meet (link sent after booking)",
    },
    {
      id: "meeting-30",
      name: "30 Minute Meeting",
      duration: 30,
      description: "A focused conversation about your project or question.",
      location: "Zoom (link sent after booking)",
    },
    {
      id: "deep-60",
      name: "60 Minute Deep Dive",
      duration: 60,
      description: "An in-depth working session. Bring your questions.",
      location: "Phone call",
    },
  ];

  // Business hours (local), by weekday. 0 = Sunday ... 6 = Saturday.
  // Each entry: array of [startHour, endHour] windows. Empty = day off.
  const HOURS = {
    0: [], // Sun
    1: [[9, 12], [13, 17]],
    2: [[9, 12], [13, 17]],
    3: [[9, 12], [13, 17]],
    4: [[9, 12], [13, 17]],
    5: [[9, 12], [13, 16]],
    6: [], // Sat
  };

  const SLOT_STEP = 30; // minutes between slot starts

  // ---------- App state ----------
  const state = {
    view: "list",       // list | schedule | confirm | success
    event: null,        // selected event type
    monthCursor: startOfMonth(new Date()),
    selectedDate: null, // Date at midnight
    selectedTime: null, // { hour, minute, label }
    form: { name: "", email: "", notes: "" },
    booking: null,      // finalized booking summary
  };

  const app = document.getElementById("app");
  render();

  // ---------- Router / renderer ----------
  function render() {
    if (state.view === "list") return renderList();
    if (state.view === "schedule") return renderSchedule();
    if (state.view === "confirm") return renderConfirm();
    if (state.view === "success") return renderSuccess();
  }

  // ---------- View: event type list ----------
  function renderList() {
    app.innerHTML = `
      <div class="event-list">
        <div class="host-card">
          <div class="avatar-lg">${HOST.initials}</div>
          <h1>${HOST.name}</h1>
          <p>${HOST.title} · Pick a meeting type below to get started</p>
        </div>
        <div class="event-types">
          ${EVENT_TYPES.map(function (e) {
            return `
              <button class="event-type" data-id="${e.id}">
                <div class="et-body">
                  <h3>${escapeHtml(e.name)}</h3>
                  <p>${escapeHtml(e.description)}</p>
                  <div class="et-meta">
                    <span>⏱ ${e.duration} min</span>
                    <span>📍 ${escapeHtml(e.location)}</span>
                  </div>
                </div>
                <span class="et-arrow">›</span>
              </button>`;
          }).join("")}
        </div>
      </div>`;

    app.querySelectorAll(".event-type").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.event = EVENT_TYPES.find(function (e) { return e.id === btn.dataset.id; });
        state.monthCursor = startOfMonth(new Date());
        state.selectedDate = null;
        state.selectedTime = null;
        state.view = "schedule";
        render();
      });
    });
  }

  // ---------- View: calendar + slots ----------
  function renderSchedule() {
    app.innerHTML = `
      <div class="scheduler">
        <aside class="sched-aside">
          <button class="back-link" id="back">‹ Back</button>
          <div class="avatar-lg">${HOST.initials}</div>
          <p class="host-name">${HOST.name}</p>
          <h2>${escapeHtml(state.event.name)}</h2>
          <div class="sched-meta">
            <div><span class="mi">⏱</span><span>${state.event.duration} minutes</span></div>
            <div><span class="mi">📍</span><span>${escapeHtml(state.event.location)}</span></div>
            <div><span class="mi">🌐</span><span>${escapeHtml(HOST.timezone)}</span></div>
          </div>
        </aside>
        <div class="sched-main">
          <h3>Select a Date &amp; Time</h3>
          <div class="sched-body">
            <div class="cal-head">
              <strong id="monthLabel"></strong>
              <div class="cal-nav">
                <button id="prevMonth" aria-label="Previous month">‹</button>
                <button id="nextMonth" aria-label="Next month">›</button>
              </div>
            </div>
            <div class="cal-grid" id="calGrid"></div>
            <div id="slotsPanel"></div>
          </div>
        </div>
      </div>`;

    app.querySelector("#back").addEventListener("click", function () {
      state.view = "list";
      render();
    });
    app.querySelector("#prevMonth").addEventListener("click", function () {
      state.monthCursor = addMonths(state.monthCursor, -1);
      state.selectedDate = null; state.selectedTime = null;
      drawCalendar();
    });
    app.querySelector("#nextMonth").addEventListener("click", function () {
      state.monthCursor = addMonths(state.monthCursor, 1);
      state.selectedDate = null; state.selectedTime = null;
      drawCalendar();
    });

    drawCalendar();
  }

  function drawCalendar() {
    const grid = app.querySelector("#calGrid");
    const label = app.querySelector("#monthLabel");
    const prev = app.querySelector("#prevMonth");
    label.textContent = state.monthCursor.toLocaleString(undefined, { month: "long", year: "numeric" });

    // Disable going before the current month
    const thisMonth = startOfMonth(new Date());
    prev.disabled = state.monthCursor <= thisMonth;

    const dows = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let html = dows.map(function (d) { return `<div class="dow">${d}</div>`; }).join("");

    const firstDow = state.monthCursor.getDay();
    for (let i = 0; i < firstDow; i++) html += `<div class="cal-empty"></div>`;

    const daysInMonth = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth() + 1, 0).getDate();
    const today = midnight(new Date());

    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth(), day);
      const past = date < today;
      const hasSlots = !past && dayHasAvailability(date);
      const isToday = sameDay(date, today);
      const isSel = state.selectedDate && sameDay(date, state.selectedDate);

      const cls = ["cal-day"];
      if (hasSlots) cls.push("available");
      if (isToday) cls.push("today");
      if (isSel) cls.push("selected");

      html += `<button class="${cls.join(" ")}" data-day="${day}" ${hasSlots ? "" : "disabled"}>${day}</button>`;
    }

    grid.innerHTML = html;

    grid.querySelectorAll(".cal-day:not([disabled])").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const day = parseInt(btn.dataset.day, 10);
        state.selectedDate = new Date(state.monthCursor.getFullYear(), state.monthCursor.getMonth(), day);
        state.selectedTime = null;
        drawCalendar();
        drawSlots();
        const panel = app.querySelector("#slotsPanel");
        if (panel) panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    });

    drawSlots();
  }

  function drawSlots() {
    const panel = app.querySelector("#slotsPanel");
    if (!panel) return;

    if (!state.selectedDate) {
      panel.innerHTML = `<p class="empty-hint">Pick a highlighted date to see available times.</p>`;
      return;
    }

    const slots = slotsForDate(state.selectedDate);
    const dateLabel = state.selectedDate.toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric",
    });

    if (!slots.length) {
      panel.innerHTML = `<p class="slots-date">${dateLabel}</p><p class="empty-hint">No times available on this day.</p>`;
      return;
    }

    panel.innerHTML = `
      <div class="slots-panel">
        <p class="slots-date">${dateLabel}</p>
        <div class="slots-list">
          ${slots.map(function (s) {
            return `<button class="slot-btn" data-h="${s.hour}" data-m="${s.minute}">${s.label}</button>`;
          }).join("")}
        </div>
      </div>`;

    panel.querySelectorAll(".slot-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        // First click: expand to time + Next (Calendly-style confirm)
        const already = btn.classList.contains("confirming");
        panel.querySelectorAll(".slot-btn").forEach(function (b) {
          b.classList.remove("confirming");
          b.innerHTML = b.dataset.label || b.textContent;
        });
        if (already) return;

        const label = slotLabel(parseInt(btn.dataset.h, 10), parseInt(btn.dataset.m, 10));
        btn.dataset.label = label;
        btn.classList.add("confirming");
        btn.innerHTML = `<span class="slot-time">${label}</span><span class="slot-next">Next</span>`;

        btn.querySelector(".slot-next").addEventListener("click", function (ev) {
          ev.stopPropagation();
          state.selectedTime = {
            hour: parseInt(btn.dataset.h, 10),
            minute: parseInt(btn.dataset.m, 10),
            label: label,
          };
          state.view = "confirm";
          render();
        });
      });
    });
  }

  // ---------- View: confirm form ----------
  function renderConfirm() {
    const when = fullWhenLabel();
    app.innerHTML = `
      <div class="scheduler">
        <aside class="sched-aside">
          <button class="back-link" id="back">‹ Back</button>
          <div class="avatar-lg">${HOST.initials}</div>
          <p class="host-name">${HOST.name}</p>
          <h2>${escapeHtml(state.event.name)}</h2>
          <div class="sched-meta">
            <div><span class="mi">⏱</span><span>${state.event.duration} minutes</span></div>
            <div><span class="mi">📅</span><span>${when}</span></div>
            <div><span class="mi">📍</span><span>${escapeHtml(state.event.location)}</span></div>
            <div><span class="mi">🌐</span><span>${escapeHtml(HOST.timezone)}</span></div>
          </div>
        </aside>
        <div class="sched-main">
          <h3>Enter Details</h3>
          <form class="confirm-form" id="confirmForm" novalidate>
            <div class="field" id="f-name">
              <label>Name <span class="req">*</span></label>
              <input type="text" name="name" value="${escapeHtml(state.form.name)}" autocomplete="name" />
              <div class="err">Please enter your name.</div>
            </div>
            <div class="field" id="f-email">
              <label>Email <span class="req">*</span></label>
              <input type="email" name="email" value="${escapeHtml(state.form.email)}" autocomplete="email" />
              <div class="err">Please enter a valid email address.</div>
            </div>
            <div class="field" id="f-notes">
              <label>Please share anything that will help prepare for our meeting</label>
              <textarea name="notes" placeholder="Optional">${escapeHtml(state.form.notes)}</textarea>
            </div>
            <div class="form-actions">
              <button type="submit" class="btn btn-primary btn-lg">Schedule Event</button>
            </div>
          </form>
        </div>
      </div>`;

    app.querySelector("#back").addEventListener("click", function () {
      state.view = "schedule";
      render();
    });

    const form = app.querySelector("#confirmForm");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const name = form.name.value.trim();
      const email = form.email.value.trim();
      const notes = form.notes.value.trim();
      state.form = { name: name, email: email, notes: notes };

      let ok = true;
      const nf = app.querySelector("#f-name");
      const ef = app.querySelector("#f-email");
      nf.classList.remove("invalid"); ef.classList.remove("invalid");
      if (!name) { nf.classList.add("invalid"); ok = false; }
      if (!isEmail(email)) { ef.classList.add("invalid"); ok = false; }
      if (!ok) return;

      state.booking = {
        event: state.event,
        date: state.selectedDate,
        time: state.selectedTime,
        name: name, email: email, notes: notes,
        confirmation: makeConfirmationCode(),
      };
      state.view = "success";
      render();
    });
  }

  // ---------- View: success ----------
  function renderSuccess() {
    const b = state.booking;
    const when = fullWhenLabel();
    app.innerHTML = `
      <div class="success-panel">
        <div class="success-check">✓</div>
        <h2>You're booked!</h2>
        <p>A calendar invitation has been sent to <strong>${escapeHtml(b.email)}</strong>.</p>
        <div class="summary-card">
          <div class="row"><span class="mi">📋</span><div><b>${escapeHtml(b.event.name)}</b><span>Confirmation #${b.confirmation}</span></div></div>
          <div class="row"><span class="mi">👤</span><div><b>${escapeHtml(HOST.name)}</b><span>with ${escapeHtml(b.name)}</span></div></div>
          <div class="row"><span class="mi">📅</span><div><b>${when}</b><span>${state.event.duration} minutes · ${escapeHtml(HOST.timezone)}</span></div></div>
          <div class="row"><span class="mi">📍</span><div><b>${escapeHtml(b.event.location)}</b><span>Details in your invitation</span></div></div>
          ${b.notes ? `<div class="row"><span class="mi">📝</span><div><b>Notes</b><span>${escapeHtml(b.notes)}</span></div></div>` : ""}
        </div>
        <div class="form-actions" style="justify-content:center;">
          <button class="btn btn-outline" id="again">Book another meeting</button>
          <a class="btn btn-ghost" href="index.html">Back to home</a>
        </div>
      </div>`;

    app.querySelector("#again").addEventListener("click", function () {
      state.event = null; state.selectedDate = null; state.selectedTime = null;
      state.form = { name: "", email: "", notes: "" };
      state.booking = null;
      state.view = "list";
      render();
    });
  }

  // ---------- Availability logic ----------
  function dayHasAvailability(date) {
    return slotsForDate(date).length > 0;
  }

  function slotsForDate(date) {
    const windows = HOURS[date.getDay()] || [];
    if (!windows.length) return [];

    const now = new Date();
    const isToday = sameDay(date, midnight(now));
    const dur = state.event ? state.event.duration : 30;
    const slots = [];

    windows.forEach(function (w) {
      const startMin = w[0] * 60;
      const endMin = w[1] * 60;
      for (let m = startMin; m + dur <= endMin; m += SLOT_STEP) {
        const hour = Math.floor(m / 60);
        const minute = m % 60;
        // Hide past times if the date is today
        if (isToday) {
          const slotTime = new Date(date);
          slotTime.setHours(hour, minute, 0, 0);
          if (slotTime <= now) continue;
        }
        // Deterministic "busy" gaps so the calendar looks realistic
        if (isBusy(date, hour, minute)) continue;
        slots.push({ hour: hour, minute: minute, label: slotLabel(hour, minute) });
      }
    });
    return slots;
  }

  // Pseudo-random but stable "already booked" slots based on the date+time.
  function isBusy(date, hour, minute) {
    const seed = (date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate()) * 1440 + hour * 60 + minute;
    // simple hash
    let h = seed;
    h = (h ^ (h >>> 13)) * 0x5bd1e995;
    h = h ^ (h >>> 15);
    return (Math.abs(h) % 5) === 0; // ~20% of slots are "taken"
  }

  // ---------- Formatting helpers ----------
  function slotLabel(hour, minute) {
    const ampm = hour >= 12 ? "pm" : "am";
    let h12 = hour % 12; if (h12 === 0) h12 = 12;
    const mm = minute === 0 ? "00" : String(minute).padStart(2, "0");
    return h12 + ":" + mm + ampm;
  }

  function fullWhenLabel() {
    if (!state.selectedDate || !state.selectedTime) return "";
    const d = state.selectedDate.toLocaleDateString(undefined, {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
    return state.selectedTime.label + ", " + d;
  }

  function makeConfirmationCode() {
    // Deterministic-ish code from current time; fine for a demo.
    const t = new Date();
    const base = (t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds()) + t.getDate() * 100000;
    return "ML-" + base.toString(36).toUpperCase();
  }

  // ---------- Date utilities ----------
  function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
  function addMonths(d, n) { return new Date(d.getFullYear(), d.getMonth() + n, 1); }
  function midnight(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

  function guessTimezone() {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return tz ? tz.replace(/_/g, " ") : "Local time";
    } catch (e) { return "Local time"; }
  }

  function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
})();
