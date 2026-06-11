// admin-auth.js — username/password admin login that replaces the
// Cloudflare Access gate that used to protect /admin/*.
//
//   POST /admin/api/login            { username, password }
//                                    -> { ok, must_change_password }
//                                       + Set-Cookie admin_session
//   POST /admin/api/logout           clears the session
//   GET  /admin/api/me               -> { admin: { username, must_change } } | 401
//   POST /admin/api/change-password  { current_password, new_password }
//
// Session cookie: admin_session, HttpOnly + Secure + SameSite=Lax,
// Path=/admin so it never leaks to /portal/, /apps/, or the marketing
// hostname.
//
// Default seed (lazy, on first /admin/api/* call when admin_users is
// empty): RMPCAdmin / "Password 1" with must_change_password = 1.

import { hashPassword } from "./portal.js";

const SESSION_DAYS = 14; // hard cap (absolute lifetime) of an admin session row
const IDLE_MINUTES = 30; // idle timeout -- re-login required after inactivity
const IDLE_MS = IDLE_MINUTES * 60 * 1000;
const DEFAULT_USERNAME = "RMPCAdmin";
const DEFAULT_PASSWORD = "Password 1";
const MIN_PASSWORD_LEN = 8;

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

function readCookieFromRequest(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const recomputed = await hashPassword(password, parts[0]);
  return recomputed === stored;
}

// --- Lazy schema bootstrap -------------------------------------------------
//
// Runs on every admin API call -- all statements are CREATE IF NOT EXISTS
// or guarded, so the cost is a couple of cheap no-ops once the tables
// exist. Seeds the default admin if the table is empty.

let _schemaReady = false;

export async function ensureAdminSchema(env) {
  if (_schemaReady || !env.DB) return;

  await env.DB.batch([
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admin_users (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "username TEXT NOT NULL UNIQUE," +
        "password_hash TEXT NOT NULL," +
        "must_change_password INTEGER NOT NULL DEFAULT 1," +
        "created_at TEXT NOT NULL," +
        "last_login_at TEXT)"
    ),
    env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS admin_sessions (" +
        "token TEXT PRIMARY KEY," +
        "admin_id INTEGER NOT NULL," +
        "created_at TEXT NOT NULL," +
        "expires_at TEXT NOT NULL)"
    ),
  ]);

  // Add must_change_password to clients if missing. ALTER fails when the
  // column is already there, so swallow that one error.
  try {
    await env.DB.prepare(
      "ALTER TABLE clients ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 1"
    ).run();
  } catch (_) {
    // column already exists -- fine.
  }

  // last_seen on admin_sessions drives the idle timeout. Guarded ALTER.
  try {
    await env.DB.prepare(
      "ALTER TABLE admin_sessions ADD COLUMN last_seen TEXT"
    ).run();
  } catch (_) {
    // column already exists -- fine.
  }

  // Lazy seed of the default admin user if nothing is there yet.
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM admin_users"
  ).first();
  if (!row || row.n === 0) {
    const hash = await hashPassword(DEFAULT_PASSWORD);
    await env.DB.prepare(
      "INSERT INTO admin_users (username, password_hash, must_change_password, created_at) " +
        "VALUES (?, ?, 1, ?)"
    )
      .bind(DEFAULT_USERNAME, hash, new Date().toISOString())
      .run();
  }

  _schemaReady = true;
}

// --- Session helpers -------------------------------------------------------

// Resolve the admin_session cookie to { id, username, must_change_password },
// or null if no session / expired / unknown.
export async function adminSession(request, env) {
  if (!env.DB) return null;
  const token = readCookieFromRequest(request, "admin_session");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT s.admin_id, s.expires_at, s.last_seen, u.username, u.must_change_password " +
      "FROM admin_sessions s JOIN admin_users u ON u.id = s.admin_id " +
      "WHERE s.token = ?"
  )
    .bind(token)
    .first();
  if (!row) return null;
  const now = Date.now();
  if (row.expires_at < new Date(now).toISOString()) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?")
      .bind(token)
      .run();
    return null;
  }
  // Idle timeout.
  const last = row.last_seen ? Date.parse(row.last_seen) : null;
  if (last && now - last > IDLE_MS) {
    await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?")
      .bind(token)
      .run();
    return null;
  }
  // Throttled activity touch.
  if (!last || now - last > 60000) {
    await env.DB.prepare("UPDATE admin_sessions SET last_seen = ? WHERE token = ?")
      .bind(new Date(now).toISOString(), token)
      .run();
  }
  return {
    id: row.admin_id,
    username: row.username,
    must_change_password: !!row.must_change_password,
  };
}

