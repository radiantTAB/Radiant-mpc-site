/* customer-login.js — site-wide Sign In / Launch Apps control.
 *
 * Loaded by every Radiant marketing page (radiant-mpc.com/*) and by the
 * launcher (app.radiant-mpc.com/). Probes /portal/api/me and injects a
 * link-based control into the existing <nav class="nav"> .nav-links
 * container. No modals, no in-page forms — every action navigates.
 *
 * State -> visible control:
 *
 *   Not signed in, on marketing host
 *     [Sign In →]   (red pill, sends to app.radiant-mpc.com/portal/login.html)
 *
 *   Signed in, on marketing host
 *     · Customer Name   [Launch Apps →]   [Log out]
 *
 *   Signed in, on app host (the launcher itself)
 *     · Customer Name   [Log out]
 *     (no "Launch Apps" — they're already there)
 *
 *   Not signed in, on app host
 *     This shouldn't be reachable: the Worker gates app.radiant-mpc.com
 *     behind portal login and redirects unauthenticated requests to the
 *     sign-in page before this script ever runs. Defensive fallback is
 *     the same "Sign In →" pill, so nothing breaks if the gate is ever
 *     loosened.
 */
(function () {
  "use strict";
  if (window.__radiantCustomerLogin) return;
  window.__radiantCustomerLogin = true;

  var APP_BASE = "https://app.radiant-mpc.com";
  var onAppHost = (location.hostname === "app.radiant-mpc.com");

  var STYLE = [
    ".cl-wrap{display:inline-flex;align-items:center;gap:14px;margin-left:18px}",
    ".cl-pill{display:inline-flex;align-items:center;gap:7px;",
      "padding:9px 18px;border-radius:999px;",
      "font:700 13px/1 'Montserrat',system-ui,sans-serif;",
      "letter-spacing:.04em;text-transform:uppercase;",
      "transition:all .15s;text-decoration:none;cursor:pointer;border:1px solid transparent}",
    ".cl-pill-primary{background:#d00008;color:#fff!important}",
    ".cl-pill-primary:hover{background:#a80006;color:#fff!important;",
      "transform:translateY(-1px);box-shadow:0 6px 18px rgba(208,0,8,.22)}",
    ".cl-pill-ghost{background:transparent;color:#5a5a5a!important;border-color:#d8d8dc}",
    ".cl-pill-ghost:hover{border-color:#d00008;color:#d00008!important}",
    ".cl-user{display:inline-flex;align-items:center;gap:9px;",
      "font:600 13px/1 'Montserrat',system-ui,sans-serif;color:#1a1a1a;",
      "white-space:nowrap}",
    ".cl-dot{width:7px;height:7px;border-radius:50%;background:#1a7f37;flex:none}",
    "@media(max-width:720px){",
      ".cl-wrap{gap:9px;margin-left:10px}",
      ".cl-pill{padding:7px 13px;font-size:11.5px}",
      ".cl-user{font-size:12px}",
      ".cl-user-name{display:none}}"
  ].join("");

  var wrap = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function renderLoggedOut() {
    wrap.innerHTML =
      '<a class="cl-pill cl-pill-primary" href="' + APP_BASE +
      '/portal/login.html">Sign In</a>';
  }

  function renderLoggedIn(name) {
    var launchBtn = onAppHost
      ? ""
      : '<a class="cl-pill cl-pill-primary" href="' + APP_BASE +
        '/">Launch Apps</a>';
    wrap.innerHTML =
      '<span class="cl-user"><span class="cl-dot"></span>' +
      '<span class="cl-user-name">' + esc(name) + "</span></span>" +
      launchBtn +
      '<button type="button" class="cl-pill cl-pill-ghost cl-logout">Log out</button>';
    wrap.querySelector(".cl-logout").addEventListener("click", doLogout);
  }

  function refresh() {
    fetch("/portal/api/me", { credentials: "include" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && d.client && d.client.name) renderLoggedIn(d.client.name);
        else renderLoggedOut();
      })
      .catch(function () { renderLoggedOut(); });
  }

  function doLogout() {
    fetch("/portal/api/logout", { method: "POST", credentials: "include" })
      .then(function () {
        // On app host, logging out makes the page un-gated content
        // unreachable — bounce to login so the user sees a sensible
        // landing instead of the Worker's redirect-to-login flash.
        if (onAppHost) {
          location.href = APP_BASE + "/portal/login.html";
        } else {
          renderLoggedOut();
        }
      })
      .catch(function () { renderLoggedOut(); });
  }

  function mount() {
    var nav = document.querySelector("nav.nav");
    if (!nav) return;

    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    // Inject at the END of the existing nav-links container so the
    // control sits at the far-right of the nav, after the "Contact"
    // CTA on marketing pages and after "Admin/Contact" on the launcher.
    var navLinks = nav.querySelector(".nav-links");
    wrap = document.createElement("span");
    wrap.className = "cl-wrap";
    if (navLinks) navLinks.appendChild(wrap);
    else nav.appendChild(wrap);

    // Render an optimistic Sign-In pill immediately so the nav doesn't
    // visibly grow when the /me probe completes; refresh overwrites it.
    renderLoggedOut();
    refresh();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
