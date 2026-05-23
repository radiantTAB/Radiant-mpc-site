// portal.js — client portal API.
//
// Lets a Radiant client sign in and see the modules they are licensed
// for. Mounted at /portal/api/* — NOT behind Cloudflare Access (that gate
// is admin-only); the portal has its own email + password session auth.
//
//   POST /portal/api/login    { email, password }  -> sets a session cookie
//   GET  /portal/api/me                            -> the client's apps
//   POST /portal/api/logout                        -> clears the session

import { PRODUCT_NAMES } from "./products.js";

const SESSION_DAYS = 30;

// Apps that are hosted web apps a client can launch in a browser.
// Anything not listed is a desktop app (download + key).
const HOSTED_APPS = {
  quikflow: "/apps/quikflow/",
  quikbolus: "https://quikbolus.radiant-mpc.com/",
};

function json(data, status = 200, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign(
      { "content-type": "application/json; charset=utf-8" },
      headers || {}
    ),
  });
}

function bytesToHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += bytes[i].toString(16).padStart(2, "0");
  }
  return s;
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

// PBKDF2-SHA256 password hash, stored as "saltHex:hashHex".
export async function hashPassword(password, saltHex) {
  const salt = saltHex
    ? hexToBytes(saltHex)
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return bytesToHex(salt) + ":" + bytesToHex(new Uint8Array(bits));
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const recomputed = await hashPassword(password, parts[0]);
  return recomputed === stored;
}

export function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

// Resolve the session cookie to { id, name } for the client, or null.
export async function sessionClient(request, env) {
  const token = readCookie(request, "portal_session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT s.client_id, s.expires_at, c.name FROM portal_sessions s " +
      "JOIN clients c ON c.id = s.client_id WHERE s.token = ?"
  )
    .bind(token)
    .first();
  if (!row) return null;
  if (row.expires_at < new Date().toISOString()) {
    await env.DB.prepare("DELETE FROM portal_sessions WHERE token = ?")
      .bind(token)
      .run();
    return null;
  }
  return { id: row.client_id, name: row.name };
}

export async function handlePortalApi(request, env, url) {
  if (!env.DB) return json({ error: "Database is not connected." }, 500);
  const path = url.pathname;
  const method = request.method;

  // ---- POST /portal/api/login ----
  if (path === "/portal/api/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!email || !password) {
      return json({ error: "Enter your email and password." }, 400);
    }
    // must_change_password may not exist yet on the clients table on
    // very old DBs -- the admin-auth migration adds it, but coalesce
    // here too for safety.
    const client = await env.DB.prepare(
      "SELECT id, password_hash, " +
        "COALESCE(must_change_password, 0) AS must_change_password " +
        "FROM clients " +
        "WHERE lower(contact_email) = ? AND password_hash IS NOT NULL"
    )
      .bind(email)
      .first();
    let ok = false;
    if (client) ok = await verifyPassword(password, client.password_hash);
    if (!ok) return json({ error: "Incorrect email or password." }, 401);

    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
    await env.DB.prepare(
      "INSERT INTO portal_sessions (token, client_id, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?)"
    )
      .bind(token, client.id, now.toISOString(), expires.toISOString())
      .run();
    // Domain=.radiant-mpc.com lets the same session work on both
    // radiant-mpc.com (where the Customer Login modal lives) and
    // app.radiant-mpc.com (the launcher / portal pages). The Quik app
    // subdomains (quikqa., quiklog., …) don't serve /portal/*, so
    // Path=/portal still scopes the cookie there.
    const cookie =
      "portal_session=" +
      token +
      "; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/portal; Max-Age=" +
      SESSION_DAYS * 86400;
    return json(
      { ok: true, must_change_password: !!client.must_change_password },
      200,
      { "Set-Cookie": cookie }
    );
  }

  // ---- POST /portal/api/change-password ----
  // Lets a signed-in customer rotate their own password. Required for
  // the first-login flow (must_change_password=1 forces this).
  if (path === "/portal/api/change-password" && method === "POST") {
    const session = await sessionClient(request, env);
    if (!session) return json({ error: "Not signed in." }, 401);
    const body = await request.json().catch(() => ({}));
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    if (next.length < 8) {
      return json(
        { error: "New password must be at least 8 characters." },
        400
      );
    }
    const row = await env.DB.prepare(
      "SELECT password_hash FROM clients WHERE id = ?"
    )
      .bind(session.id)
      .first();
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      return json({ error: "Current password is incorrect." }, 401);
    }
    if (next === current) {
      return json(
        { error: "New password must differ from the current password." },
        400
      );
    }
    const newHash = await hashPassword(next);
    await env.DB.prepare(
      "UPDATE clients SET password_hash = ?, must_change_password = 0 " +
        "WHERE id = ?"
    )
      .bind(newHash, session.id)
      .run();
    return json({ ok: true });
  }

  // ---- POST /portal/api/logout ----
  if (path === "/portal/api/logout" && method === "POST") {
    const token = readCookie(request, "portal_session");
    if (token) {
      await env.DB.prepare("DELETE FROM portal_sessions WHERE token = ?")
        .bind(token)
        .run();
    }
    // Same Domain/Path so the browser clears the right cookie.
    return json({ ok: true }, 200, {
      "Set-Cookie":
        "portal_session=; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/portal; Max-Age=0",
    });
  }

  // ---- GET /portal/api/me ----
  if (path === "/portal/api/me" && method === "GET") {
    const client = await sessionClient(request, env);
    if (!client) return json({ error: "Not signed in." }, 401);

    // The client's locations -> their licenses -> the modules/apps.
    const locs =
      (await env.DB.prepare("SELECT id FROM locations WHERE client_id = ?")
        .bind(client.id)
        .all()).results || [];
    const locIds = locs.map((l) => l.id);

    let licenses = [];
    if (locIds.length) {
      const placeholders = locIds.map(() => "?").join(",");
      licenses =
        (await env.DB.prepare(
          "SELECT products, expires, key, revoked FROM licenses " +
            "WHERE location_id IN (" +
            placeholders +
            ") ORDER BY created_at DESC"
        )
          .bind(...locIds)
          .all()).results || [];
    }

    const today = todayISO();
    const byApp = {};
    for (const lic of licenses) {
      const status = lic.revoked
        ? "Revoked"
        : lic.expires < today
        ? "Expired"
        : "Active";
      for (const pid of (lic.products || "").split(",").filter(Boolean)) {
        const existing = byApp[pid];
        // Keep the entry with the latest expiry for each app.
        if (!existing || lic.expires > existing.expires) {
          byApp[pid] = {
            id: pid,
            name: PRODUCT_NAMES[pid] || pid,
            expires: lic.expires,
            status: status,
            key: lic.key,
            hosted: !!HOSTED_APPS[pid],
            launch_url: HOSTED_APPS[pid] || null,
          };
        }
      }
    }
    const apps = Object.values(byApp).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    return json({ client: { name: client.name }, apps: apps });
  }

  return json({ error: "Not found." }, 404);
}
