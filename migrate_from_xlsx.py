"""
Rebuild the Income Tracker database from the source spreadsheet.

    python migrate_from_xlsx.py "C:\\Users\\toddb\\OneDrive\\2024 Income Statement.xlsx"

Writes income-tracker-ALLYEARS-migrated.json next to this script. Load it in
the app with Restore. Nothing here touches your existing data -- Restore does.

Why this exists: the weekly history is the only thing that is expensive to
retype. The site/rate config already ships inside index.html (seedDB), so this
script mirrors that config and reconstructs DB.weeks from the year sheets.

Sheet layout (same shape every year, columns move around):
  row 1 = site name over its block, or a number (that site's avg weekly hours)
  row 2 = column roles: Hours | [Co-Reg|Charts|Plan] | Week | Total
  row 3+= one row per work week, col A = the Monday of that week
A block runs from its named column to the column before the next named one.
Trailing blocks ("Weekly Extra($)", "Kett - Total", ...) are sheet-level
summaries, not sites, and are ignored because they have no row-1 name.
"""

import datetime
import json
import re
import sys
import uuid
from pathlib import Path

import openpyxl

YEARS = ["2022", "2023", "2024", "2025", "2026"]
# The year the app projects; earlier years are shown at their recorded actuals.
PROJECT_YEAR = "2026"

# Sheet spelling -> the site name used in the app. Anything not listed keeps
# its stripped sheet name.
ALIASES = {
    "Dayton Physicians": "DP - Remote",
    "Kettering Health - Rad Onc": "Kettering Health - RadOnc",
}

# Columns whose row-2 role means "this block is over" even though row 1 named it.
SUMMARY_ROLES = {"Weekly Extra($)", "Weekly Extra(hr)", "Total Weekly",
                 "Kett - Total", "Weekly ($)", "Weekly Hrs", "Running Total"}


def nid():
    return uuid.uuid4().hex[:12]


def clean(v):
    return re.sub(r"\s+", " ", str(v)).strip() if isinstance(v, str) else None


def num(v):
    return float(v) if isinstance(v, (int, float)) else 0.0


def iso(v):
    if isinstance(v, datetime.datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, datetime.date):
        return v.isoformat()
    return None


def find_blocks(ws):
    """[(site_name, hours_col, week_col, total_col, avg_weekly_hours)] per sheet.

    avg_weekly_hours is the bare number the sheet parks in row 1 inside a site's
    block -- that site's average weekly hours, which is what its projection runs
    on. None when the sheet doesn't carry one.
    """
    named = [c for c in range(1, ws.max_column + 1)
             if clean(ws.cell(1, c).value)
             and clean(ws.cell(2, c).value) not in SUMMARY_ROLES]
    blocks = []
    for i, start in enumerate(named):
        end = (named[i + 1] - 1) if i + 1 < len(named) else ws.max_column
        roles = {c: clean(ws.cell(2, c).value) for c in range(start, end + 1)}
        totals = [c for c, r in roles.items() if r == "Total"]
        weeks = [c for c, r in roles.items() if r == "Week"]
        if not totals or not weeks:
            continue  # not a site block (e.g. a stray label)
        total_col = totals[-1]
        week_col = max(c for c in weeks if c < total_col)
        hours = [c for c, r in roles.items() if r == "Hours"]
        # 2026 "DP - Onsite" has a blank row-2 header; its hours live in the
        # named column itself.
        hours_col = hours[0] if hours else start
        name = clean(ws.cell(1, start).value)
        avg = next((ws.cell(1, c).value for c in range(start, end + 1)
                    if isinstance(ws.cell(1, c).value, (int, float))), None)
        blocks.append((ALIASES.get(name, name), hours_col, week_col, total_col, avg))
    return blocks


def week_key(ws, row, year):
    """The Monday of this work week, as YYYY-MM-DD, pinned to the sheet's year.

    The app derives a week's year from this string, so a week the sheet counts
    as its own has to carry that year. 2025 opens on Mon 2024-12-30 and 2026 on
    a part-week typed as text ("1/1 to 1/4"); both belong to their sheet. Years
    never overlap (2024 ends 12-23, 2025 starts 12-30), so clamping is safe.
    """
    d = iso(ws.cell(row, 1).value)
    if d is None:
        # Free-text week label: fall back to the Kettering Sun-Sat start date.
        for c in range(1, ws.max_column + 1):
            if clean(ws.cell(2, c).value) == "Sun-Sat Work Week":
                d = iso(ws.cell(row, c).value)
                break
    if d is None:
        return None
    if d[:4] < year:
        return f"{year}-01-01"
    if d[:4] > year:
        return f"{year}-12-31"
    return d


