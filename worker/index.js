// index.js — Worker entry point for radiant-mpc.com + app.radiant-mpc.com.
//
// Hostname split:
//   radiant-mpc.com / www.radiant-mpc.com  -> marketing site only.
//     Any user-area path (/app/, /portal/, /admin/, /apps/, /run.html)
//     301-redirects to app.radiant-mpc.com.
//   app.radiant-mpc.com  -> launcher + portal + admin + embedded apps.
//     Paths are transparently rewritten into the /app/ shadow tree:
//       /            -> /app/index.html (the launcher)
//       /portal/*    -> /app/portal/*
//       /admin/*     -> /app/admin/*
//       /apps/*      -> /app/apps/*
//     Shared static assets (customer-login.js, styles.css, radiant-logo.png,
//     /assets/*, favicons) serve from their root path on either hostname.
//
// API routing (path-based, hostname-agnostic so customer-login.js on
// marketing pages can still hit /portal/api/me, etc.):
//   /api/revoked              -> PUBLIC revocation list
//   /portal/api/*             -> Client portal API (own session auth)
//   /admin/api/clients*       -> Client Setup API (behind Cloudflare Access)
//   /admin/api/locations*     -> Client Setup API (behind Cloudflare Access)
//   /admin/api/*              -> License Manager API (behind Cloudflare Access)
//
// IMPORTANT: the Cloudflare Access policy that gates /admin/* must be
// configured for BOTH hostnames (or the wildcard *.radiant-mpc.com). The
// admin pages now live at app.radiant-mpc.com/admin/* — that hostname
// must be covered or the License Manager UI will be public.

import { signLicense } from "./license-core.js";
import { RADIANT_PRODUCTS, PRODUCT_IDS, PRODUCT_NAMES } from "./products.js";
import { handleClientsApi } from "./clients.js";
import { handlePortalApi, sessionClient, readCookie } from "./portal.js";
import {
  handleAdminAuth,
  adminSession,
  ensureAdminSchema,
  requireAdmin,
} from "./admin-auth.js";

// Admin API endpoints that the admin-auth module handles directly
// (login, logout, me, change-password). These are PUBLIC for login and
// then self-gated for the others -- they don't go through requireAdmin.
const ADMIN_AUTH_PATHS = new Set([
  "/admin/api/login",
  "/admin/api/logout",
  "/admin/api/me",
  "/admin/api/change-password",
]);

// Defensive HTTP headers applied to every response that leaves the
// Worker. HSTS forces HTTPS on this and all subdomains for a year
// (Cloudflare handles cert + redirect; the header just tells the
// browser to refuse plain HTTP forever after first contact). The rest
// are low-cost hardening signals that legitimate-site reputation
// scanners (Norton SafeWeb, Google Safe Browsing) positively weight.
const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "interest-cohort=()",
};

function withSecurityHeaders(resp) {
  if (!resp || typeof resp !== "object") return resp;
  // Don't try to mutate immutable responses (e.g. opaque redirects);
  // copy into a new Response so we can set headers.
  const h = new Headers(resp.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!h.has(k)) h.set(k, v);
  }
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: h,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const resp = await handle(request, env, url);
    return withSecurityHeaders(resp);
  },
};