function sessionCookie(token) {
  // SESSION cookie (no Max-Age) so it is discarded when the browser closes,
  // forcing a fresh admin login on relaunch. Path=/ so the cookie also
  // accompanies launcher / product requests (admin passes the customer
  // gate for demo/training). Domain is intentionally omitted -- admin login
  // lives only on app.radiant-mpc.com.
  return (
    "admin_session=" + token + "; HttpOnly; Secure; SameSite=Lax; Path=/"
  );
}

// --- Request router --------------------------------------------------------

export async function handleAdminAuth(request, env, url) {
  await ensureAdminSchema(env);
  const path = url.pathname;
  const method = request.method;

  // ---- POST /admin/api/login --------------------------------------
  if (path === "/admin/api/login" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim();
    const password = String(body.password || "");
    if (!username || !password) {
      return json({ error: "Enter your admin username and password." }, 400);
    }
    const u = await env.DB.prepare(
      "SELECT id, password_hash, must_change_password FROM admin_users " +
        "WHERE username = ?"
    )
      .bind(username)
      .first();
    let ok = false;
    if (u) ok = await verifyPassword(password, u.password_hash);
    if (!ok) {
      return json({ error: "Incorrect admin username or password." }, 401);
    }

    const token = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const now = new Date();
    const expires = new Date(now.getTime() + SESSION_DAYS * 86400000);
    await env.DB.prepare(
      "INSERT INTO admin_sessions (token, admin_id, created_at, expires_at, last_seen) " +
        "VALUES (?, ?, ?, ?, ?)"
    )
      .bind(token, u.id, now.toISOString(), expires.toISOString(), now.toISOString())
      .run();
    await env.DB.prepare(
      "UPDATE admin_users SET last_login_at = ? WHERE id = ?"
    )
      .bind(now.toISOString(), u.id)
      .run();

    return json(
      { ok: true, must_change_password: !!u.must_change_password },
      200,
      { "Set-Cookie": sessionCookie(token) }
    );
  }

  // ---- POST /admin/api/logout -------------------------------------
  if (path === "/admin/api/logout" && method === "POST") {
    const token = readCookieFromRequest(request, "admin_session");
    if (token) {
      await env.DB.prepare("DELETE FROM admin_sessions WHERE token = ?")
        .bind(token)
        .run();
    }
    // Emit both a Path=/ and a Path=/admin clear so any stale cookie
    // from the previous narrower-path scheme is also wiped from the browser.
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append(
      "Set-Cookie",
      "admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0"
    );
    headers.append(
      "Set-Cookie",
      "admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/admin; Max-Age=0"
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // ---- GET /admin/api/me ------------------------------------------
  if (path === "/admin/api/me" && method === "GET") {
    const a = await adminSession(request, env);
    if (!a) return json({ error: "Not signed in." }, 401);
    return json({
      admin: {
        username: a.username,
        must_change_password: a.must_change_password,
      },
    });
  }

  // ---- POST /admin/api/change-password ----------------------------
  if (path === "/admin/api/change-password" && method === "POST") {
    const a = await adminSession(request, env);
    if (!a) return json({ error: "Not signed in." }, 401);
    const body = await request.json().catch(() => ({}));
    const current = String(body.current_password || "");
    const next = String(body.new_password || "");
    if (next.length < MIN_PASSWORD_LEN) {
      return json(
        {
          error:
            "New password must be at least " + MIN_PASSWORD_LEN + " characters.",
        },
        400
      );
    }
    // Confirm the current password to defend against an attacker who
    // hijacks the admin_session cookie but doesn't know the password.
    const u = await env.DB.prepare(
      "SELECT password_hash FROM admin_users WHERE id = ?"
    )
      .bind(a.id)
      .first();
    if (!u || !(await verifyPassword(current, u.password_hash))) {
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
      "UPDATE admin_users SET password_hash = ?, must_change_password = 0 " +
        "WHERE id = ?"
    )
      .bind(newHash, a.id)
      .run();
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}

// Convenience guard used by handleApi / handleClientsApi / DELETE endpoints
// before they touch any data. Returns null when ok, or a Response to
// send back when the caller is not authenticated.
export async function requireAdmin(request, env) {
  await ensureAdminSchema(env);
  const a = await adminSession(request, env);
  if (!a) return json({ error: "Not signed in." }, 401);
  if (a.must_change_password) {
    return json(
      { error: "You must change your password before using admin tools.", must_change_password: true },
      403
    );
  }
  return null;
}
