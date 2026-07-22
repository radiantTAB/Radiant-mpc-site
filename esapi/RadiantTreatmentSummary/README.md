# Radiant Treatment Summary

A **one-click, read-only ESAPI binary plugin** for **Varian Eclipse v15.6**.
Open a patient's plan, run the plugin, and get a clean, printable treatment
summary / prescription document that opens in your browser (print to PDF with
`Ctrl+P`).

> Read-only. This plugin never modifies the Eclipse database — it only reads
> the active plan of record.

The report is styled to match the **Varian Portal Dosimetry / Eclipse clinical
UI** — dark charcoal panels, light text, Varian-blue accent — so it feels native
on the treatment-planning workstation. A print override swaps to a clean white
sheet (accents preserved) so the saved PDF stays legible and toner-friendly.

## What it reports

- **Patient & plan** — MRN, name, DOB, course/plan IDs, approval status, CT/image
- **Prescription** — planned dose, dose/fraction, fractions, normalization, plan
  target, plus the linked `RTPrescription` (physician order) and per-target rows
  when one is attached
- **Fields & delivery** — per-beam technique (VMAT / IMRT / arc / static), energy,
  MU, gantry (with arc start→stop and direction), collimator, couch, MLC type, and
  total MU; treatment unit
- **Target coverage** — D98 / D95 / D50 / D2 for every PTV/CTV/GTV (configurable)
- **Organ-at-risk doses** — max / mean / Vx / Dx for a configurable OAR list
- **Sign-off block** — prepared-by / physics / MD lines for the printed chart

## Requirements

- Eclipse **v15.6** with the Eclipse Scripting API installed
- Visual Studio 2017+ (or `msbuild`) targeting **.NET Framework 4.6.1**, **x86**
- The version-matched ESAPI assemblies on the build machine:
  - `VMS.TPS.Common.Model.API.dll`
  - `VMS.TPS.Common.Model.Types.dll`

  These are **not redistributable** and are deliberately **not** in this repo.

## Build

1. Edit `RadiantTreatmentSummary.csproj` and set `<EsapiRefPath>` to your v15.6
   API folder, e.g. `C:\Program Files (x86)\Varian\RTM\15.6\esapi\API`.
2. Build in **Release / x86**:
   ```powershell
   msbuild RadiantTreatmentSummary.csproj /p:Configuration=Release /p:Platform=x86
   ```
3. Output: `bin\Release\RadiantTreatmentSummary.dll`.

## Deploy

Copy `RadiantTreatmentSummary.dll` into your clinic's Eclipse **published
scripts** folder (the location your site configured for approved binary
plugins), then have your Eclipse admin **approve/publish** it. Because it is
marked `[assembly: ESAPIScript(IsWriteable = false)]`, approved (non-research)
Eclipse will load it.

Run it from **Tools ▸ Scripts** with a plan active.

## Configure

All tuning is at the top of `Script.cs`:

| Setting | Purpose |
|---|---|
| `Anonymize` | Blank patient identifiers for teaching files / screenshots |
| `OutputFolder` | Where the HTML is written (falls back to `%TEMP%`) |
| `TargetCoverageVolumes` | Which Dx% columns appear for targets |
| `OarMetrics` | The OAR rows — structure ID + metric (Max/Mean/Vx/Dx). Match your clinic's structure naming. |

Structures that aren't present or are empty are skipped silently, so it's safe
to list a superset of your naming conventions.

## Notes & caveats

- Coverage and OAR metrics require **calculated dose**; without it those
  sections say so and the rest of the report still renders.
- "Max" is reported as `D0.0%` (dose to ~0 % volume) as a practical near-max;
  adjust to a small absolute volume (e.g. 0.03 cc) if your protocol requires it.
- `RTPrescription` availability varies by configuration/version; the plugin
  degrades gracefully to the plan-level fractionation when it isn't exposed.
- Validate every value against Eclipse and your commissioning/QA program before
  any clinical use. Provided as-is.

---

© Radiant Medical Physics Consulting LLC.
