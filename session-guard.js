/* session-guard.js — client-side inactivity + stale-session enforcement.
 *
 * Loaded on the gated app.radiant-mpc.com pages (launcher, client portal,
 * admin tools). Works WITH the server-side idle timeout, not instead of it:
 *
 *   - Idle open tab: after IDLE_MS of no activity the tab redirects itself
 *     to the login page (instead of waiting for the next click to be bounced
 *     by the Worker gate).
 *   - Closed / reopened browser: a "last activity" timestamp is kept in
 *     localStorage. On load (and whenever the tab is re-focused) we check it;
 *     if it is older than IDLE_MS the session is treated as expired and we
 *     force a logout + login. This catches the case where Chrome/Edge
 *     "continue where you left off" restores the session cookie after a real
 *     browser close — the restored cookie is ignored because the stored
 *     activity is stale.
 *
 * It deliberately does NOT log out on pagehide/beforeunload: those fire on
 * ordinary refresh and in-app navigation too, which would sign users out
 * mid-task. The stale-activity check achieves the same goal without the
 * false positives.
 *
 * Multi-tab safe: activity in any app tab refreshes the shared timestamp via
 * the storage event, so an active second tab keeps the first one alive.
 */
(function () {
  "use strict";
  if (window.__rmpcSessionGuard) return;
  window.__rmpcSessionGuard = true;

  var IDLE_MS = 15 * 60 * 1000;          // keep in sync with the Worker IDLE_MINUTES
  var KEY = "rmpc_last_activity";
  var isAdmin = location.pathname.indexOf("/admin/") === 0;
  var LOGOUT_URL = isAdmin ? "/admin/api/logout" : "/portal/api/logout";
  var LOGIN_URL = isAdmin ? "/admin/login.html" : "/portal/login.html";

  function now() { return Date.now(); }
  function readLast() {
    var v = 0;
    try { v = parseInt(localStorage.getItem(KEY), 10); } catch (e) {}
    return v > 0 ? v : 0;
  }
  function mark() {
    try { localStorage.setItem(KEY, String(now())); } catch (e) {}
  }

  var expiring = false;
  function expire() {
    if (expiring) return;
    expiring = true;
    try { localStorage.removeItem(KEY); } catch (e) {}
    // Best-effort server-side logout; keepalive lets it finish during the
    // navigation that follows.
    try {
      fetch(LOGOUT_URL, { method: "POST", credentials: "include", keepalive: true })
        .catch(function () {});
    } catch (e) {}
    var next = encodeURIComponent(location.pathname + location.search);
    location.replace(LOGIN_URL + "?next=" + next + "&timeout=1");
  }

  // Stale on entry: browser was closed/idle past the window (even if a
  // session cookie was restored) -> force re-login immediately.
  var last = readLast();
  if (last && now() - last > IDLE_MS) { expire(); return; }
  mark();

  var timer;
  function arm() { clearTimeout(timer); timer = setTimeout(expire, IDLE_MS + 1000); }
  function activity() { if (expiring) return; mark(); arm(); }

  ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "click"].forEach(function (ev) {
    window.addEventListener(ev, activity, { passive: true });
  });

  // Another tab saw activity (or logged out) -> re-sync this tab's timer.
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    if (e.newValue === null) { expire(); return; }   // a tab logged out
    arm();
  });

  // Returning to a backgrounded/restored tab: re-check staleness.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden || expiring) return;
    var l = readLast();
    if (l && now() - l > IDLE_MS) expire(); else arm();
  });

  arm();
})();
