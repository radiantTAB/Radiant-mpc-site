# Radiant ESAPI plugins

Eclipse Scripting API (ESAPI) plugins for **Varian Eclipse v15.6**, built by
Radiant Medical Physics Consulting.

| Plugin | Type | What it does |
|---|---|---|
| [`RadiantTreatmentSummary`](RadiantTreatmentSummary/) | Read-only binary plugin | One-click printable treatment summary / prescription document |

Each plugin folder has its own build & deploy instructions. The
version-matched ESAPI assemblies (`VMS.TPS.Common.Model.*.dll`) are **not
redistributable** and are intentionally excluded from this repo — set the
reference path to your local Eclipse install when building.