def parse_year(ws, year):
    blocks = find_blocks(ws)
    weeks, totals = [], {}
    for row in range(3, ws.max_row + 1):
        label = clean(ws.cell(row, 1).value)
        if label and label.lower().startswith("total"):
            # Hours sum under the Hours column, but the money is the last value
            # of the running Total column -- not the per-week column.
            for name, hc, _, tc, _a in blocks:
                totals[name] = (num(ws.cell(row, hc).value),
                                num(ws.cell(row, tc).value))
            break
        key = week_key(ws, row, year)
        if not key:
            continue
        for name, hc, wc, _tc, _a in blocks:
            h, inc = num(ws.cell(row, hc).value), num(ws.cell(row, wc).value)
            if h or inc:
                # Do not round to cents here: the sheet's weekly figures are
                # unrounded, and rounding 50+ of them drifts the yearly total by
                # a few cents. Store what the sheet stores; the app formats.
                weeks.append({"site": name, "week_ending": key,
                              "hours": round(h, 4), "income": round(inc, 6)})
    return blocks, weeks, totals


def seed_config():
    """Mirrors seedDB() in index.html -- keep the two in step."""
    def r(rate, date, wks):
        return {"id": nid(), "rate": rate, "effective_date": date, "proj_weeks": wks}

    def mk(name, method, rates=None, **extra):
        s = {"id": nid(), "name": name, "notes": "", "sort_order": 0,
             "method": method, "manual_hours": None, "rates": rates or []}
        s.update(extra)
        return s

    sites = [
        mk("OPEN / OTHER", "income_actual"),
        mk("DP - Remote", "runrate", [r(125.87, "2026-01-01", 52)]),
        mk("DP - Onsite", "manual", [r(175.95, "2026-01-01", 52)], manual_hours=112.5),
        mk("Kettering - Gamma Knife", "runrate",
           [r(119.55, "2026-01-01", 27), r(134.64, "2026-07-01", 52)], kt_cc="GK"),
        mk("Kettering Health - RadOnc", "runrate",
           [r(119.55, "2026-01-01", 27), r(134.64, "2026-07-01", 52)], kt_cc="RO"),
        mk("OMPC - On-Site", "actual", [r(220, "2026-01-01", 52)]),
        mk("OMPC - Remote", "actual", [r(120, "2026-01-01", 52)]),
        # Retired, but its history is in the sheet and has to land somewhere.
        mk("Wright-Patt", "income_actual"),
    ]
    for i, s in enumerate(sites):
        s["sort_order"] = i
    yoy = {"cols": ["DP-R", "DP-OS", "K-GK", "K-RO", "OMPC-OS", "OMPC-R"], "rows": {
        "2023": {"DP-R": 31.4, "DP-OS": 111.15, "K-GK": 5.99, "K-RO": 5.99,
                 "OMPC-OS": 24, "OMPC-R": 892.25},
        "2024": {"DP-R": 19.22, "DP-OS": 265.25, "K-GK": 5.37, "K-RO": 8.25,
                 "OMPC-OS": 0, "OMPC-R": 513.75},
        "2025": {"DP-R": 30.35, "DP-OS": 263.75, "K-GK": 6.74, "K-RO": 12.83,
                 "OMPC-OS": 347.01, "OMPC-R": 470.5},
        "2026": {"DP-R": 35.83, "DP-OS": 112.5, "K-GK": 7.22, "K-RO": 9.37,
                 "OMPC-OS": 474.72, "OMPC-R": 392.5}}}
    projYear = {"2022": 446079.96, "2023": 655226, "2024": 577119.01,
                "2025": 616608.03}
    return sites, yoy, projYear


def build(xlsx_path):
    wb = openpyxl.load_workbook(xlsx_path, data_only=True)
    sites, yoy, projYear = seed_config()
    by_name = {s["name"]: s for s in sites}

    db_weeks, report = [], []
    for year in YEARS:
        if year not in wb.sheetnames:
            print(f"  {year}: sheet missing, skipped")
            continue
        blocks, weeks, totals = parse_year(wb[year], year)
        for w in weeks:
            site = by_name.get(w["site"])
            if site is None:  # a site that only ever appears in old years
                site = by_name[w["site"]] = {
                    "id": nid(), "name": w["site"], "notes": "",
                    "sort_order": len(by_name), "method": "income_actual",
                    "manual_hours": None, "rates": []}
                sites.append(site)
            db_weeks.append({"id": nid(), "site_id": site["id"],
                             "week_ending": w["week_ending"], "hours": w["hours"],
                             "income": w["income"], "notes": ""})
        report.append((year, weeks, totals))

        # Freeze the projection onto the sheet's own averages for the year being
        # projected. Without this the app averages the weeks recorded so far,
        # which runs hot: a site logged in 29 of 52 weeks averages over 29, while
        # the sheet averages over its full plan.
        if year == PROJECT_YEAR:
            for name, _hc, _wc, _tc, avg in blocks:
                site = by_name.get(name)
                if site and avg:
                    for r in site["rates"]:
                        r["avg_hours"] = round(float(avg), 6)

    db = {"version": 2, "sites": sites, "weeks": db_weeks, "yoy": yoy,
          "projYear": projYear,
          "kettering": {"payPeriods": [], "weeks": []},
          "dp": {"onsite": {"weeks": []}, "remote": {"weeks": []}}}
    return db, report


