// Self-check for the Income Tracker backend: `node worker/income.test.mjs`
// Drives the real handleIncomeApi against an in-memory D1 mock — no network,
// no wrangler. Covers the pure projection maths, site/rate/week CRUD, the
// clear-to-blank delete behaviour, current-rate resolution, and the overview
// roll-up used by the dashboard.
import assert from "node:assert";
import {
  handleIncomeApi,
  computeSiteProjection,
  WEEKS_IN_YEAR,
} from "./income.js";

// ---- Minimal in-memory D1 mock (only the queries income.js issues) --------
function makeDb() {
  const state = { sites: [], rates: [], weeks: [] };

  function exec(sql, a) {
    a = a || [];
    if (/^\s*CREATE TABLE/i.test(sql)) return { _run: { meta: { changes: 0 } } };

    // ---- sites ----
    if (/SELECT \* FROM income_sites ORDER BY/.test(sql))
      return {
        _all: [...state.sites].sort(
          (x, y) => x.sort_order - y.sort_order || x.name.localeCompare(y.name)
        ),
      };
    if (/SELECT MAX\(sort_order\) AS m FROM income_sites/.test(sql)) {
      const m = state.sites.reduce((mx, s) => Math.max(mx, s.sort_order), 0);
      return { _first: { m: state.sites.length ? m : null } };
    }
    if (/SELECT id FROM income_sites WHERE id = \?/.test(sql)) {
      const s = state.sites.find((x) => x.id === a[0]);
      return { _first: s ? { id: s.id } : null };
    }
    if (/INSERT INTO income_sites/.test(sql)) {
      state.sites.push({
        id: a[0], name: a[1], notes: a[2], active: 1,
        sort_order: a[3], created_at: a[4],
      });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/UPDATE income_sites SET/.test(sql)) {
      const s = state.sites.find((x) => x.id === a[4]);
      if (s) { s.name = a[0]; s.notes = a[1]; s.active = a[2]; s.sort_order = a[3]; }
      return { _run: { meta: { changes: s ? 1 : 0 } } };
    }
    if (/DELETE FROM income_sites WHERE id = \?/.test(sql)) {
      const n = state.sites.length;
      state.sites = state.sites.filter((x) => x.id !== a[0]);
      return { _run: { meta: { changes: n - state.sites.length } } };
    }

    // ---- rates ----
    if (/SELECT \* FROM income_rates ORDER BY/.test(sql))
      return {
        _all: [...state.rates].sort((x, y) =>
          x.effective_date < y.effective_date ? -1 : 1
        ),
      };
    if (/INSERT INTO income_rates/.test(sql)) {
      state.rates.push({
        id: a[0], site_id: a[1], rate: a[2], effective_date: a[3], created_at: a[4],
      });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM income_rates WHERE site_id = \?/.test(sql)) {
      state.rates = state.rates.filter((x) => x.site_id !== a[0]);
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM income_rates WHERE id = \?/.test(sql)) {
      state.rates = state.rates.filter((x) => x.id !== a[0]);
      return { _run: { meta: { changes: 1 } } };
    }

    // ---- weeks ----
    if (/SELECT \* FROM income_weeks ORDER BY/.test(sql))
      return {
        _all: [...state.weeks].sort((x, y) =>
          x.week_ending < y.week_ending ? -1 : 1
        ),
      };
    if (/SELECT id FROM income_weeks WHERE site_id = \? AND week_ending = \?/.test(sql)) {
      const w = state.weeks.find(
        (x) => x.site_id === a[0] && x.week_ending === a[1]
      );
      return { _first: w ? { id: w.id } : null };
    }
    if (/UPDATE income_weeks SET/.test(sql)) {
      const w = state.weeks.find((x) => x.id === a[5]);
      if (w) { w.hours = a[0]; w.income = a[1]; w.notes = a[2]; w.year = a[3]; w.updated_at = a[4]; }
      return { _run: { meta: { changes: w ? 1 : 0 } } };
    }
    if (/INSERT INTO income_weeks/.test(sql)) {
      state.weeks.push({
        id: a[0], site_id: a[1], week_ending: a[2], year: a[3],
        hours: a[4], income: a[5], notes: a[6], created_at: a[7], updated_at: a[8],
      });
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM income_weeks WHERE site_id = \?/.test(sql)) {
      state.weeks = state.weeks.filter((x) => x.site_id !== a[0]);
      return { _run: { meta: { changes: 1 } } };
    }
    if (/DELETE FROM income_weeks WHERE id = \?/.test(sql)) {
      const n = state.weeks.length;
      state.weeks = state.weeks.filter((x) => x.id !== a[0]);
      return { _run: { meta: { changes: n - state.weeks.length } } };
    }

    throw new Error("Unmocked SQL: " + sql);
  }

  function prepare(sql) {
    let args = [];
    const stmt = {
      bind(...a) { args = a; return stmt; },
      async run() { return exec(sql, args)._run || { meta: { changes: 0 } }; },
      async first() { const r = exec(sql, args); return r._first === undefined ? null : r._first; },
      async all() { const r = exec(sql, args); return { results: r._all || [] }; },
    };
    return stmt;
  }
  return { prepare };
}

function makeEnv() { return { DB: makeDb() }; }

