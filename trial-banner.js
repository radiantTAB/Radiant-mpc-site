// trial-banner.js -- thin top band shown on every /app/ surface that is a
// trial sandbox (the launcher and the embedded /app/apps/*/index.html pages).
//
// Phase 1 of the business expansion proposal repositions app.radiant-mpc.com
// as a try-before-you-buy demo: data is stored only in the user's browser
// (localStorage / IndexedDB) and may not survive a cache wipe. This banner
// makes that explicit, so a prospect never assumes the web version IS the
// product, and CTAs them toward the licensed desktop install.
//
// Loaded as a shared asset from the site root (see isSharedAsset in
// worker/index.js). Self-contained: injects its own CSS, runs once per page,
// no external dependencies.

(function () {
  if (document.querySelector('.radiant-trial-band')) return;

  var css =
    '.radiant-trial-band{' +
      'font-family:Montserrat,system-ui,sans-serif;' +
      'background:#d00008;color:#fff;' +
      'font-size:13px;line-height:1.4;' +
      'border-bottom:1px solid #a80006;' +
      'position:relative;z-index:60;' +
    '}' +
    '.radiant-trial-band a{color:#fff;text-decoration:underline;text-underline-offset:3px}' +
    '.radiant-trial-band a:hover{text-decoration:none;color:#fff}' +
    '.radiant-trial-band-inner{' +
      'max-width:1180px;margin:0 auto;' +
      'padding:9px clamp(16px,5vw,64px);' +
      'display:flex;align-items:center;gap:14px;flex-wrap:wrap;' +
    '}' +
    '.radiant-trial-band-tag{' +
      'font-family:"JetBrains Mono","Consolas",monospace;' +
      'font-size:10.5px;letter-spacing:.14em;font-weight:700;' +
      'text-transform:uppercase;' +
      'background:rgba(255,255,255,.16);' +
      'padding:3px 9px;border-radius:999px;flex-shrink:0;' +
    '}' +
    '.radiant-trial-band-msg{flex:1;min-width:220px}' +
    '.radiant-trial-band-cta{font-weight:700;white-space:nowrap}' +
    '@media (max-width:640px){' +
      '.radiant-trial-band-inner{gap:10px}' +
      '.radiant-trial-band-msg{flex:1 1 100%}' +
    '}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  var band = document.createElement('div');
  band.className = 'radiant-trial-band';
  band.setAttribute('role', 'note');
  band.innerHTML =
    '<div class="radiant-trial-band-inner">' +
      '<span class="radiant-trial-band-tag">Trial Sandbox</span>' +
      '<span class="radiant-trial-band-msg">' +
        'Data is saved only in this browser and may clear if cookies are wiped. ' +
        'Production users run a licensed desktop install.' +
      '</span>' +
      '<a class="radiant-trial-band-cta" href="https://radiant-mpc.com/contact.html">' +
        'Request desktop install →' +
      '</a>' +
    '</div>';

  if (document.body && document.body.firstChild) {
    document.body.insertBefore(band, document.body.firstChild);
  } else if (document.body) {
    document.body.appendChild(band);
  } else {
    // <body> not parsed yet (script in <head> without defer). Defer to DOMContentLoaded.
    document.addEventListener('DOMContentLoaded', function () {
      if (document.body && !document.querySelector('.radiant-trial-band')) {
        document.body.insertBefore(band, document.body.firstChild);
      }
    });
  }
})();
