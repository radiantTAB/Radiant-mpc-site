# Income Tracker — Handoff (continue in Claude Code, Windows PowerShell)

This is a **standalone personal income tracker** — one self-contained HTML
file, runs offline, data in browser `localStorage`. It borrows the Radiant
visual theme but is **not part of the radiant-mpc.com site** and shares no
code, assets, or folders with it.

Everything below is the context needed to pick up in Claude Code locally.

---

## 1. Get the code

Lives at **`C:\Users\toddb\income-tracker`** — its own folder, its own git
history, nothing to do with the Radiant site clone. It is *stored* on the
branch **`income-tracker`** of `radiantTAB/Radiant-mpc-site` (that repo is
just the backup host; the branch shares no history with `main`).

```powershell
cd C:\Users\toddb\income-tracker
git pull
```

Fresh machine:

```powershell
git clone -b income-tracker --single-branch https://github.com/radiantTAB/Radiant-mpc-site.git C:\Users\toddb\income-tracker
```

The files, all at the folder root:

| File | What it is |
|------|------------|
| `index.html` | The whole app (HTML + CSS + JS inline, ~940 lines). This is the deliverable. |
| `QUICK-START.html` | Printable one-page user guide (source for the PDF). |
| `README.md` | Short user-facing readme. |
| `HANDOFF.md` | This file. |

To run it: **just double-click `index.html`** (or `Start-Process .\index.html`). No build, no server.

---

## 2. Your data files are NOT in the repo (on purpose)

The migrated financial data was delivered as **`.json` backups in the chat**, not committed, to keep your income out of GitHub. You have:

- `income-tracker-ALLYEARS-migrated.json` — **the current one**: sites + 2022–2026 weekly data + year tables.
- (earlier: `income-tracker-2026-migrated.json` — 2026 only; superseded.)

**To load data:** open `index.html` → **Restore** → pick the ALLYEARS `.json`.
**Restore replaces everything in the file**, so **Backup first** if you've already entered timeclock/DP data.

**To regenerate the data from scratch** (no chat, no backup file needed):

```powershell
cd C:\Users\toddb\income-tracker
python migrate_from_xlsx.py "C:\Users\toddb\OneDrive\2024 Income Statement.xlsx"
```

That writes `income-tracker-ALLYEARS-migrated.json` here; Restore it. The
script self-checks every site's yearly hours and income against that sheet's
own Totals row and refuses to claim success if any disagree. Run
`python migrate_from_xlsx.py --demo` for its unit check. Close the workbook in
Excel first — an open file gives `PermissionError`.

Source spreadsheet: `C:\Users\toddb\OneDrive\2024 Income Statement.xlsx`
(sheets `2021`–`2026`, `KMC Calc`, `Predictor`). `KMC Calc` is a scratch pad
for the current pay period and `Predictor` is planning scratch — neither is
migrated, and 2021 is deliberately skipped.

**Known residual:** the regenerated 2026 projection totals **$575,563.03**
vs the validated **$574,165.25** — 0.24% high, entirely in the two Kettering
sites (GK +$777, RadOnc +$621). Every other site matches to the cent. Cause:
each Kettering site has two rate segments (27 wk @ $119.55 + 52 wk @ $134.64)
and the original used a *different* frozen average per segment; the script
writes the sheet's single row-1 average to both. To match exactly, edit the
second segment's avg in *Sites & rates*. Not reverse-fitted on purpose — the
numbers the script writes all come from the sheet.

---

## 3. How the app is structured

Single global `DB` object, saved to `localStorage['incomeTrackerDB_v2']`:

```js
DB = {
  version: 2,
  sites: [ { id, name, notes, sort_order, method, manual_hours, kt_cc,
             rates: [ { id, rate, effective_date, proj_weeks, avg_hours } ] } ],
  weeks: [ { id, site_id, week_ending /*YYYY-MM-DD*/, hours, income, notes } ],
  yoy:   { cols:[...], rows:{ "2023":{col:val}, ... } },   // editable YoY hours table
  projYear: { "2022":446079.96, ... },                     // total-projection-by-year table
  kettering: { payPeriods:[ {id,start,entries:[{id,date,start,stop,cc}]} ],
               weeks:[ {id,week_ending,gk_hours,coreg,ro_hours,sunmon,tue,wed,thu,frisat,qc} ] },
  dp: { onsite:{weeks:[...]}, remote:{weeks:[...]} }        // DP PRN logs; week = {week_start, days[7], loc{LOC:[7]}}
}
```

