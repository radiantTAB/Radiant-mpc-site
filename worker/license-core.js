// license-core.js — core license-key logic.
// JS port of C:\Radiant_License\admin\license_core.py. It MUST produce
// byte-identical tokens to the Python tool so keys issued here validate
// in every Radiant app that embeds the existing public key.
//
// KEY FORMAT (see the Python file for the full spec):
//   payload  = UTF-8 JSON, keys sorted, compact separators
//   token    = segEncode(payloadBytes) + "." + segEncode(signature)
//   signature= Ed25519 over the RAW payload bytes
//   segEncode= base64url, "=" stripped, then "-" -> "~"
//   final    = "RADKEY-" + token grouped into 6-char chunks joined by "-"

const TOKEN_PREFIX = "RADKEY-";
const GROUP_SIZE = 6;

// base64url, "=" stripped, then "-" -> "~" (so "-" is free as a separator).
function segEncode(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const b64 = btoa(bin)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return b64.replace(/-/g, "~");
}

// Sorted, de-duplicated list of non-empty product-id strings.
function cleanProducts(products) {
  const set = new Set();
  for (const p of products || []) {
    const s = String(p).trim();
    if (s) set.add(s);
  }
  if (set.size === 0) throw new Error("At least one product must be selected.");
  return [...set].sort();
}

// Sorted, de-duplicated, UPPER-cased list of non-empty AD-domain strings
// (site-lock). Matches radkey_sign.py: sorted({d.strip().upper()}).
function cleanDomains(domains) {
  const set = new Set();
  for (const d of domains || []) {
    const s = String(d).trim().toUpperCase();
    if (s) set.add(s);
  }
  return [...set].sort();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso, days) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Canonical UTF-8 JSON bytes: keys in sorted order, compact separators.
// Matches Python json.dumps(sort_keys=True, separators=(",",":")).
function payloadToBytes(payload) {
  // Keys MUST be emitted in sorted order (matches Python json.dumps sort_keys=True).
  // `domains` sorts between customer and expires; included only when present, so
  // tokens WITHOUT a site-lock stay byte-identical to before (web-app keys unchanged).
  const ordered = { customer: payload.customer };
  if (payload.domains && payload.domains.length) ordered.domains = payload.domains;
  ordered.expires = payload.expires;
  ordered.id = payload.id;
  ordered.issued = payload.issued;
  ordered.products = payload.products;
  return new TextEncoder().encode(JSON.stringify(ordered));
}

function group(tokenBody) {
  const chunks = [];
  for (let i = 0; i < tokenBody.length; i += GROUP_SIZE) {
    chunks.push(tokenBody.slice(i, i + GROUP_SIZE));
  }
  return TOKEN_PREFIX + chunks.join("-");
}

// Import the PEM-encoded PKCS8 Ed25519 private key. Accepts the full PEM
// or just its base64 body (header/footer and whitespace are stripped).
async function importPrivateKey(pem) {
  const body = String(pem)
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "Ed25519" },
    false,
    ["sign"]
  );
}

// Issue a signed license key. Returns { id, customer, issued, expires,
// products, key }. `pem` is the private signing key.
export async function signLicense(pem, customer, days, products, opts = {}) {
  customer = String(customer || "").trim();
  if (!customer) throw new Error("Customer name is required.");

  const issued = todayISO();
  let expires;
  if (opts.expires) {
    // Explicit expiry date (used by offline/Eclipse bundles with year-length terms).
    expires = String(opts.expires).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) {
      throw new Error("Expiry must be an ISO date (YYYY-MM-DD).");
    }
  } else {
    days = parseInt(days, 10);
    if (!Number.isInteger(days) || days < 1) {
      throw new Error("Trial length must be at least 1 day.");
    }
    expires = addDays(issued, days);
  }

  const payload = {
    id: crypto.randomUUID().replace(/-/g, "").slice(0, 12),
    customer,
    issued,
    expires,
    products: cleanProducts(products),
  };
  // Optional AD-domain site-lock for offline/Eclipse packages.
  const domains = cleanDomains(opts.domains);
  if (domains.length) payload.domains = domains;

  const payloadBytes = payloadToBytes(payload);
  const key = await importPrivateKey(pem);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "Ed25519" }, key, payloadBytes)
  );

  const tokenBody = segEncode(payloadBytes) + "." + segEncode(signature);
  return { ...payload, key: group(tokenBody) };
}