async function call(env, method, path, body) {
  const url = new URL("https://app.radiant-mpc.com" + path);
  const req = new Request(url, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const resp = await handleIncomeApi(req, env, url);
  const data = await resp.json().catch(() => ({}));
  return { status: resp.status, data };
}

let passed = 0;
function ok(name) { passed++; console.log("  ok -", name); }

// ---------------------------------------------------------------- tests ----

// 1) Pure projection maths.
{
  const p = computeSiteProjection(
    [{ hours: 10, income: 1000 }, { hours: 20, income: 2000 }, { hours: 30, income: 3000 }],
    52
  );
  assert.strictEqual(p.weeksEntered, 3);
  assert.strictEqual(p.ytdIncome, 6000);
  assert.strictEqual(p.ytdHours, 60);
  assert.strictEqual(p.avgWeeklyIncome, 2000);
  assert.strictEqual(p.projectedIncome, 104000); // 2000 * 52
  assert.strictEqual(p.projectedHours, 20 * 52);
  assert.strictEqual(p.remainingWeeks, 49);
  // Equivalence: ytd + avg * remaining == avg * weeksInYear
  assert.strictEqual(p.ytdIncome + p.avgWeeklyIncome * p.remainingWeeks, p.projectedIncome);
  ok("computeSiteProjection run-rate + equivalence");
}

// 2) Empty projection never divides by zero.
{
  const p = computeSiteProjection([], 52);
  assert.strictEqual(p.avgWeeklyIncome, 0);
  assert.strictEqual(p.projectedIncome, 0);
  assert.strictEqual(p.remainingWeeks, 52);
  ok("computeSiteProjection empty is safe");
}

// 3) Full CRUD + overview roll-up + current-rate resolution.
{
  const env = makeEnv();

  // Create two sites.
  const s1 = await call(env, "POST", "/admin/api/income/sites", { name: "Kettering" });
  assert.strictEqual(s1.status, 200);
  const kettering = s1.data.id;
  const s2 = await call(env, "POST", "/admin/api/income/sites", { name: "Mercy", notes: "PRN" });
  const mercy = s2.data.id;
  assert.ok(kettering && mercy && kettering !== mercy);
  ok("create sites");

  // Missing name is rejected.
  const bad = await call(env, "POST", "/admin/api/income/sites", { name: "" });
  assert.strictEqual(bad.status, 400);
  ok("site name required");

  // Dated rates: a mid-year raise.
  await call(env, "POST", `/admin/api/income/sites/${kettering}/rates`, { rate: 200, effective_date: "2026-01-01" });
  await call(env, "POST", `/admin/api/income/sites/${kettering}/rates`, { rate: 225, effective_date: "2026-07-01" });
  const badRate = await call(env, "POST", `/admin/api/income/sites/${kettering}/rates`, { rate: -5, effective_date: "2026-01-01" });
  assert.strictEqual(badRate.status, 400);
  ok("add dated rates, reject negative");

  // Weekly entries (upsert).
  await call(env, "PUT", "/admin/api/income/weeks", { site_id: kettering, week_ending: "2026-01-04", hours: 40, income: 8000 });
  await call(env, "PUT", "/admin/api/income/weeks", { site_id: kettering, week_ending: "2026-01-11", hours: 30, income: 6000 });
  await call(env, "PUT", "/admin/api/income/weeks", { site_id: mercy, week_ending: "2026-01-04", hours: 10, income: 1500 });
  // Prior year for comparison.
  await call(env, "PUT", "/admin/api/income/weeks", { site_id: kettering, week_ending: "2025-12-28", hours: 20, income: 4000 });
  ok("insert weekly entries across sites and years");

  // Upsert overwrites the same (site, week).
  await call(env, "PUT", "/admin/api/income/weeks", { site_id: kettering, week_ending: "2026-01-11", hours: 32, income: 6400 });

  // Overview for 2026.
  const ov = await call(env, "GET", "/admin/api/income/overview?year=2026");
  assert.strictEqual(ov.status, 200);
  assert.strictEqual(ov.data.year, 2026);
  assert.strictEqual(ov.data.weeks_in_year, WEEKS_IN_YEAR);
  assert.deepStrictEqual(ov.data.years, [2026, 2025]);
  assert.strictEqual(ov.data.weeks.length, 3); // only 2026 rows
  // Current rate resolves to the raise (today is past 2026-07-01 in this repo's timeline,
  // but the test must not depend on the clock — assert it's one of the two known rates).
  const kSite = ov.data.sites.find((s) => s.id === kettering);
  assert.ok([200, 225].includes(kSite.current_rate));
  assert.strictEqual(kSite.rates.length, 2);
  // Prior-year total present.
  assert.strictEqual(ov.data.year_totals["2025"][kettering].income, 4000);
  assert.strictEqual(ov.data.year_totals["2026"][kettering].income, 8000 + 6400);
  ok("overview roll-up: years, weeks filter, rates, prior-year totals, upsert");

  // Clearing a week to blank deletes it.
  const del = await call(env, "PUT", "/admin/api/income/weeks", { site_id: mercy, week_ending: "2026-01-04", hours: 0, income: 0 });
  assert.strictEqual(del.data.deleted, true);
  const ov2 = await call(env, "GET", "/admin/api/income/overview?year=2026");
  assert.strictEqual(ov2.data.weeks.filter((w) => w.site_id === mercy).length, 0);
  ok("clear-to-blank deletes the week row");

  // Delete a site cascades to its weeks + rates.
  await call(env, "DELETE", `/admin/api/income/sites/${kettering}`);
  const ov3 = await call(env, "GET", "/admin/api/income/overview?year=2026");
  assert.strictEqual(ov3.data.sites.find((s) => s.id === kettering), undefined);
  assert.strictEqual(ov3.data.weeks.filter((w) => w.site_id === kettering).length, 0);
  ok("delete site cascades to weeks + rates");
}

console.log(`\nAll ${passed} income-tracker checks passed.`);
