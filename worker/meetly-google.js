// meetly-google.js — optional Google Calendar integration for Meetly.
//
// When the host connects their Google account, Meetly can (a) hide times that
// are busy on their calendar and (b) create a calendar event for each booking.
//
// Requires secrets GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET, and the redirect
// URI <origin>/api/meetly/oauth/google/callback registered in the Google Cloud
// console. Nothing here runs unless the host explicitly connects.
//
// The pure helpers (googleAuthUrl) are unit-tested; the network calls are
// covered with a mocked fetch. The live OAuth handshake + real API responses
// can only be verified against real Google credentials on a deploy.

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

export function googleConfigured(env) {
  return !!(env && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}
export function redirectUri(url) {
  return url.origin + "/api/meetly/oauth/google/callback";
}
export function googleAuthUrl(env, url, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return AUTH_ENDPOINT + "?" + p.toString();
}

export async function exchangeCode(env, url, code) {
  const body = new URLSearchParams({
    code,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri(url),
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error("google token exchange failed: " + res.status);
  return res.json(); // { access_token, refresh_token, expires_in, ... }
}

// Short-lived access tokens, cached per isolate by refresh token.
const _tokenCache = new Map();
export async function accessToken(env, refreshToken, nowMs) {
  const now = nowMs != null ? nowMs : Date.now();
  const cached = _tokenCache.get(refreshToken);
  if (cached && cached.exp > now + 60000) return cached.token;
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!res.ok) throw new Error("google token refresh failed: " + res.status);
  const data = await res.json();
  _tokenCache.set(refreshToken, { token: data.access_token, exp: now + (data.expires_in || 3600) * 1000 });
  return data.access_token;
}

export async function getEmail(accessTok) {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", { headers: { authorization: "Bearer " + accessTok } });
    if (res.ok) { const d = await res.json(); return d.email || ""; }
  } catch (_) {}
  return "";
}

// Busy intervals for a calendar between two RFC3339 instants.
export async function freeBusy(accessTok, calendarId, timeMinISO, timeMaxISO) {
  const id = calendarId || "primary";
  const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { authorization: "Bearer " + accessTok, "content-type": "application/json" },
    body: JSON.stringify({ timeMin: timeMinISO, timeMax: timeMaxISO, items: [{ id }] }),
  });
  if (!res.ok) throw new Error("google freebusy failed: " + res.status);
  const data = await res.json();
  const cal = data.calendars && data.calendars[id];
  return (cal && cal.busy) || []; // [{ start, end }] RFC3339
}

export async function insertEvent(accessTok, calendarId, event) {
  const id = calendarId || "primary";
  // conferenceDataVersion=1 lets the event request a Google Meet link.
  const res = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(id) + "/events?sendUpdates=all&conferenceDataVersion=1",
    { method: "POST", headers: { authorization: "Bearer " + accessTok, "content-type": "application/json" }, body: JSON.stringify(event) }
  );
  if (!res.ok) throw new Error("google event insert failed: " + res.status);
  return res.json();
}

// Pull a Meet (or other conference) join URL out of a created event.
export function meetLinkFrom(ev) {
  if (!ev) return "";
  if (ev.hangoutLink) return ev.hangoutLink;
  const eps = (ev.conferenceData && ev.conferenceData.entryPoints) || [];
  const video = eps.find((e) => e.entryPointType === "video");
  return (video && video.uri) || "";
}
