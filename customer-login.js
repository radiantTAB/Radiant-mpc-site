/* customer-login.js — site-wide Log in / App Suite / Log out control.
 *
 * Loaded by every Radiant marketing page (radiant-mpc.com/*) and by the
 * app-host pages (app.radiant-mpc.com/). Probes /portal/api/me (the
 * portal_session cookie is Domain=.radiant-mpc.com, so it works on both
 * hosts) and injects explicit buttons into <nav class="nav"> .nav-links.
 *
 * State -> visible control:
 *
 *   Not signed in            [Log in]
 *   Signed in, marketing     [Go to Radiant App Suite]  [Log out]
 *   Signed in, app host      ● Customer Name  [Log out]
 *                            (no App Suite button — they're already there)
 *
 * Also owns the phone-width menu button (☰): bold.css hides the plain nav
 * links under 720px, and this is the one script every marketing page loads.
 *
 * Static "Client login ↗" links (a.nav-login / a.nav-login-btn) are
 * relabelled to match the state so no link silently does something
 * different from what it says.
 */
(function () {
  "use strict";
  if (window.__radiantCustomerLogin) return;
  window.__radiantCustomerLogin = true;

  var APP_BASE = "https://app.radiant-mpc.com";
  var LOGIN_URL = APP_BASE + "/portal/login.html";
  var onAppHost = (location.hostname === "app.radiant-mpc.com");

  // Light theme: reads bold.css tokens, with fallbacks for app pages that
  // carry their own embedded :root.
  var STYLE = [
    ".cl-wrap{display:inline-flex;align-items:center;gap:10px}",
    ".nav-links .cl-pill,.cl-pill{display:inline-flex!important;align-items:center;gap:7px;",
      "padding:10px 18px;border-radius:999px;white-space:nowrap;",
      "font:800 12.5px/1 'Montserrat',system-ui,sans-serif;",
      "letter-spacing:.06em;text-transform:uppercase;",
      "transition:all .15s;text-decoration:none;cursor:pointer;border:1.5px solid transparent}",
    ".cl-pill:focus-visible{outline:2px solid var(--accent,#d00008);outline-offset:2px}",
    ".nav-links .cl-pill-primary{background:var(--accent,#d00008);color:#fff!important}",
    ".nav-links .cl-pill-primary:hover{background:var(--accent-2,#a80006);color:#fff!important;",
      "transform:translateY(-1px);box-shadow:0 10px 26px -8px rgba(208,0,8,.45)}",
    ".nav-links .cl-pill-ghost{background:#fff;color:var(--text,#1a1a1a)!important;border-color:var(--line-hi,#cdcdd1)}",
    ".nav-links .cl-pill-ghost:hover{border-color:var(--accent,#d00008);color:var(--accent,#d00008)!important;background:rgba(208,0,8,.05)}",
    ".cl-user{display:inline-flex;align-items:center;gap:8px;",
      "font:700 13px/1 'Montserrat',system-ui,sans-serif;color:var(--text,#1a1a1a);white-space:nowrap}",
    ".nav-toggle,.nav-menu{display:none}",
    ".cl-dot{width:7px;height:7px;border-radius:50%;background:#2ea043;flex:none}",
    "@media(max-width:720px){",
      ".cl-wrap{gap:8px}",
      ".nav-links .cl-pill,.cl-pill{padding:8px 12px;font-size:11px}",
      ".cl-long,.cl-user-name{display:none}",
      ".nav.cl-signed-in .nav-cta{display:none}",
      ".nav-links{margin-left:auto}",
      ".nav-toggle{display:inline-flex;flex-direction:column;justify-content:center;gap:4px;",
        "width:44px;height:44px;margin-left:10px;border:1.5px solid var(--line-hi,#cdcdd1);",
        "border-radius:12px;background:#fff;cursor:pointer;flex:none}",
      ".nav-toggle span{display:block;width:18px;height:2px;margin:0 auto;background:var(--text,#1a1a1a);transition:transform .2s,opacity .2s}",
      ".nav-open .nav-toggle span:nth-child(1){transform:translateY(6px) rotate(45deg)}",
      ".nav-open .nav-toggle span:nth-child(2){opacity:0}",
      ".nav-open .nav-toggle span:nth-child(3){transform:translateY(-6px) rotate(-45deg)}",
      ".nav-open .nav-menu{display:flex;flex-direction:column;position:absolute;top:100%;left:0;right:0;",
        "background:#fff;border-bottom:1px solid var(--line,#e6e6e8);padding:4px var(--pad-x,20px) 14px;",
        "box-shadow:0 18px 30px -18px rgba(0,0,0,.25)}",
      ".nav-menu a{padding:15px 0;border-bottom:1px solid var(--line,#e6e6e8);color:var(--text,#1a1a1a);",
        "font:700 14px/1 'Montserrat',system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase}",
      ".nav-menu a:last-child{border-bottom:none}}"
  ].join("");

  var wrap = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // Keep the static footer/CTA links honest about where they go.
  function relabelStaticLinks(signedIn) {
    var links = document.querySelectorAll("a.nav-login, a.nav-login-btn");
    for (var i = 0; i < links.length; i++) {
      if (wrap && wrap.contains(links[i])) continue;
      links[i].textContent = signedIn ? "Radiant App Suite ↗" : "Client login ↗";
      links[i].href = signedIn ? APP_BASE + "/" : LOGIN_URL;
    }
  }

  function renderLoggedOut() {
    wrap.innerHTML =
      '<a class="cl-pill cl-pill-primary" href="' + LOGIN_URL + '">Log in</a>';
    relabelStaticLinks(false);
    wrap.parentNode.closest("nav").classList.remove("cl-signed-in");
  }

  function renderLoggedIn(name) {
    var left = onAppHost
      ? '<span class="cl-user" title="Signed in as ' + esc(name) + '"><span class="cl-dot"></span>' +
        '<span class="cl-user-name">' + esc(name) + "</span></span>"
      : '<a class="cl-pill cl-pill-primary" href="' + APP_BASE + '/">' +
        '<span>Go to <span class="cl-long">Radiant </span>App Suite</span></a>';
    wrap.innerHTML = left +
      '<button type="button" class="cl-pill cl-pill-ghost cl-logout" title="Signed in as ' +
      esc(name) + '">Log out</button>';
    wrap.querySelector(".cl-logout").addEventListener("click", doLogout);
    relabelStaticLinks(true);
    // Phone widths: drop the nav Contact pill so the logo keeps its room.
    wrap.parentNode.closest("nav").classList.add("cl-signed-in");
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
        // App-host pages are gated; land on the login page instead of
        // the Worker's redirect flash.
        if (onAppHost) location.href = LOGIN_URL;
        else renderLoggedOut();
      })
      .catch(function () { renderLoggedOut(); });
  }

  function mount() {
    var nav = document.querySelector("nav.nav");
    if (!nav) return;

    var style = document.createElement("style");
    style.textContent = STYLE;
    document.head.appendChild(style);

    // Far right of the nav, after the "Contact" CTA.
    var navLinks = nav.querySelector(".nav-links");
    wrap = document.createElement("span");
    wrap.className = "cl-wrap";
    (navLinks || nav).appendChild(wrap);

    mountMenu(nav, navLinks);

    // Optimistic "Log in" (most visitors); refresh() overwrites it.
    renderLoggedOut();
    refresh();
  }

  // Phone menu: a ☰ button that drops down the links bold.css hides.
  function mountMenu(nav, navLinks) {
    if (!navLinks) return;
    var links = navLinks.querySelectorAll("a:not(.nav-cta):not(.cl-pill)");
    if (!links.length) return;
    var menu = document.createElement("div");
    menu.className = "nav-menu";
    menu.id = "nav-menu";
    for (var i = 0; i < links.length; i++) menu.appendChild(links[i].cloneNode(true));
    var contact = navLinks.querySelector(".nav-cta");
    if (contact) menu.appendChild(contact.cloneNode(true)).className = "";

    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "nav-toggle";
    btn.setAttribute("aria-label", "Menu");
    btn.setAttribute("aria-controls", "nav-menu");
    btn.setAttribute("aria-expanded", "false");
    btn.innerHTML = "<span></span><span></span><span></span>";
    nav.appendChild(btn);
    nav.appendChild(menu);

    function set(open) {
      nav.classList.toggle("nav-open", open);
      btn.setAttribute("aria-expanded", String(open));
    }
    btn.addEventListener("click", function () { set(!nav.classList.contains("nav-open")); });
    menu.addEventListener("click", function (e) { if (e.target.closest("a")) set(false); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") set(false); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
