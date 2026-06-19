// clients.js — Client Setup API.
//
// Clients have locations; each location records the modules it may use and
// an access-end date. A license key can be issued for a location, which
// signs a key (modules + window) and links it back to the location.
//
// Mounted at /admin/api/clients* and /admin/api/locations* — behind the
// Cloudflare Access gate on /admin/*.

import { signLicense } from "./license-core.js";
import { PRODUCT_IDS, PRODUCT_NAMES } from "./products.js";
import { hashPassword } from "./portal.js";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function newId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function cleanModules(mods) {
  return (Array.isArray(mods) ? mods : []).filter((m) => PRODUCT_IDS.includes(m));
}

// Whole days from today (UTC) until an ISO date. null if missing/invalid.
function daysUntil(iso) {
  if (!iso) return null;
  const end = new Date(iso + "T00:00:00Z").getTime();
  if (isNaN(end)) return null;
  const today = new Date(todayISO() + "T00:00:00Z").getTime();
  return Math.round((end - today) / 86400000);
}

// Self-healing migration: add the QuikBolus per-clinic defaults column
// if it doesn't exist yet. Silently swallows the "duplicate column"
// error that fires after the first call.
async function ensureQuikbolusDefaultsColumn(env) {
  try {
    await env.DB.prepare(
      "ALTER TABLE clients ADD COLUMN default_quikbolus_settings TEXT"
    ).run();
  } catch (_) {
    // Already exists -- ignore.
  }
}

// Facility-profile columns on the clients table: mailing address, main
// phone + primary contact, and the clinic's R&V / TPS / linac vendors.
// All stored as TEXT (free-form, may be empty).
const CLIENT_PROFILE_COLUMNS = [
  "address_street",
  "address_city",
  "address_state",
  "address_zip",
  "phone",
  "contact_name",
  "contact_title",
  "rv_vendor",
  "tps_vendor",
  "linac_vendor",
  "linac_models",
  "num_linacs",
];

// Self-healing migration for the profile columns. Runs once per isolate
// (the flag short-circuits later calls); each ALTER is wrapped so the
// "duplicate column" error after the first deploy is ignored.
let _profileColumnsEnsured = false;
async function ensureClientProfileColumns(env) {
  if (_profileColumnsEnsured) return;
  for (const col of CLIENT_PROFILE_COLUMNS) {
    try {
      await env.DB.prepare(
        "ALTER TABLE clients ADD COLUMN " + col + " TEXT"
      ).run();
    } catch (_) {
      // Already exists -- ignore.
    }
  }
  _profileColumnsEnsured = true;
}

// Pull the profile fields out of a request body, trimmed to strings.
function readClientProfile(body) {
  const out = {};
  for (const col of CLIENT_PROFILE_COLUMNS) {
    out[col] = String(body[col] == null ? "" : body[col]).trim();
  }
  return out;
}

// Build the profile object returned to the client UI from a DB row.
function clientProfileOf(row) {
  const out = {};
  for (const col of CLIENT_PROFILE_COLUMNS) out[col] = row[col] || "";
  return out;
}

