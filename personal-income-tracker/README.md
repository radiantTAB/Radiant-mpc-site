# Personal Income Tracker (standalone)

A single, self-contained tool for tracking hours and income per site per
week, carrying a running weekly average out to a full-year projection, and
comparing against prior years. It is **not** part of the Radiant website —
it only borrows the visual theme.

## How to use it

1. Download **`index.html`** to your computer (e.g. rename it to
   `income-tracker.html` if you like).
2. **Double-click** it — it opens in your browser. No install, no internet
   needed, nothing is uploaded anywhere.
3. Add your sites, set hourly rates (you can add a new dated rate whenever
   a rate changes mid-year), and enter hours + income each week in the grid.

## Your data

- Everything is saved **automatically in that browser, on that computer**
  (browser local storage). Close and reopen the file and it's still there.
- **Back it up often.** Click **Backup** to download a `.json` copy you
  control. Click **Restore** to load one back — this is also how you move
  your data to a new computer, a new browser, or recover it if the browser
  cache is ever cleared.
- **Export CSV** produces a spreadsheet-friendly copy of every week.
- If you open the file in private/incognito mode, auto-save may be blocked;
  a banner will warn you, and you should Backup before closing.

## How the projection works

For each site in the selected year:

```
avg per recorded week = (income you've recorded) / (weeks you've recorded)
projected annual       = avg per recorded week x 52
```

The "Wks" column shows how many weeks are behind the average, so the basis
is always visible. Prior-year totals and the projected-vs-prior delta are
shown per site and overall.

## Turning it into a Windows `.exe` (later)

The same `index.html` can be wrapped into a desktop app with
[Electron](https://www.electronjs.org/) or [Tauri](https://tauri.app/) so it
runs as a normal `.exe` that auto-saves to a real file. That's a planned
follow-up — the single-file version above works today.

## Next planned feature

Kettering detail: clock-in/out by cost center (RO / GK) rolled into 2-week
pay periods, RO charts-per-day + weekly hours, and GK GL CoReg cases +
weekly hours.
