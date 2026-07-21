// Self-check for the portal password-reset flow: `node worker/portal-reset.test.mjs`
// Fakes just enough of D1 + the EMAIL binding to drive forgot -> reset -> login.
import assert from "node:assert";
import { handlePortalApi, hashPassword } from "./portal.js";

const db = { clients: [], portal_resets: [], portal_sessions: [] };
let sentMail = null;

// Stub the Resend call.
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.headers.authorization, "Bearer test-key");
  sentMail = JSON.parse(init.body);
  return new Response("{}", { status: 200 });
};

// ponytail: substring-matched SQL shim, not a D1 emulator. If a query is
// added to portal.js and this test starts throwing "unhandled SQL", add a case.
const env = {
  RESEND_API_KEY: "test-key",
  DB: {
    prepare: (sql) => ({
      bind: (...a) => ({
        first: async () => run(sql, a),
        run: async () => run(sql, a),
        all: async () => ({ results: run(sql, a) || [] }),
      }),
      first: async () => run(sql, []),
      run: async () => run(sql, []),
    }),
  },
};

function run(sql, a) {
  if (sql.startsWith("ALTER TABLE")) throw new Error("duplicate column");
  if (sql.startsWith("CREATE TABLE")) return null;
  if (/SELECT id, name, contact_email FROM clients/.test(sql))
    return db.clients.find((c) => c.contact_email.toLowerCase() === a[0] && c.password_hash) || null;
  if (/SELECT id, password_hash/.test(sql))
    return db.clients.find((c) => c.contact_email.toLowerCase() === a[0] && c.password_hash) || null;
  if (/SELECT created_at FROM portal_resets/.test(sql))
    return db.portal_resets.filter((r) => r.client_id === a[0]).pop() || null;
  if (/SELECT client_id, expires_at FROM portal_resets/.test(sql))
    return db.portal_resets.find((r) => r.token_hash === a[0]) || null;
  if (/DELETE FROM portal_resets/.test(sql))
    return void (db.portal_resets = db.portal_resets.filter((r) => r.client_id !== a[0]));
  if (/DELETE FROM portal_sessions WHERE client_id/.test(sql))
    return void (db.portal_sessions = db.portal_sessions.filter((s) => s.client_id !== a[0]));
  if (/INSERT INTO portal_resets/.test(sql))
    return void db.portal_resets.push({ token_hash: a[0], client_id: a[1], created_at: a[2], expires_at: a[3] });
  if (/INSERT INTO portal_sessions/.test(sql))
    return void db.portal_sessions.push({ token: a[0], client_id: a[1] });
  if (/UPDATE clients SET password_hash/.test(sql)) {
    const c = db.clients.find((x) => x.id === a[1]);
    c.password_hash = a[0];
    c.must_change_password = 0;
    return null;
  }
  throw new Error("unhandled SQL: " + sql);
}

const post = (p, body) =>
  handlePortalApi(
    new Request("https://app.radiant-mpc.com" + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
    new URL("https://app.radiant-mpc.com" + p)
  );

db.clients.push({
  id: "cli_1",
  name: "Test Clinic",
  contact_email: "Doc@Clinic.org",
  password_hash: await hashPassword("old-password"),
  must_change_password: 0,
});
db.portal_sessions.push({ token: "stale", client_id: "cli_1" });

// Unknown address: same 200 as a real one, and no mail.
assert.equal((await post("/portal/api/forgot-password", { email: "nobody@x.com" })).status, 200);
assert.equal(sentMail, null, "must not mail unknown addresses");
assert.equal(db.portal_resets.length, 0);

// Real address (case-insensitive): mailed a link, token stored only as a hash.
assert.equal((await post("/portal/api/forgot-password", { email: "doc@clinic.org" })).status, 200);
assert.deepEqual(sentMail.to, ["Doc@Clinic.org"]);
const token = /token=([0-9a-f]+)/.exec(sentMail.text)[1];
assert.equal(db.portal_resets.length, 1);
assert.notEqual(db.portal_resets[0].token_hash, token, "raw token must not be stored");

// Throttled: a second request inside a minute is a no-op, old token survives.
const hashBefore = db.portal_resets[0].token_hash;
sentMail = null;
await post("/portal/api/forgot-password", { email: "doc@clinic.org" });
assert.equal(sentMail, null, "second request within 60s must not mail");
assert.equal(db.portal_resets[0].token_hash, hashBefore);

// Bad token, and too-short password, both rejected.
assert.equal((await post("/portal/api/reset-password", { token: "deadbeef", new_password: "longenough" })).status, 400);
assert.equal((await post("/portal/api/reset-password", { token, new_password: "short" })).status, 400);

// Expired token rejected.
const goodExpiry = db.portal_resets[0].expires_at;
db.portal_resets[0].expires_at = new Date(Date.now() - 1000).toISOString();
assert.equal((await post("/portal/api/reset-password", { token, new_password: "brand-new-password" })).status, 400);
db.portal_resets[0].expires_at = goodExpiry;

// Happy path: password changes, token burned, every old session killed.
assert.equal((await post("/portal/api/reset-password", { token, new_password: "brand-new-password" })).status, 200);
assert.equal(db.portal_resets.length, 0, "token must be single use");
assert.equal(db.portal_sessions.length, 0, "reset must sign out existing sessions");

// Replay of the burned token fails; the new password logs in, the old does not.
assert.equal((await post("/portal/api/reset-password", { token, new_password: "another-password" })).status, 400);
assert.equal((await post("/portal/api/login", { email: "doc@clinic.org", password: "old-password" })).status, 401);
assert.equal((await post("/portal/api/login", { email: "doc@clinic.org", password: "brand-new-password" })).status, 200);

console.log("ok — portal password reset");