export async function handleClientsApi(request, env, url) {
  if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
  await ensureClientProfileColumns(env);
  const path = url.pathname;
  const method = request.method;

  // ---- GET / PUT /admin/api/clients/<id>/quikbolus-defaults ----
  // Phase 2.5.5: per-clinic default QuikBolus settings blob.
  let qm = path.match(/^\/admin\/api\/clients\/([^/]+)\/quikbolus-defaults$/);
  if (qm) {
    await ensureQuikbolusDefaultsColumn(env);
    const cid = qm[1];
    if (method === "GET") {
      const row = await env.DB.prepare(
        "SELECT default_quikbolus_settings FROM clients WHERE id = ?"
      )
        .bind(cid)
        .first();
      if (!row) return json({ error: "Client not found." }, 404);
      let parsed = null;
      try {
        parsed = row.default_quikbolus_settings
          ? JSON.parse(row.default_quikbolus_settings)
          : null;
      } catch (_) {
        parsed = null;
      }
      return json({ client_id: cid, defaults: parsed || {} });
    }
    if (method === "PUT") {
      const body = await request.json().catch(() => null);
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json({ error: "Body must be a JSON object." }, 400);
      }
      // Light validation -- keep top-level keys to a known allowlist.
      const allowed = [
        "default_printer_id",
        "default_cast_material",
        "default_export_format",
        "default_id_text_template",
        "mold",
        "direct_print",
      ];
      const clean = {};
      for (const k of allowed) {
        if (body[k] !== undefined) clean[k] = body[k];
      }
      const res = await env.DB.prepare(
        "UPDATE clients SET default_quikbolus_settings = ? WHERE id = ?"
      )
        .bind(JSON.stringify(clean), cid)
        .run();
      if (res && res.meta && res.meta.changes === 0)
        return json({ error: "Client not found." }, 404);
      return json({ ok: true, saved: clean });
    }
    return json({ error: "Method not allowed." }, 405);
  }

  // ---- GET /admin/api/clients : clients + nested locations + key status ----
  if (path === "/admin/api/clients" && method === "GET") {
    const clients =
      (await env.DB.prepare("SELECT * FROM clients ORDER BY name").all()).results || [];
    const locations =
      (await env.DB.prepare("SELECT * FROM locations ORDER BY name").all()).results || [];
    const licenses =
      (await env.DB.prepare(
        "SELECT id, issued, expires, key, revoked, location_id, created_at " +
          "FROM licenses WHERE location_id IS NOT NULL ORDER BY created_at DESC"
      ).all()).results || [];

    const today = todayISO();
    const latestByLoc = {};
    for (const lic of licenses) {
      if (!latestByLoc[lic.location_id]) latestByLoc[lic.location_id] = lic;
    }

    const locsByClient = {};
    for (const loc of locations) {
      const modIds = (loc.modules || "").split(",").filter(Boolean);
      const lic = latestByLoc[loc.id];
      let key = null;
      if (lic) {
        const status = lic.revoked
          ? "Revoked"
          : lic.expires < today
          ? "Expired"
          : "Active";
        key = {
          id: lic.id,
          key: lic.key,
          issued: lic.issued,
          expires: lic.expires,
          status: status,
        };
      }
      (locsByClient[loc.client_id] = locsByClient[loc.client_id] || []).push({
        id: loc.id,
        name: loc.name,
        modules: modIds,
        module_names: modIds.map((m) => PRODUCT_NAMES[m] || m),
        access_end: loc.access_end || "",
        notes: loc.notes || "",
        key: key,
      });
    }

    return json({
      clients: clients.map((c) => ({
        id: c.id,
        name: c.name,
        contact_email: c.contact_email || "",
        notes: c.notes || "",
        has_login: !!c.password_hash,
        profile: clientProfileOf(c),
        locations: locsByClient[c.id] || [],
      })),
    });
  }

  // ---- POST /admin/api/clients : create a client ----
  if (path === "/admin/api/clients" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Client name is required." }, 400);
    const id = newId();
    const prof = readClientProfile(body);
    const cols = ["id", "name", "contact_email", "notes", "created_at"].concat(
      CLIENT_PROFILE_COLUMNS
    );
    const vals = [
      id,
      name,
      String(body.contact_email || "").trim(),
      String(body.notes || "").trim(),
      new Date().toISOString(),
    ].concat(CLIENT_PROFILE_COLUMNS.map((c) => prof[c]));
    await env.DB.prepare(
      "INSERT INTO clients (" +
        cols.join(", ") +
        ") VALUES (" +
        cols.map(() => "?").join(", ") +
        ")"
    )
      .bind(...vals)
      .run();
    return json({ ok: true, id });
  }

  // ---- PUT /admin/api/clients/<id> : edit a client's details + profile ----
  let m = path.match(/^\/admin\/api\/clients\/([^/]+)$/);
  if (m && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Client name is required." }, 400);
    const prof = readClientProfile(body);
    const setCols = ["name = ?", "contact_email = ?", "notes = ?"].concat(
      CLIENT_PROFILE_COLUMNS.map((c) => c + " = ?")
    );
    const vals = [
      name,
      String(body.contact_email || "").trim(),
      String(body.notes || "").trim(),
    ]
      .concat(CLIENT_PROFILE_COLUMNS.map((c) => prof[c]))
      .concat([m[1]]);
    const res = await env.DB.prepare(
      "UPDATE clients SET " + setCols.join(", ") + " WHERE id = ?"
    )
      .bind(...vals)
      .run();
    if (res && res.meta && res.meta.changes === 0)
      return json({ error: "Client not found." }, 404);
    return json({ ok: true });
  }

  // ---- DELETE /admin/api/clients/<id> : delete client + its locations ----
  if (m && method === "DELETE") {
    await env.DB.prepare("DELETE FROM locations WHERE client_id = ?").bind(m[1]).run();
    await env.DB.prepare("DELETE FROM clients WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- POST /admin/api/clients/<id>/password : set or clear portal login ----
  // Whenever an admin sets (or resets) a customer password, force the
  // customer to change it themselves on next sign-in. Clearing the
  // password also clears the flag so it doesn't linger on a disabled
  // account.
  m = path.match(/^\/admin\/api\/clients\/([^/]+)\/password$/);
  if (m && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const password = String(body.password || "");
    let hash = null;
    if (password) {
      if (password.length < 6) {
        return json({ error: "Password must be at least 6 characters." }, 400);
      }
      hash = await hashPassword(password);
    }
    const res = await env.DB.prepare(
      "UPDATE clients SET password_hash = ?, must_change_password = ? " +
        "WHERE id = ?"
    )
      .bind(hash, hash ? 1 : 0, m[1])
      .run();
    if (res && res.meta && res.meta.changes === 0)
      return json({ error: "Client not found." }, 404);
    return json({ ok: true, has_login: !!hash });
  }

  // ---- POST /admin/api/clients/<id>/locations : add a location ----
  m = path.match(/^\/admin\/api\/clients\/([^/]+)\/locations$/);
  if (m && method === "POST") {
    const client = await env.DB.prepare("SELECT id FROM clients WHERE id = ?")
      .bind(m[1])
      .first();
    if (!client) return json({ error: "Client not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Location name is required." }, 400);
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO locations (id, client_id, name, modules, access_end, notes, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        m[1],
        name,
        cleanModules(body.modules).join(","),
        String(body.access_end || "").trim() || null,
        String(body.notes || "").trim(),
        new Date().toISOString()
      )
      .run();
    return json({ ok: true, id });
  }

  // ---- PUT / DELETE /admin/api/locations/<id> ----
  m = path.match(/^\/admin\/api\/locations\/([^/]+)$/);
  if (m && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Location name is required." }, 400);
    const res = await env.DB.prepare(
      "UPDATE locations SET name = ?, modules = ?, access_end = ?, notes = ? WHERE id = ?"
    )
      .bind(
        name,
        cleanModules(body.modules).join(","),
        String(body.access_end || "").trim() || null,
        String(body.notes || "").trim(),
        m[1]
      )
      .run();
    if (res && res.meta && res.meta.changes === 0)
      return json({ error: "Location not found." }, 404);
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    await env.DB.prepare("DELETE FROM locations WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- POST /admin/api/locations/<id>/issue-key ----
  m = path.match(/^\/admin\/api\/locations\/([^/]+)\/issue-key$/);
  if (m && method === "POST") {
    if (!env.LICENSE_SIGNING_KEY)
      return json({ error: "Signing key is not configured." }, 500);
    const loc = await env.DB.prepare("SELECT * FROM locations WHERE id = ?")
      .bind(m[1])
      .first();
    if (!loc) return json({ error: "Location not found." }, 404);
    const client = await env.DB.prepare("SELECT name FROM clients WHERE id = ?")
      .bind(loc.client_id)
      .first();

    const modules = (loc.modules || "").split(",").filter(Boolean);
    if (modules.length === 0)
      return json(
        { error: "This location has no modules — edit it and add at least one." },
        400
      );
    const days = daysUntil(loc.access_end);
    if (days === null)
      return json({ error: "Set an access-end date on this location first." }, 400);
    if (days < 1)
      return json({ error: "The access-end date must be in the future." }, 400);

    const customer = (client ? client.name : "Unknown") + " — " + loc.name;
    const result = await signLicense(env.LICENSE_SIGNING_KEY, customer, days, modules);

    await env.DB.prepare(
      "INSERT INTO licenses " +
        "(id, customer, issued, expires, key, created_at, products, location_id) " +
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
        loc.id
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

  return json({ error: "Not found." }, 404);
}
