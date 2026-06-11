/* bold.js — shared front-end behaviour for the Bold · Radiant Field site.
 *
 * Safe to load on every page: each feature is guarded by the presence of
 * its target element, so interior pages get scroll-reveals while the
 * homepage additionally gets the live particle hero, count-up stats and
 * the product marquee.
 *
 *   - .reveal            -> fade/slide in on scroll (all pages)
 *   - #field (canvas)    -> live "radiant field" hero animation
 *   - .stat .num         -> count-up when scrolled into view
 *   - .svc               -> cursor spotlight follow
 *   - #mtrack / #prodgrid-> built from window.RADIANT_PRODUCTS if present
 */
(function () {
  "use strict";
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- reveal on scroll ---------- */
  function initReveal() {
    var els = document.querySelectorAll(".reveal");
    if (!els.length) return;
    if (reduce || !("IntersectionObserver" in window)) {
      els.forEach(function (el) { el.classList.add("in"); });
      return;
    }
    var obs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); obs.unobserve(e.target); }
      });
    }, { threshold: 0.15 });
    els.forEach(function (el) { obs.observe(el); });
  }

  /* ---------- count-up stats ---------- */
  function countUp(el) {
    if (el.dataset.text) return;
    var to = +el.dataset.to, suf = el.dataset.suffix || "";
    if (reduce) { el.textContent = to + suf; return; }
    var dur = 1100, t0 = performance.now();
    (function step(t) {
      var k = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round((1 - Math.pow(1 - k, 3)) * to) + suf;
      if (k < 1) requestAnimationFrame(step);
    })(performance.now());
  }
  function initStats() {
    var nums = document.querySelectorAll(".stat .num");
    if (!nums.length) return;
    if (!("IntersectionObserver" in window)) { nums.forEach(countUp); return; }
    var obs = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { countUp(e.target); obs.unobserve(e.target); } });
    }, { threshold: 0.6 });
    nums.forEach(function (n) { obs.observe(n); });
  }

  /* ---------- service card spotlight ---------- */
  function initSpotlight() {
    document.querySelectorAll(".svc").forEach(function (card) {
      card.addEventListener("pointermove", function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty("--mx", ((e.clientX - r.left) / r.width * 100) + "%");
        card.style.setProperty("--my", ((e.clientY - r.top) / r.height * 100) + "%");
      });
    });
  }

  /* ---------- product marquee + grid ---------- */
  function initProducts() {
    var products = window.RADIANT_PRODUCTS;
    if (!products) return;
    var grid = document.getElementById("prodgrid");
    if (grid) {
      grid.innerHTML = products.map(function (p) {
        return '<a class="prod" href="' + (p.href || "#") + '"><div class="tag">' + p.tag +
          '</div><h4><span class="q">Quik</span>' + p.name.replace(/^Quik/, "") +
          "</h4><p>" + p.blurb + "</p></a>";
      }).join("");
    }
    var mt = document.getElementById("mtrack");
    if (mt) {
      var names = products.map(function (p) {
        return '<span class="item"><span class="q">Quik</span>' + p.name.replace(/^Quik/, "") + "</span>";
      }).join("");
      mt.innerHTML = names + names; // doubled for a seamless loop
    }
  }

  /* ---------- live radiant-field canvas ---------- */
  function initField() {
    var cv = document.getElementById("field");
    if (!cv) return;
    var ctx = cv.getContext("2d");
    var W, H, DPR, cx, cy, particles = [], rings = [], raf, t = 0;
    var COLORS = ["#f0271d", "#f86058", "#d00008", "#ff8077"];

    function resize() {
      DPR = Math.min(2, window.devicePixelRatio || 1);
      W = cv.clientWidth; H = cv.clientHeight;
      cv.width = W * DPR; cv.height = H * DPR; ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      cx = W * 0.5; cy = H * 0.46;
    }
    function spawn() {
      var a = Math.random() * Math.PI * 2, sp = 0.4 + Math.random() * 1.3;
      return { x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: 0, max: 200 + Math.random() * 220, size: 1 + Math.random() * 2.2,
        c: COLORS[(Math.random() * COLORS.length) | 0] };
    }
    function init() {
      particles = []; rings = [];
      var n = Math.min(150, Math.max(60, Math.round(W * H / 12000)));
      for (var i = 0; i < n; i++) { var p = spawn(); p.life = Math.random() * p.max; particles.push(p); }
    }
    function frame() {
      t++;
      ctx.clearRect(0, 0, W, H);
      var pulse = 0.6 + 0.4 * Math.sin(t * 0.03);
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 160);
      g.addColorStop(0, "rgba(240,39,29," + (0.22 * pulse) + ")");
      g.addColorStop(1, "rgba(240,39,29,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, 160, 0, Math.PI * 2); ctx.fill();
      if (t % 70 === 0) rings.push({ r: 6, a: 0.5 });
      ctx.lineWidth = 1.2;
      for (var i = rings.length - 1; i >= 0; i--) {
        var rg = rings[i]; rg.r += 1.1; rg.a *= 0.992;
        if (rg.a < 0.02) { rings.splice(i, 1); continue; }
        ctx.strokeStyle = "rgba(248,96,88," + rg.a + ")";
        ctx.beginPath(); ctx.arc(cx, cy, rg.r, 0, Math.PI * 2); ctx.stroke();
      }
      for (var k = 0; k < particles.length; k++) {
        var p = particles[k];
        p.x += p.vx; p.y += p.vy; p.life++;
        var lf = p.life / p.max, alpha = Math.sin(lf * Math.PI) * 0.9;
        if (p.life >= p.max || p.x < -20 || p.x > W + 20 || p.y < -20 || p.y > H + 20) {
          Object.assign(p, spawn()); continue;
        }
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.c; ctx.globalAlpha = alpha; ctx.fill(); ctx.globalAlpha = 1;
      }
      for (var a1 = 0; a1 < particles.length; a1++) {
        for (var b1 = a1 + 1; b1 < particles.length; b1++) {
          var pa = particles[a1], pb = particles[b1];
          var dx = pa.x - pb.x, dy = pa.y - pb.y, d2 = dx * dx + dy * dy;
          if (d2 < 10000) {
            ctx.strokeStyle = "rgba(240,80,70," + ((1 - d2 / 10000) * 0.16) + ")";
            ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(frame);
    }
    function staticFrame() {
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < 90; i++) {
        var p = spawn(); p.x = cx + (Math.random() - 0.5) * W; p.y = cy + (Math.random() - 0.5) * H;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fillStyle = p.c; ctx.globalAlpha = 0.5; ctx.fill(); ctx.globalAlpha = 1;
      }
    }
    window.addEventListener("resize", function () {
      cancelAnimationFrame(raf); resize(); init(); if (!reduce) frame(); else staticFrame();
    });
    resize(); init();
    if (reduce) staticFrame(); else frame();
  }

  function boot() {
    initReveal(); initStats(); initSpotlight(); initProducts(); initField();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
