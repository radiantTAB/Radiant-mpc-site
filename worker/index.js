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
import { handlePortalApi } from "./portal.js";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Public revocation list — not behind Access.
    if (url.pathname === "/api/revoked") {
      try {
        return await handleRevokedList(env);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Client portal API — public-facing, with its own session auth.
    if (url.pathname.startsWith("/portal/api/")) {
      try {
        return await handlePortalApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Client Setup API — behind Access (/admin/* is gated).
    if (
      url.pathname.startsWith("/admin/api/clients") ||
      url.pathname.startsWith("/admin/api/locations")
    ) {
      try {
        return await handleClientsApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // License Manager API — behind Access.
    if (url.pathname.startsWith("/admin/api/")) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return json({ error: String((err && err.message) || err) }, 500);
      }
    }

    // Everything else: static assets, with hostname-based routing.
    return serveAssets(request, env, url);
  },
};

// Paths that always serve from their original root location, regardless
// of hostname. Customer login + styles + logo need to load on marketing
// AND on the app hostname; demo videos under /assets/ are shared too.
function isSharedAsset(path) {
  return (
    path === "/customer-login.js" ||
    path === "/styles.css" ||
    path === "/radiant-logo.png" ||
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
    path.startsWith("/app/") ||
    path.startsWith("/portal/") ||
    path.startsWith("/admin/") ||
    path.startsWith("/apps/")
  );
}

async function serveAssets(request, env, url) {
  const host = url.hostname;
  const path = url.pathname;
  const isAppHost = host === "app.radiant-mpc.com";

  if (isAppHost) {
    // Rewrite user-area paths into the /app/ shadow tree. Shared
    // assets pass through unchanged.
    if (isSharedAsset(path)) {
      return env.ASSETS.fetch(request);
    }
    let newPath;
    if (path === "/" || path === "") {
      newPath = "/app/index.html";
    } else if (path.startsWith("/app/")) {
      newPath = path; // already under /app/
    } else {
      newPath = "/app" + path;
    }
    const rewritten = new URL(newPath + url.search, url);
    return env.ASSETS.fetch(new Request(rewritten, request));
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

    if (!customer) return json({ error: "Customer name is required." }, 400);
    if (!Number.isInteger(days) || days < 1) {
      return json({ error: "Trial length must be a whole number of days (1 or more)." }, 400);
    }
    if (products.length === 0) {
      return json({ error: "Select at least one product for this license." }, 400);
    }

    const result = await signLicense(env.LICENSE_SIGNING_KEY, customer, days, products);

    await env.DB.prepare(
      "INSERT INTO licenses (id, customer, issued, expires, key, created_at, products) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        result.id,
        result.customer,
        result.issued,
        result.expires,
        result.key,
        new Date().toISOString(),
        result.products.join(",")
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

  return json({ error: "Not found." }, 404);
}
