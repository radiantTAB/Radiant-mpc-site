// income.js — Personal Income Tracker API.
//
// A private, single-operator tool that replaces the "income sites"
// spreadsheet: track hours + income per site per week, keep a running
// average per site, project each site's average out to a full-year total,
// and compare against prior years. Rates can change mid-year, so each site
// carries a dated rate history.
//
// Mounted at /admin/api/income/* — behind the admin login gate on
// /admin/* (see worker/index.js). Storage is D1 (env.DB); every table is
// created on demand by ensureIncomeSchema so there is no migration step.
//
//   income_sites   the income sites (Kettering, etc.)
//   income_rates   dated hourly-rate history per site
//   income_weeks   one row per (site, week-ending date): hours + income
//
// Projection maths (computeSiteProjection) live here so the server is the
// source of truth; the browser mirrors the same run-rate formula for the
// live dashboard. Both are covered by income.test.mjs.

// Standard weeks in a year used for the run-rate projection. Kept simple
// and constant so "average weekly × 52" is transparent; the UI shows the
// weeks-entered count alongside so the basis is never hidden.
export const WEEKS_IN_YEAR = 52;

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

// Parse a value into a finite, non-negative number. Returns fallback when
// the input is blank/invalid so a stray empty cell never blows up an INSERT.
function num(v, fallback = 0) {
  if (v === "" || v === null || v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

// A well-formed ISO date (YYYY-MM-DD)? Used to validate week-ending dates
// and rate effective dates.
function isISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ---------------------------------------------------------------- schema ---
let _incomeSchemaEnsured = false;
export async function ensureIncomeSchema(env) {
  if (_incomeSchemaEnsured || !env.DB) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS income_sites (" +
      "id TEXT PRIMARY KEY, name TEXT NOT NULL, notes TEXT, " +
      "active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, " +
      "created_at TEXT NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS income_rates (" +
      "id TEXT PRIMARY KEY, site_id TEXT NOT NULL, rate REAL NOT NULL, " +
      "effective_date TEXT NOT NULL, created_at TEXT NOT NULL)"
  ).run();
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS income_weeks (" +
      "id TEXT PRIMARY KEY, site_id TEXT NOT NULL, week_ending TEXT NOT NULL, " +
      "year INTEGER NOT NULL, hours REAL NOT NULL DEFAULT 0, " +
      "income REAL NOT NULL DEFAULT 0, notes TEXT, " +
      "created_at TEXT NOT NULL, updated_at TEXT, " +
      "UNIQUE(site_id, week_ending))"
  ).run();
  _incomeSchemaEnsured = true;
}

// ---------------------------------------------------------- projection ----
// Run-rate projection for one site in one year. Given the list of weekly
// income and hours actually recorded, the projected annual figure is the
// average per recorded week carried across the full year (weeksInYear).
//
//   avgWeekly       = ytd / weeksEntered
//   projectedAnnual = avgWeekly * weeksInYear
//                   = ytd + avgWeekly * (weeksInYear - weeksEntered)
//
// Both forms are equivalent; the second is the "project the running
// average out over the remaining weeks" phrasing. weeksEntered counts every
// recorded week row (including deliberate zero weeks) so the basis is
// explicit and adjustable by the operator.
export function computeSiteProjection(weeks, weeksInYear = WEEKS_IN_YEAR) {
  const rows = Array.isArray(weeks) ? weeks : [];
  const weeksEntered = rows.length;
  let ytdIncome = 0;
  let ytdHours = 0;
  for (const w of rows) {
    ytdIncome += num(w.income);
    ytdHours += num(w.hours);
  }
  const avgWeeklyIncome = weeksEntered ? ytdIncome / weeksEntered : 0;
  const avgWeeklyHours = weeksEntered ? ytdHours / weeksEntered : 0;
  const remainingWeeks = Math.max(0, weeksInYear - weeksEntered);
  return {
    weeksEntered,
    ytdIncome,
    ytdHours,
    avgWeeklyIncome,
    avgWeeklyHours,
    remainingWeeks,
    projectedIncome: avgWeeklyIncome * weeksInYear,
    projectedHours: avgWeeklyHours * weeksInYear,
  };
}

// The rate in effect on a given date: the most recent rate whose effective
// date is on or before it; if the date precedes every rate, the earliest
// rate; null when the site has no rates at all.
function rateForDate(rates, iso) {
  if (!Array.isArray(rates) || rates.length === 0) return null;
  const sorted = [...rates].sort((a, b) =>
    a.effective_date < b.effective_date ? -1 : 1
  );
  let applicable = null;
  for (const r of sorted) {
    if (r.effective_date <= iso) applicable = r;
  }
  return applicable ? applicable.rate : sorted[0].rate;
}

// ---------------------------------------------------------------- router --
export async function handleIncomeApi(request, env, url) {
  if (!env.DB) return json({ error: "Database is not connected yet." }, 500);
  await ensureIncomeSchema(env);
  const path = url.pathname;
  const method = request.method;

  // ---- GET /admin/api/income/overview?year=YYYY ----
  // Everything the dashboard needs in one shot: all sites (with rate
  // history + the rate in effect today), the selected year's weekly rows,
  // per-site per-year totals across every year on file (for the prior-year
  // comparison), and the list of years that have any data.
  if (path === "/admin/api/income/overview" && method === "GET") {
    const today = todayISO();
    const yearParam = parseInt(url.searchParams.get("year"), 10);
    const year = Number.isInteger(yearParam)
      ? yearParam
      : parseInt(today.slice(0, 4), 10);

    const sitesRows =
      (await env.DB.prepare(
        "SELECT * FROM income_sites ORDER BY sort_order, name"
      ).all()).results || [];
    const rateRows =
      (await env.DB.prepare(
        "SELECT * FROM income_rates ORDER BY effective_date"
      ).all()).results || [];
    const weekRows =
      (await env.DB.prepare(
        "SELECT * FROM income_weeks ORDER BY week_ending"
      ).all()).results || [];

    const ratesBySite = {};
    for (const r of rateRows) {
      (ratesBySite[r.site_id] = ratesBySite[r.site_id] || []).push({
        id: r.id,
        rate: r.rate,
        effective_date: r.effective_date,
      });
    }

    const sites = sitesRows.map((s) => {
      const rates = ratesBySite[s.id] || [];
      return {
        id: s.id,
        name: s.name,
        notes: s.notes || "",
        active: !!s.active,
        sort_order: s.sort_order || 0,
        rates,
        current_rate: rateForDate(rates, today),
      };
    });

    // Per-site per-year totals for every year on file.
    const yearTotals = {};
    const yearSet = new Set();
    for (const w of weekRows) {
      yearSet.add(w.year);
      const y = String(w.year);
      const yt = (yearTotals[y] = yearTotals[y] || {});
      const st = (yt[w.site_id] = yt[w.site_id] || { income: 0, hours: 0, weeks: 0 });
      st.income += num(w.income);
      st.hours += num(w.hours);
      st.weeks += 1;
    }

    const years = [...yearSet];
    if (!years.includes(year)) years.push(year);
    years.sort((a, b) => b - a);

    const weeks = weekRows
      .filter((w) => w.year === year)
      .map((w) => ({
        id: w.id,
        site_id: w.site_id,
        week_ending: w.week_ending,
        year: w.year,
        hours: w.hours,
        income: w.income,
        notes: w.notes || "",
      }));

    return json({
      year,
      years,
      weeks_in_year: WEEKS_IN_YEAR,
      sites,
      weeks,
      year_totals: yearTotals,
    });
  }

  // ---- POST /admin/api/income/sites : create a site ----
  if (path === "/admin/api/income/sites" && method === "POST") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Site name is required." }, 400);
    const id = newId();
    // Next sort_order = current max + 1, so new sites append.
    const maxRow = await env.DB.prepare(
      "SELECT MAX(sort_order) AS m FROM income_sites"
    ).first();
    const sort = (maxRow && Number.isFinite(maxRow.m) ? maxRow.m : 0) + 1;
    await env.DB.prepare(
      "INSERT INTO income_sites (id, name, notes, active, sort_order, created_at) " +
        "VALUES (?, ?, ?, 1, ?, ?)"
    )
      .bind(id, name, String(body.notes || "").trim(), sort, new Date().toISOString())
      .run();
    return json({ ok: true, id });
  }

  // ---- PUT / DELETE /admin/api/income/sites/<id> ----
  let m = path.match(/^\/admin\/api\/income\/sites\/([^/]+)$/);
  if (m && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (!name) return json({ error: "Site name is required." }, 400);
    const active = body.active === undefined ? 1 : body.active ? 1 : 0;
    const res = await env.DB.prepare(
      "UPDATE income_sites SET name = ?, notes = ?, active = ?, sort_order = ? WHERE id = ?"
    )
      .bind(
        name,
        String(body.notes || "").trim(),
        active,
        Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
        m[1]
      )
      .run();
    if (res && res.meta && res.meta.changes === 0)
      return json({ error: "Site not found." }, 404);
    return json({ ok: true });
  }
  if (m && method === "DELETE") {
    // Remove the site and everything hanging off it.
    await env.DB.prepare("DELETE FROM income_weeks WHERE site_id = ?").bind(m[1]).run();
    await env.DB.prepare("DELETE FROM income_rates WHERE site_id = ?").bind(m[1]).run();
    await env.DB.prepare("DELETE FROM income_sites WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- POST /admin/api/income/sites/<id>/rates : add a dated rate ----
  m = path.match(/^\/admin\/api\/income\/sites\/([^/]+)\/rates$/);
  if (m && method === "POST") {
    const site = await env.DB.prepare("SELECT id FROM income_sites WHERE id = ?")
      .bind(m[1])
      .first();
    if (!site) return json({ error: "Site not found." }, 404);
    const body = await request.json().catch(() => ({}));
    const rate = Number(body.rate);
    if (!Number.isFinite(rate) || rate < 0)
      return json({ error: "Enter a valid hourly rate." }, 400);
    const effective = String(body.effective_date || "").trim();
    if (!isISODate(effective))
      return json({ error: "Enter a valid effective date (YYYY-MM-DD)." }, 400);
    const id = newId();
    await env.DB.prepare(
      "INSERT INTO income_rates (id, site_id, rate, effective_date, created_at) " +
        "VALUES (?, ?, ?, ?, ?)"
    )
      .bind(id, m[1], rate, effective, new Date().toISOString())
      .run();
    return json({ ok: true, id });
  }

  // ---- DELETE /admin/api/income/rates/<id> ----
  m = path.match(/^\/admin\/api\/income\/rates\/([^/]+)$/);
  if (m && method === "DELETE") {
    await env.DB.prepare("DELETE FROM income_rates WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  // ---- PUT /admin/api/income/weeks : upsert a weekly entry ----
  // Keyed on (site_id, week_ending). A blank hours+income pair is allowed
  // (a recorded zero week is a legitimate modelling choice) but a row that
  // is being cleared to nothing is deleted instead, keeping the grid tidy.
  if (path === "/admin/api/income/weeks" && method === "PUT") {
    const body = await request.json().catch(() => ({}));
    const siteId = String(body.site_id || "").trim();
    const weekEnding = String(body.week_ending || "").trim();
    if (!siteId) return json({ error: "site_id is required." }, 400);
    if (!isISODate(weekEnding))
      return json({ error: "Enter a valid week-ending date (YYYY-MM-DD)." }, 400);
    const site = await env.DB.prepare("SELECT id FROM income_sites WHERE id = ?")
      .bind(siteId)
      .first();
    if (!site) return json({ error: "Site not found." }, 404);

    const hours = num(body.hours);
    const income = num(body.income);
    const notes = String(body.notes || "").trim();
    const year = parseInt(weekEnding.slice(0, 4), 10);
    const now = new Date().toISOString();

    const existing = await env.DB.prepare(
      "SELECT id FROM income_weeks WHERE site_id = ? AND week_ending = ?"
    )
      .bind(siteId, weekEnding)
      .first();

    // Clearing an existing row to a true blank removes it.
    if (existing && hours === 0 && income === 0 && !notes) {
      await env.DB.prepare("DELETE FROM income_weeks WHERE id = ?")
        .bind(existing.id)
        .run();
      return json({ ok: true, deleted: true, id: existing.id });
    }

    if (existing) {
      await env.DB.prepare(
        "UPDATE income_weeks SET hours = ?, income = ?, notes = ?, year = ?, updated_at = ? WHERE id = ?"
      )
        .bind(hours, income, notes, year, now, existing.id)
        .run();
      return json({ ok: true, id: existing.id });
    }

    const id = newId();
    await env.DB.prepare(
      "INSERT INTO income_weeks (id, site_id, week_ending, year, hours, income, notes, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(id, siteId, weekEnding, year, hours, income, notes, now, now)
      .run();
    return json({ ok: true, id });
  }

  // ---- DELETE /admin/api/income/weeks/<id> ----
  m = path.match(/^\/admin\/api\/income\/weeks\/([^/]+)$/);
  if (m && method === "DELETE") {
    await env.DB.prepare("DELETE FROM income_weeks WHERE id = ?").bind(m[1]).run();
    return json({ ok: true });
  }

  return json({ error: "Not found." }, 404);
}
