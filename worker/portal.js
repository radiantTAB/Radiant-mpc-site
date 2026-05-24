// portal.js — client portal API.
//
// Lets a Radiant client sign in and see the modules they are licensed
// for. Mounted at /portal/api/* — NOT behind Cloudflare Access (that gate
// is admin-only); the portal has its own email + password session auth.
//
//   POST /portal/api/login         { email, password }       -> sets a session cookie
//   GET  /portal/api/me                                      -> the client's apps
//   POST /portal/api/logout                                  -> clears the session
//   POST /portal/api/trial-request { email, name, practice } -> creates a 14-day trial
//                                                               client + signed license
//                                                               + session in one shot

import { PRODUCT_NAMES, PRODUCT_IDS } from "./products.js";
import { signLicense } from "./license-core.js";

// 14-day trial length. Drives both the issued license expiry and the
// success-page expiry message.
const TRIAL_DAYS = 14;

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
    // app.radiant-mpc.com (the launcher / portal pages). Path=/ is
    // required because the launcher root (app.radiant-mpc.com/) and the
    // embedded apps (/apps/...) are NOT under /portal -- with Path=/portal
    // the cookie would not be sent for those requests and the auth gate
    // would bounce signed-in customers back to login.
    const cookie =
      "portal_session=" +
      token +
      "; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/; Max-Age=" +
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

  // ---- POST /portal/api/trial-request ----
  // Public, unauthenticated. Creates a fresh trial client (with a 14-day
  // signed license for the full product set) and signs the visitor in via
  // the same portal_session cookie that /portal/api/login uses, so they
  // can land in the launcher immediately. A generated password is returned
  // in the JSON body once so the visitor can save it for future sign-ins.
  if (path === "/portal/api/trial-request" && method === "POST") {
    if (!env.LICENSE_SIGNING_KEY) {
      return json(
        { error: "Trial signup is temporarily unavailable. Please email info@Radiant-MPC.com." },
        500
      );
    }
    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const practice = String(body.practice || "").trim();
    // Honeypot field: humans won't fill `website`; bots usually do.
    if (String(body.website || "").trim()) {
      // Pretend success so the bot moves on without retrying.
      return json({ ok: true, email, expires: null, password: null });
    }
    if (!email || !email.includes("@") || email.length > 254) {
      return json({ error: "Please provide a valid email address." }, 400);
    }
    if (!name || name.length > 200) {
      return json({ error: "Please provide your name." }, 400);
    }
    if (!practice || practice.length > 200) {
      return json({ error: "Please provide the name of your practice or clinic." }, 400);
    }

    // Refuse if this email already has an account. This blocks the
    // common abuse of repeatedly requesting trials to extend access,
    // and avoids stomping a real customer's record. Existing users go
    // to /portal/login.html instead.
    const existing = await env.DB.prepare(
      "SELECT id FROM clients WHERE lower(contact_email) = ?"
    )
      .bind(email)
      .first();
    if (existing) {
      return json(
        {
          error:
            "An account already exists for this email. Sign in at /portal/login.html " +
            "or email info@Radiant-MPC.com if you need help recovering access.",
        },
        409
      );
    }

    // Generate a random 16-char hex password. Easy to type, no ambiguous
    // characters. Customer can change it later via /portal/api/change-password.
    const password = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
    const passwordHash = await hashPassword(password);

    const clientId = "cli_" + bytesToHex(crypto.getRandomValues(new Uint8Array(6)));
    const locationId = "loc_" + bytesToHex(crypto.getRandomValues(new Uint8Array(6)));
    const nowIso = new Date().toISOString();

    // 1) Client row. We omit must_change_password from the INSERT because
    //    that column is added by a later ALTER (see admin-auth.js
    //    ensureAdminSchema and schema.sql notes) and may not exist on a
    //    very fresh DB. Letting the column default to 1 means a trial
    //    user who re-signs-in via /portal/login.html will be bounced to
    //    change-password.html, which is the appropriate behavior for an
    //    auto-generated password.
    await env.DB.prepare(
      "INSERT INTO clients " +
        "(id, name, contact_email, notes, password_hash, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)"
    )
      .bind(
        clientId,
        practice,
        email,
        "Self-service trial. Contact: " + name,
        passwordHash,
        nowIso
      )
      .run();

    // 2) Location row -- /portal/api/me joins licenses to the client through
    //    locations, so this is required for the trial-license to appear in
    //    the launcher.
    await env.DB.prepare(
      "INSERT INTO locations (id, client_id, name, modules, access_end, notes, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        locationId,
        clientId,
        "Trial sandbox",
        PRODUCT_IDS.join(","),
        null,
        "Auto-created by /portal/api/trial-request",
        nowIso
      )
      .run();

    // 3) Issue and store the signed 14-day license for the full product set.
    let lic;
    try {
      lic = await signLicense(env.LICENSE_SIGNING_KEY, practice, TRIAL_DAYS, PRODUCT_IDS);
    } catch (err) {
      // Roll back the client + location rows so the email can retry.
      await env.DB.prepare("DELETE FROM locations WHERE id = ?").bind(locationId).run();
      await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(clientId).run();
      return json(
        { error: "Could not issue trial license: " + String((err && err.message) || err) },
        500
      );
    }
    await env.DB.prepare(
      "INSERT INTO licenses " +
        "(id, customer, issued, expires, key, created_at, products, location_id) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        lic.id,
        lic.customer,
        lic.issued,
        lic.expires,
        lic.key,
        nowIso,
        lic.products.join(","),
        locationId
      )
      .run();

    // 4) Portal session so the customer is signed in immediately. Same
    //    cookie attributes as /portal/api/login.
    const sessionToken = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const sessionExpires = new Date(Date.now() + SESSION_DAYS * 86400000);
    await env.DB.prepare(
      "INSERT INTO portal_sessions (token, client_id, created_at, expires_at) " +
        "VALUES (?, ?, ?, ?)"
    )
      .bind(sessionToken, clientId, nowIso, sessionExpires.toISOString())
      .run();
    const cookie =
      "portal_session=" +
      sessionToken +
      "; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/; Max-Age=" +
      SESSION_DAYS * 86400;

    return json(
      {
        ok: true,
        email: email,
        password: password,
        expires: lic.expires,
        practice: practice,
      },
      200,
      { "Set-Cookie": cookie }
    );
  }

  // ---- POST /portal/api/logout ----
  if (path === "/portal/api/logout" && method === "POST") {
    const token = readCookie(request, "portal_session");
    if (token) {
      await env.DB.prepare("DELETE FROM portal_sessions WHERE token = ?")
        .bind(token)
        .run();
    }
    // Same Domain/Path so the browser clears the right cookie. We also
    // emit a Path=/portal clear so any stale cookie from the previous
    // narrower-path scheme is wiped from the browser too.
    const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
    headers.append(
      "Set-Cookie",
      "portal_session=; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/; Max-Age=0"
    );
    headers.append(
      "Set-Cookie",
      "portal_session=; HttpOnly; Secure; SameSite=Lax; Domain=.radiant-mpc.com; Path=/portal; Max-Age=0"
    );
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
  }

  // ---- GET /portal/api/me ----
  if (path === "/portal/api/me" && method === "GET") {
    const client = await sessionClient(request, env);
    if (!client) return json({ error: "Not signed in." }, 401);

    // Phase 2.5.5: include the per-clinic QuikBolus defaults blob (if any)
    // so the QuikBolus session loader can pick them up. Self-healing
    // ALTER -- safe to swallow on older DBs without the column.
    let quikbolusDefaults = null;
    try {
      const row = await env.DB.prepare(
        "SELECT default_quikbolus_settings FROM clients WHERE id = ?"
      )
        .bind(client.id)
        .first();
      if (row && row.default_quikbolus_settings) {
        try {
          quikbolusDefaults = JSON.parse(row.default_quikbolus_settings);
        } catch (_) {
          quikbolusDefaults = null;
        }
      }
    } catch (_) {
      // Column may not exist yet on old DBs; ignore.
    }

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
    return json({
      client: { name: client.name },
      apps: apps,
      quikbolus_defaults: quikbolusDefaults,
    });
  }

  return json({ error: "Not found." }, 404);
}
