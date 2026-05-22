// index.js — Worker entry point for radiant-mpc.com.
//
// Routing:
//   /api/revoked              -> PUBLIC revocation list (apps may check this)
//   /admin/api/clients*       -> Client Setup API (behind Cloudflare Access)
//   /admin/api/locations*     -> Client Setup API (behind Cloudflare Access)
//   /admin/api/*              -> License Manager API (behind Cloudflare Access)
//   everything else           -> static assets (marketing site + admin pages)
//
// Cloudflare Access gates all of /admin/* (pages and API). The public
// /api/revoked endpoint is deliberately outside /admin/ so apps can reach it.

import { signLicense } from "./license-core.js";
import { RADIANT_PRODUCTS, PRODUCT_IDS, PRODUCT_NAMES } from "./products.js";
import { handleClientsApi } from "./clients.js";

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

    // Everything else: static assets.
    return env.ASSETS.fetch(request);
  },
};

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
