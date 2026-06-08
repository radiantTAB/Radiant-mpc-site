/* Radiant MPC — Light (current) / Dark theme toggle.
   Loaded synchronously in <head> so the saved theme is applied
   before first paint (no flash). The toggle button is injected
   into the nav once the DOM is ready. Choice persists in localStorage. */
(function () {
  var KEY = "radiant-theme";

  // 1) Apply saved theme immediately (default = light / current look).
  try {
    if (localStorage.getItem(KEY) === "dark") {
      document.documentElement.setAttribute("data-theme", "dark");
    }
  } catch (e) {}

  function isDark() {
    return document.documentElement.getAttribute("data-theme") === "dark";
  }

  function setTheme(dark) {
    if (dark) {
      document.documentElement.setAttribute("data-theme", "dark");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    try { localStorage.setItem(KEY, dark ? "dark" : "light"); } catch (e) {}
    swapLogos(dark);
    updateLabel();
  }

  // Swap the nav/footer logo to the white-on-transparent version in dark mode.
  function swapLogos(dark) {
    var imgs = document.querySelectorAll("img.brand-logo, img.hero-logo");
    for (var i = 0; i < imgs.length; i++) {
      var cur = imgs[i].getAttribute("src") || "";
      var next = dark
        ? cur.replace(/radiant-logo\.png/, "radiant-logo-dark.png")
        : cur.replace(/radiant-logo-dark\.png/, "radiant-logo.png");
      if (next !== cur) imgs[i].setAttribute("src", next);
    }
  }

  var btn;
  function updateLabel() {
    if (!btn) return;
    var next = isDark() ? "light" : "dark";
    btn.setAttribute("aria-label", "Switch to " + next + " mode");
    btn.setAttribute("title", "Switch to " + next + " mode");
  }

  // 2) Inject the toggle button into the nav.
  function injectButton() {
    var navLinks = document.querySelector(".nav .nav-links") || document.querySelector(".nav");
    if (!navLinks || document.querySelector(".theme-toggle")) return;

    btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-toggle";
    btn.innerHTML =
      // moon (shown in light mode → click for dark)
      '<svg class="ico-dark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>' +
      // sun (shown in dark mode → click for light)
      '<svg class="ico-light" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
      '<span class="tt-label"></span>';

    btn.addEventListener("click", function () { setTheme(!isDark()); });

    var cta = navLinks.querySelector(".nav-cta");
    if (cta) navLinks.insertBefore(btn, cta);
    else navLinks.appendChild(btn);

    swapLogos(isDark());
    updateLabel();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectButton);
  } else {
    injectButton();
  }
})();