Three top-level tabs (`switchTab`): **income**, **kettering**, **dp**.
Rendering is plain vanilla JS (`renderAll`, `renderProjection`, `renderKettering`, `renderDP`, …); every mutation calls `saveDB()`.

**Year derivation:** a week's year = `week_ending.slice(0,4)`. The Income
grid shows one selected `S.year`.

---

## 4. The projection logic (the subtle part — read before touching)

Per site, `projectSite(s)` computes projected annual income. Site `method`:

- **`runrate`** — sum over each rate segment: `avg_weekly_hours × proj_weeks × rate`.
  - `avg_weekly_hours` = the segment's `avg_hours` **override** if set, else the site's live average from recorded weeks.
  - This models **mid-year rate changes**: e.g. Kettering = `27 wk @ $119.55` + `52 wk @ $134.64` as two segments.
- **`actual`** — `sum(recorded hours) × current rate` (OMPC sites; schedule pre-filled).
- **`manual`** — `manual_hours × current rate` (DP-Onsite = 112.5).
- **`income_actual` / `income_runrate`** — no rate; use dollars directly (OPEN/OTHER, Wright-Patt).

**Past years show ACTUAL, not a projection:** `if (S.year < NOW_YEAR)` →
projected = recorded totals. Only the real current calendar year
(`NOW_YEAR = new Date().getFullYear()`) uses the run-rate config, and only
it auto-fills `projYear`. Past `projYear` values stay as stored.

**Validated invariant:** with the ALLYEARS data restored, the **2026
projection totals exactly `$574,165.25`** (matches the spreadsheet to the
penny). If you change projection code, keep that true. Per-site 2026
targets: DP-Remote 234,500.15 · DP-Onsite 19,794.38 · K-GK 73,119.36 ·
K-RadOnc 95,212.16 · OMPC-OS 104,439.19 · OMPC-R 47,100.

**Timeclock → grid link** (`syncTimeclockToIncome`, the "Push GK/RO hrs →
Income grid" button): aggregates clock entries into Monday-keyed weeks and
writes GK→"Kettering - Gamma Knife", RO→"Kettering Health - RadOnc"
(matched by `kt_cc`, name fallback), $ at the week's rate. It's a **manual
button by design** (never silent-overwrites).

---

## 5. How to test changes

- **Syntax:** the JS is one inline `<script>`. Quick check:
  ```powershell
  # extract the script and run node --check, or just open DevTools console in the browser
  ```
  Simplest on Windows: open `index.html`, press **F12**, watch the Console for errors.
- **Functional:** open the file, use the UI, confirm the **2026 projected total is $574,165** after Restore. Backup → reopen → confirm data persists.
- (In the cloud session, tests ran headless Chromium with an injected
  harness that seeded `DB` and read back computed values. Locally, manual
  browser testing is usually enough; Claude Code can script Edge/Chrome
  headless if you want automated checks.)

---

## 6. Decisions already made (don't redo)

- **Standalone single file**, not integrated into the Radiant site.
- **2021 is intentionally NOT migrated** (free-form "Double-Dip" sheet).
- **Timeclock→grid stays a button**, not auto-sync.
- Kettering 2026 projection uses **frozen per-segment averages** (`avg_hours`
  overrides) so it reproduces the sheet exactly. To make it project from
  live hours instead, clear those `avg_hours` fields in *Sites & rates*.
- Financial data is **kept out of the repo**; ship it via Backup/Restore `.json`.

## Open ideas / possible next steps

- Push DP-log or Kettering hours into the DP/DP income sites automatically.
- Per-segment average that recomputes live (skip-first-week option) instead of frozen overrides.
- Migrate 2021 if ever wanted.
- Package as a Windows `.exe` (Electron/Tauri) for auto-save to a real file.

---

## 7. Git workflow

Stay on the `income-tracker` branch and keep committing there:

```powershell
cd C:\Users\toddb\income-tracker
git add index.html
git commit -m "…"
git push
```

Do **not** commit any `.json` that contains real income data. `.gitignore`
blocks `*.json` and `*.xlsx` for exactly this reason. The app + docs are
safe to commit; the data backups are not.