def check(report):
    """Each year's parsed sum must equal that sheet's own Totals row."""
    ok = True
    for year, weeks, totals in report:
        got = {}
        for w in weeks:
            h, i = got.get(w["site"], (0.0, 0.0))
            got[w["site"]] = (h + w["hours"], i + w["income"])
        print(f"\n  {year}: {len(weeks)} week-rows")
        for name, (want_h, want_i) in sorted(totals.items()):
            gh, gi = got.get(name, (0.0, 0.0))
            bad = abs(gh - want_h) > 0.02 or abs(gi - want_i) > 0.02
            ok &= not bad
            print(f"    {'FAIL' if bad else 'ok  '} {name:<28} "
                  f"hrs {gh:>9.2f}/{want_h:<9.2f} $ {gi:>12.2f}/{want_i:<12.2f}")
    return ok


def demo():
    """Self-check on a synthetic sheet: block detection + week extraction."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "2026"
    for c, v in [(2, "Site A"), (5, "                 Kettering - Gamma Knife")]:
        ws.cell(1, c).value = v
    ws.cell(1, 8).value = 12.5  # a row-1 average, must not become a site
    for c, v in [(1, "Work Week"), (2, "Hours"), (3, "Week"), (4, "Total"),
                 (5, "Sun-Sat Work Week"), (7, "Hours"), (8, "Co-Reg"),
                 (9, "Week"), (10, "Total"), (11, "Weekly Extra($)")]:
        ws.cell(2, c).value = v
    ws.cell(3, 1).value = datetime.datetime(2025, 12, 29)   # prior-year Monday
    ws.cell(3, 2).value, ws.cell(3, 3).value, ws.cell(3, 4).value = 4.0, 400.0, 400.0
    ws.cell(3, 7).value, ws.cell(3, 9).value, ws.cell(3, 10).value = 2.0, 269.28, 269.28
    ws.cell(4, 1).value = datetime.datetime(2026, 1, 5)
    ws.cell(4, 2).value, ws.cell(4, 3).value, ws.cell(4, 4).value = 8.0, 800.0, 1200.0
    ws.cell(5, 1).value = "Totals"
    ws.cell(5, 2).value, ws.cell(5, 4).value = 12.0, 1200.0
    ws.cell(5, 7).value, ws.cell(5, 10).value = 2.0, 269.28

    blocks = find_blocks(ws)
    assert [b[0] for b in blocks] == ["Site A", "Kettering - Gamma Knife"], blocks
    assert blocks[0][1:] == (2, 3, 4, None), blocks[0]
    # Skips the two date cols; picks up the row-1 average parked at c8.
    assert blocks[1][1:] == (7, 9, 10, 12.5), blocks[1]
    _, weeks, totals = parse_year(ws, "2026")
    assert len(weeks) == 3, weeks
    # Prior-year Monday is pulled into the sheet's year, not dropped.
    assert {w["week_ending"] for w in weeks} == {"2026-01-01", "2026-01-05"}, weeks
    assert sum(w["income"] for w in weeks) == 1469.28, weeks
    # Totals row reads the running-total column, not the per-week column.
    assert totals == {"Site A": (12.0, 1200.0),
                      "Kettering - Gamma Knife": (2.0, 269.28)}, totals
    print("demo: ok")


if __name__ == "__main__":
    if "--demo" in sys.argv:
        demo()
        raise SystemExit(0)
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = Path(sys.argv[1])
    print(f"Reading {src}")
    db, report = build(src)
    good = check(report)
    out = Path(__file__).with_name("income-tracker-ALLYEARS-migrated.json")
    out.write_text(json.dumps(db), encoding="utf-8")
    print(f"\n  {len(db['weeks'])} weeks -> {out}")
    print("  All year totals match the sheet." if good
          else "\n  *** Totals do not match -- do not Restore this. ***")
    raise SystemExit(0 if good else 1)