async function handle(request, env, url) {
    // Public revocation list -- not gated.
    if (url.pathname === "/api/revoked") {
      try {
        return await handleRevokedList(env);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Client portal API -- has its own email + password session auth.
    if (url.pathname.startsWith("/portal/api/")) {
      try {
        return await handlePortalApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Admin auth endpoints (login / logout / me / change-password).
    // Routed BEFORE requireAdmin so the login endpoint is reachable.
    if (ADMIN_AUTH_PATHS.has(url.pathname)) {
      try {
        return await handleAdminAuth(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Everything else under /admin/api/* requires a signed-in admin.
    if (url.pathname.startsWith("/admin/api/")) {
      const denied = await requireAdmin(request, env);
      if (denied) return denied;
      try {
        if (
          url.pathname.startsWith("/admin/api/clients") ||
          url.pathname.startsWith("/admin/api/locations")
        ) {
          return await handleClientsApi(request, env, url);
        }
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Everything else: static assets, with hostname-based routing.
    return serveAssets(request, env, url);
}

// Paths that always serve from their original root location, regardless
// of hostname. Customer login + styles + logo need to load on marketing
// AND on the app hostname; demo videos under /assets/ are shared too.
function isSharedAsset(path) {
  return (
    path === "/customer-login.js" ||
    path === "/session-guard.js" ||
    path === "/trial-banner.js" ||
    path === "/styles.css" ||
    path === "/bold.css" ||
    path === "/bold.js" ||
    path === "/radiant-logo.png" ||
    path === "/radiant-logo-black.png" ||
    path === "/favicon.ico" ||
    path === "/favicon.png" ||
    path === "/CNAME" ||
    path.startsWith("/assets/")
  );
}

// Paths owned by the app surface — on the marketing hostname they
// 301-redirect to app.radiant-mpc.com (so old bookmarks/inbound links
// still land somewhere sensible).
function isAppPath(path) {
  return (
    path === "/run.html" ||
    path === "/downloads.html" ||      // moved under app/ -- gated like the rest
    path === "/users-guides.html" ||   // app-only listing of the per-product guides
    path.startsWith("/app/") ||
    path.startsWith("/portal/") ||
    path.startsWith("/admin/") ||
    path.startsWith("/apps/") ||
    path.startsWith("/users-guides/")  // the PDFs themselves
  );
}

// Paths on the app hostname that DO NOT require the customer-portal
// gate. /admin/* has its OWN gate (admin login -- see gateAdmin below),
// so it is exempt from the portal check.
//   /portal/login.html         -- the login page itself
//   /portal/api/login          -- POST endpoint that creates the session
//   /portal/api/me             -- session probe used by customer-login.js
//                                 (returns 401 JSON when no session; the
//                                 caller-side JS handles that, so we must
//                                 NOT redirect it to login.html)
//   /admin/*                   -- separately gated by admin login
//   shared static assets       -- styles/logo/customer-login.js/assets/
function isAuthExempt(path) {
  return (
    path === "/portal/login.html" ||
    path === "/portal/login" ||
    path === "/portal/request-trial.html" ||
    path === "/portal/request-trial" ||
    path === "/portal/api/login" ||
    path === "/portal/api/me" ||
    path === "/portal/api/trial-request" ||
    path.startsWith("/admin/") ||
    isSharedAsset(path)
  );
}

// Admin-page paths that DO NOT themselves require an admin session
// (because they ARE the login surface). Both the .html form AND the
// extensionless form must be listed: Cloudflare's html_handling 307-redirects
// /admin/login.html -> /admin/login, and without exempting the extensionless
// form too the gate bounces it back to /admin/login.html -> redirect loop.
// (The portal equivalent /portal/login is already exempt in isAuthExempt.)
function isAdminAuthExempt(path) {
  return (
    path === "/admin/login.html" ||
    path === "/admin/login" ||
    path === "/admin/change-password.html" ||
    path === "/admin/change-password"
  );
}

// Does this request carry an acceptable identity for the app surface?
// Portal session (validated against D1) OR a Cloudflare Access cookie
// (presence of CF_Authorization, which Cloudflare sets only after
// successful Access challenge -- attackers cannot forge it onto
// app.radiant-mpc.com from another origin).
async function checkAppAuth(request, env) {
  // Portal session: real DB lookup so a forged cookie value fails.
  if (env.DB) {
    try {
      const client = await sessionClient(request, env);
      if (client) return true;
    } catch (_) {
      // DB hiccup -- fall through to other checks below.
    }
    // Admin session: admins should pass the customer-portal gate too,
    // for demo / training / "Products Testing" access. Cookie is now
    // Path=/ (see admin-auth.js sessionCookie).
    try {
      const admin = await adminSession(request, env);
      if (admin) return true;
    } catch (_) {
      // ignore -- fall through
    }
  }

  // Cloudflare Access bypass for the operator. Access sets
  // CF_Authorization on the protected hostname after a successful
  // challenge; checking that it exists and looks like a JWT is enough
  // identity for the launcher (Access already vouched for the human,
  // and the per-app subdomains gate by license key downstream).
  const cf = readCookie(request, "CF_Authorization");
  if (cf && cf.split(".").length === 3) return true;

  return false;
}

async function serveAssets(request, env, url) {
  const host = url.hostname;
  const path = url.pathname;
  const isAppHost = host === "app.radiant-mpc.com";

  if (isAppHost) {
    // Admin pages: own gate, independent of the customer-portal gate.
    if (path.startsWith("/admin/") && !isAdminAuthExempt(path)) {
      await ensureAdminSchema(env);
      const a = await adminSession(request, env);
      if (!a) {
        const next = encodeURIComponent(path + url.search);
        return Response.redirect(
          "https://app.radiant-mpc.com/admin/login.html?next=" + next,
          302
        );
      }
      // Signed in but on the default seed credentials -- bounce to the
      // change-password screen until that is fixed, so the admin UI is
      // never reachable while the well-known default is still active.
      if (a.must_change_password && path !== "/admin/change-password.html") {
        return Response.redirect(
          "https://app.radiant-mpc.com/admin/change-password.html",
          302
        );
      }
    } else if (!isAuthExempt(path)) {
      // Customer-portal gate for the rest of the app surface.
      const ok = await checkAppAuth(request, env);
      if (!ok) {
        const next = encodeURIComponent(path + url.search);
        return Response.redirect(
          "https://app.radiant-mpc.com/portal/login.html?next=" + next,
          302
        );
      }
    }

    // Rewrite user-area paths into the /app/ shadow tree. Shared
    // assets pass through unchanged.
    if (isSharedAsset(path)) {
      return env.ASSETS.fetch(request);
    }
    let newPath;
    if (path === "/" || path === "") {
      // Rewrite to /app/ (trailing slash, NOT /app/index.html) so
      // Cloudflare's html_handling serves /app/index.html directly
      // without first 307'ing index.html -> directory. Without this,
      // the 307 leaks back to the browser as Location=/app/ -> our
      // Location-stripper turns that into /, and we self-loop.
      newPath = "/app/";
    } else if (path.startsWith("/app/")) {
      newPath = path; // already under /app/
    } else {
      newPath = "/app" + path;
    }
    const rewritten = new URL(newPath + url.search, url);
    const resp = await env.ASSETS.fetch(new Request(rewritten, request));
    // Cloudflare's auto-trailing-slash html_handling redirects /foo.html
    // to /foo. Because we rewrote the request into the /app/ shadow tree
    // before fetching, the Location header on that 3xx contains the /app/
    // prefix -- which would leak into the browser URL bar and immediately
    // bounce off the customer-portal gate. Strip the prefix so the user
    // stays on clean public paths.
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get("Location");
      if (loc && loc.startsWith("/app/")) {
        const stripped = loc.substring(4) || "/";
        const h = new Headers(resp.headers);
        h.set("Location", stripped);
        return new Response(resp.body, {
          status: resp.status,
          statusText: resp.statusText,
          headers: h,
        });
      }
    }
    return resp;
  }

  // Marketing hostname: redirect anything that belongs to the app
  // surface over to app.radiant-mpc.com.
  if (isAppPath(path)) {
    // /run.html -> app launcher root; everything else keeps its path.
    const target = path === "/run.html" ? "/" : path;
    return Response.redirect(
      "https://app.radiant-mpc.com" + target + url.search,
      301
    );
  }

  return env.ASSETS.fetch(request);
}

function json(data, status = 200, extraHeaders) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8" },
      extraHeaders || {}
    ),
  });
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function licenseStatus(row, today) {
  if (row.revoked) return "Revoked";
  if (row.expires < today) return "Expired";
  return "Active";
}

// PUBLIC: the list of revoked license-key IDs. A Radiant app can fetch this
// and refuse a key whose id is listed. NOTE: app-side checking is a separate
// update to each Radiant app — until an app is updated, revoking a key only
// records it here; the key keeps working in that app until its expiry date.
async function handleRevokedList(env) {
  const cors = { "access-control-allow-origin": "*" };
  if (!env.DB) return json({ revoked: [] }, 200, cors);
  const { results } = await env.DB.prepare(
    "SELECT id FROM licenses WHERE revoked = 1"
  ).all();
  return json({ revoked: (results || []).map((r) => r.id) }, 200, cors);
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  // GET /admin/api/products — the catalog, for the issue-form checklist.
  if (path === "/admin/api/products" && method === "GET") {
    return json({
      products: RADIANT_PRODUCTS.map(([id, name]) => ({ id, name })),
    });
  }

  // GET /admin/api/licenses — every issued key, newest first.
  if (path === "/admin/api/licenses" && method === "GET") {
    if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
    const { results } = await env.DB.prepare(
      "SELECT * FROM licenses ORDER BY created_at DESC"
    ).all();
    const today = todayISO();
    const licenses = (results || []).map((r) => {
      const ids = (r.products || "").split(",").filter(Boolean);
      return {
        id: r.id,
        customer: r.customer,
        issued: r.issued,
        expires: r.expires,
        key: r.key,
        revoked: !!r.revoked,
        status: licenseStatus(r, today),
        products: ids.map((p) => PRODUCT_NAMES[p] || p),
      };
    });
    return json({ licenses });
  }

  // POST /admin/api/licenses — issue and store a new signed key.
  if (path === "/admin/api/licenses" && method === "POST") {
    if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
    if (!env.LICENSE_SIGNING_KEY) {
      return json(
        { error: "Signing key is not configured (set the LICENSE_SIGNING_KEY secret)." },
        500
      );
    }

    const body = await request.json().catch(() => ({}));
    const customer = String(body.customer || "").trim();
    const days = parseInt(body.days, 10);
    const products = (Array.isArray(body.products) ? body.products : []).filter(
      (p) => PRODUCT_IDS.includes(p)
    );
    // Optional link back to a client created in Client Manager. Free-text
    // one-off keys leave this null.
    const clientId = String(body.client_id || "").trim() || null;

    if (!customer) return json({ error: "Customer name is required." }, 400);
    if (!Number.isInteger(days) || days < 1) {
      return json({ error: "Trial length must be a whole number of days (1 or more)." }, 400);
    }
    if (products.length === 0) {
      return json({ error: "Select at least one product for this license." }, 400);
    }

    const result = await signLicense(env.LICENSE_SIGNING_KEY, customer, days, products);

    // Self-healing migration: link column added the first time a client-
    // bound key is issued. Ignore the duplicate-column error thereafter.
    try {
      await env.DB.prepare("ALTER TABLE licenses ADD COLUMN client_id TEXT").run();
    } catch (_) {
      // Already exists -- ignore.
    }

    await env.DB.prepare(
      "INSERT INTO licenses (id, customer, issued, expires, key, created_at, products, client_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        result.id,
        result.customer,
        result.issued,
        result.expires,
        result.key,
        new Date().toISOString(),
        result.products.join(","),
        clientId
      )
      .run();

    return json({
      ok: true,
      license: {
        ...result,
        product_names: result.products.map((p) => PRODUCT_NAMES[p] || p),
      },
    });
  }

  // POST /admin/api/licenses/<id>/revoke  | .../unrevoke
  const m = path.match(/^\/admin\/api\/licenses\/([^/]+)\/(revoke|unrevoke)$/);
  if (m && method === "POST") {
    if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
    const id = m[1];
    const revoking = m[2] === "revoke";
    const res = await env.DB.prepare(
      "UPDATE licenses SET revoked = ?, revoked_at = ? WHERE id = ?"
    )
      .bind(revoking ? 1 : 0, revoking ? new Date().toISOString() : null, id)
      .run();
    const changes = res && res.meta ? res.meta.changes : undefined;
    if (changes === 0) return json({ error: "No license found with that id." }, 404);
    return json({ ok: true, id, revoked: revoking });
  }

  // DELETE /admin/api/licenses/<id> -- only allowed when the license is
  // already expired or revoked. Active keys must be revoked first.
  const md = path.match(/^\/admin\/api\/licenses\/([^/]+)$/);
  if (md && method === "DELETE") {
    if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
    const id = md[1];
    const row = await env.DB.prepare(
      "SELECT expires, revoked FROM licenses WHERE id = ?"
    )
      .bind(id)
      .first();
    if (!row) return json({ error: "No license found with that id." }, 404);
    const today = todayISO();
    const eligible = row.revoked || row.expires < today;
    if (!eligible) {
      return json(
        {
          error:
            "Only expired or revoked licenses can be deleted. " +
            "Revoke this key first if you want to remove it.",
        },
        400
      );
    }
    await env.DB.prepare("DELETE FROM licenses WHERE id = ?").bind(id).run();
    return json({ ok: true, id, deleted: true });
  }

  return json({ error: "Not found." }, 404);
}
