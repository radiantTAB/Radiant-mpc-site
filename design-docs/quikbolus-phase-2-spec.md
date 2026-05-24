# QuikBolus Phase 2 — Mold Workflow + Printer Profiles

**Spec version:** 0.1 (draft)
**Date:** 2026-05-24
**Author:** Radiant Medical Physics Consulting / Claude Opus 4.7
**Status:** Design draft — ready for scoping; not yet committed to a release window.
**Scope:** Two related additions to the QuikBolus web app — (1) a mold-design
mode for casting Flexibolus or similar pourable tissue-equivalent silicones,
and (2) a per-printer profile system that surfaces recommended settings and
optionally bakes them into a 3MF export.

---

## 1. Executive summary

QuikBolus today produces one output: a watertight STL of a patient-anatomy
bolus. Operators take it to a slicer, dial in settings, and print on whichever
3D printer they happen to own. Two gaps cause real friction:

1. The **direct-print TPU 95A bolus** isn't the right answer for every clinical
   case. For thick bolus, dose-critical electron treatments, or chest-wall
   coverage where print times exceed 36 hours, a **printed rigid mold + cast
   Flexibolus** workflow is faster, more water-equivalent, and reusable. This
   workflow currently lives entirely in the operator's head and CAD tools.
2. **Print settings vary by printer** but the operator gets no guidance from
   QuikBolus. Wrong infill, wrong supports, wrong orientation = clinical
   failure modes (sparse infill → bad dose; wrong orientation → support scars
   on the patient-contact surface).

This spec addresses both. **Part 1** designs an interactive Mold mode inside
QuikBolus. **Part 2** designs a Target-Printer profile system that surfaces
recommended settings per printer and optionally writes a 3MF with the profile
baked in.

---

## 2. Motivation

| Pain today | Spec addresses it via |
|---|---|
| Operator picks 15% gyroid infill because that's the slicer default → bolus has wrong dose | Per-printer profile UI shows correct settings (100% infill, etc.) directly in QuikBolus |
| Chest-wall bolus print takes 50+ hours of TPU; clinic resists; operator improvises | Mold mode lets operator print a rigid mold in ~10 hours and cast Flexibolus in 4 hours of cure time |
| Trim-base-plate workflow is undocumented; operators either skip the base plate or leave it on without re-planning | Mold mode formalizes the "keep vs trim" choice and documents both paths in the output |
| Operator picks supports manually, often gets them wrong, lands support scars on patient-contact surface | Profile system encodes "orient anatomy-down, tree-organic supports, Z gap 0.25 mm" per printer |
| Operator on a non-Bambu printer (Prusa, Raise3D, Ultimaker) gets no guidance | Profile system covers ~12 common printers with sensible defaults |

---

## 3. Scope

### In scope
- New "Mold for casting" output mode in QuikBolus
- Interactive parting-plane editor with live 3D preview
- All variables enumerated in §4
- Per-printer profile picker for both direct-print and mold-print outputs
- Recommended-settings panel displayed in the UI
- 3MF export with embedded Bambu / Prusa / Orca profiles for top printers
- STL + recommendations-text-file export for everything else
- Auto-validation checks (undercut detection, volume mismatch, fit check)
- Patient-record entry for both workflows
- Generated per-case operator instruction sheet (PDF)

### Out of scope
- Direct printer control (sending G-code over LAN) — covered by a separate
  Bambu/Orca integration spec
- New material types beyond TPU 95A, Flexibolus, silicone variants
- Resin-printed molds (different workflow, different vendor ecosystem)
- Automatic anatomical-orientation detection from DICOM (parting plane stays
  manual; "suggest" only)
- Slicing inside QuikBolus (still farmed out to Bambu Studio / Orca / Prusa /
  Cura — QuikBolus produces files those slicers consume)

---

## 4. Part 1 — Mold-design workflow

A new output mode in QuikBolus. After the operator generates the bolus from
DICOM, they pick **Output mode: Direct print · Mold for casting · Both**. If
they pick Mold (or Both), a new mold-design view appears with the variables
below.

### 4.1 Casting material — declared first

Drives almost every downstream default.

| Choice | Notes |
|---|---|
| **Flexibolus** | Most common; shrinkage ~1%; room-temp pour; cure ~4 h; default |
| Silicone (Smooth-On Ecoflex, Dragon Skin) | Hot-pour; mold needs PETG over PLA; different wall-thickness defaults |
| Gelatin / agarose | Test casts only; not for clinical use |
| Custom | Operator enters density, cure temperature, shrinkage manually |

This choice is **first** in the UI because it locks in defaults for the rest.

### 4.2 Mold construction approach

| Variable | Choices |
|---|---|
| Number of parts | Single open-top mold · **Two-part split mold** (default) · Multi-part (rare) |
| Mold print material | **PETG** (default — clear, smooth, durable) · PLA (cheapest) · ABS (heat-resistant for hot-pour silicone) · Resin (smoothest interior) |
| Reuse target | Single-cast disposable · **5-10 casts** (default) · 100+ (production) |

Reuse target drives wall thickness in §4.4.

### 4.3 Parting plane — the critical interactive choice

The single biggest design decision. Needs **live 3D preview** with the split
shown in two colors and undercut highlighting in red.

| Variable | Choices |
|---|---|
| Parting direction | **Horizontal** (anatomy / air-side split — default) · Vertical (left/right) · Custom angle |
| Plane height | Interactive slider — drag to position the split through the bolus |
| Plane type | **Flat** (default) · Stepped (for multi-undercut anatomy) · Curved (rare) |
| Auto vs manual | "Suggest optimal plane" button (minimizes undercuts); operator confirms |
| Undercut detection | Live overlay highlighting non-releasing regions in red |

### 4.4 Mold geometry

| Variable | Choices / range |
|---|---|
| Wall thickness | 3 mm (thin/fast) · **5 mm (default)** · 8 mm (reusable production) |
| Floor thickness | Independent of wall; **4-6 mm** typical |
| Outside shape | Rectangular bounding box · **Contoured to bolus envelope** (default — less material) · Custom |
| Cavity scaling factor | **1.005-1.02** (compensates for Flexibolus shrinkage) — default per casting material from §4.1 |
| Air space above cavity | **5-15 mm** headroom above bolus for mixing/expansion |

### 4.5 Pour features

#### Sprue (pour-entry channel)

| Variable | Choices |
|---|---|
| Location | Click-to-place on mold surface · Auto at high point in pour orientation |
| Quantity | 1 (small bolus) · 2 (large / chest-wall — accelerates filling) |
| Diameter | 3 mm · **6 mm** (default) · 10 mm |
| Profile | Straight cylinder · **Tapered funnel** (default — easier to pour) |
| Extension above mold | 0 mm (flush) · **5 mm** (default) · 10 mm |

#### Vents (air escape)

| Variable | Choices |
|---|---|
| Locations | Click-to-place multiple · **Auto-place at every local high point** on cavity surface |
| Diameter | **1-2 mm** (just enough for air, not material) |
| Quantity | Auto-suggested by cavity geometry |

#### Risers (gravity reservoirs)

Skip for room-temp Flexibolus. Needed only for hot-pour silicones that shrink
on cooling. Out of scope for v1.

### 4.6 Mold-half registration

| Variable | Choices |
|---|---|
| Type | **Pegs & sockets** (default) · Dovetail interlock · Magnetic inserts (production) · None |
| Quantity | 3 · **4** (default, rectangular layout) · 6+ (large molds) |
| Peg diameter | 4 mm · **6 mm** (default) · 8 mm |
| Peg depth | 5 mm · **8 mm** (default) · 12 mm |
| Fit clearance | Tight 0.0 mm · **Slip 0.15 mm** (default) · Loose 0.3 mm |
| Placement | **Auto at corners** (default) · Manual click-to-place |

### 4.7 Clamping / closure

| Variable | Choices |
|---|---|
| External clamping ribs | None · 2 sides · **4 sides** (default) |
| Strap channels (for rubber bands) | **None** (default) · Default groove pattern |
| Screw bosses (heat-set inserts) | None (advanced; requires inserts; out of scope for v1) |
| Recommended closing method (informational) | Spring clamps · Rubber bands · Tape · Weight |

### 4.8 Demolding aids

| Variable | Choices |
|---|---|
| Draft angle on vertical walls | 0° · **1°** (default — eases release) · 2° · 3° |
| Pry-point notches | **None** (default) · 2 (opposite sides) · 4 (corners) |
| Surface finish recommendation (informational) | **Standard** · Smooth (polish interior) · Vapor-smooth (ABS only) |

### 4.9 Identification & traceability

| Variable | Choices |
|---|---|
| Patient identifier | **None** (default) · Initials only · Anonymous ID (auto-hash) · MRN (de-identified) |
| Location of text | Inside mold (visible only on cast) · **Outside mold** (default — visible on mold) · Both |
| Date code | None · **YYYYMMDD** (default) · Free text |
| Site / fraction info | **None** (default) · Treatment site abbreviation · Fraction count |
| Embossed depth | 0.4 mm subtle · **0.8 mm** (default) · 1.2 mm obvious |
| Recessed vs raised | **Recessed in mold = raised on cast** (default, more readable on cast) |

### 4.10 Print-orientation hints for the mold itself

QuikBolus emits these as recommendations alongside the STL/3MF export. The
slicer ultimately handles them.

| Variable | Recommended for rigid mold |
|---|---|
| Print orientation per half | Parting plane **DOWN** on build plate (cavity opens upward) |
| Support type | **Normal supports** (rigid PLA/PETG, not the tree-organic used for TPU) |
| Support locations | Only at sprue/vent overhangs |
| Layer height | **0.16 mm** (smoother cavity interior — transfers to cast surface) |
| Wall count | **4** (mold walls take pour pressure) |
| Infill | **25-40%** (rigid material; mold not dose-relevant; some structural strength) |

### 4.11 Cast-process documentation output (not geometry)

Bundled into the per-case operator instruction sheet generated by QuikBolus:

- Flexibolus volume needed (from cavity volume; in mL and grams)
- Mix ratio (per Flexibolus product spec)
- Pour temperature (room temp for Flexibolus)
- Cure time at room temperature
- Recommended mold release (Smooth-On Universal or equivalent)
- Degassing recommendation (vacuum chamber 60 s before pour)
- Demold timing
- Expected cast cost (Flexibolus per-mL price × volume)

### 4.12 Validation / QA — automatic pre-export checks

QuikBolus runs these before allowing export. Failures show in-context with
3D highlights.

| Check | Failure action |
|---|---|
| Cavity volume vs design-bolus volume | Warn if >5% mismatch |
| Wall thickness everywhere ≥ minimum (from §4.4) | **Block export**; show problem regions |
| Undercuts from chosen parting plane | Warn + highlight in 3D preview |
| Sprue at lowest pour-orientation point | Warn if not |
| ≥1 vent at highest pour-orientation point | Warn if not |
| Total mold print volume vs target printer build volume (from Part 2) | **Block export** if doesn't fit; suggest split or larger printer |
| Estimated Flexibolus cost | Display (operator may adjust cavity offset) |

### 4.13 Output formats

| Variable | Choices |
|---|---|
| Per-half output | **Two STL files** (default) · Single STL with halves pre-positioned · 3MF with both halves as separate objects |
| Embedded print profile | None · **Bambu Studio** · Orcaslicer · Prusaslicer · Cura |
| Generated instructions PDF | **Per-case operator instruction sheet** with patient ID, casting parameters, expected timing |
| Patient record entry | Auto-log the mold design + cast parameters to the patient's QuikBolus case |

---

## 5. Part 2 — Per-printer profile system

A **Target Printer** dropdown in QuikBolus drives recommended settings shown
in the UI and (optionally) baked into a 3MF export. Applies to both
direct-print bolus and mold-print outputs.

### 5.1 Printers supported

Top of the clinical 3D-printing market. Other printers fall back to "Generic /
Custom" with universal recommendations.

| Vendor | Models |
|---|---|
| **Bambu Lab** | P1S, P1P, X1-Carbon, X1E, A1, A1 mini, H2D |
| **Prusa Research** | MK4 / MK4S, MK3S+, XL (multi-tool), Mini+ |
| **Raise3D** | Pro3, Pro2, E2 |
| **Ultimaker** | S3, S5, S7 |
| **Markforged** | Mark Two |
| Generic / Custom | Universal recipe + manual override |

### 5.2 Per-printer settings displayed in UI

When operator picks a printer, the recommended-settings panel renders:

```
TARGET PRINTER: Bambu Lab P1S
─────────────────────────────────────────────────
Material:                TPU 95A
Print bed:               Textured PEI
AMS:                     BYPASS — external spool
Nozzle:                  0.4 mm hardened steel
Build volume fit:        ✓ (235×235×235; bolus 145×210×8)

Profile settings:
  Layer height           0.20 mm
  Wall loops             3
  Top/bottom shells      4
  Infill                 100% rectilinear
  Nozzle temp            240 °C
  Bed temp               55 °C
  Outer wall speed       25 mm/s
  ...

Supports:
  Type                   Tree (organic)
  Z gap                  0.25 mm
  Threshold angle        30°

Estimated print:
  Time                   ~6 h 40 min
  Filament use           62 g (~$2.50)

[ Download .3mf with profile baked ]
[ Download STL only ]
[ Open in Bambu Studio (if installed) ]
```

### 5.3 Settings universal vs printer-specific

| Universal (material + clinical) | Printer-specific |
|---|---|
| Material choice (TPU 95A) | Nozzle temperature (±5°C between brands) |
| Infill % (100% for clinical) | Bed temperature (depends on plate surface) |
| Wall / shell counts | Print-speed ceiling (printer motion stiffness) |
| Z-gap for supports | Pressure / linear advance (printer firmware) |
| Brim size | Retraction tuning (direct-drive vs Bowden) |
| Patient-contact orientation | Build volume / fit check |
| Layer height | AMS / MMU warning (Bambu / Prusa multi-material) |

### 5.4 Bambu Lab — P1S / P1P / X1-Carbon / X1E

TPU settings are common across the P1 / X1 series. Only enclosure status
differs (P1P is open — fine for TPU but watch for drafts).

| Setting | P1S | P1P | X1C | X1E |
|---|---|---|---|---|
| Enclosure | Yes | No (open) | Yes (clear) | Yes (enterprise) |
| Bed | Textured PEI | Textured PEI | Textured PEI / Smooth | Textured PEI |
| AMS | Yes (BYPASS for TPU) | Optional | Yes (BYPASS) | Yes (BYPASS) |
| Nozzle temp (TPU 95A) | 240 °C | 240 °C | 240 °C | 240 °C |
| Bed temp | 55 °C | 55 °C | 55 °C | 55 °C |
| Recommended speed | 25-50 mm/s | 25-50 | 25-50 | 25-50 |
| Build volume | 256³ | 256³ | 256³ | 256³ |

### 5.5 Bambu Lab — A1 / A1 mini

| Setting | A1 | A1 mini |
|---|---|---|
| Enclosure | None (open bed-slinger) | None |
| Build volume | 256×256×256 | 180×180×180 |
| TPU support | Officially supported; speeds lower than P1/X1 | Same |
| Nozzle temp | 235-240 °C | 235-240 °C |
| Bed temp | 55 °C | 55 °C |
| Recommended speed | 20-40 mm/s | 20-40 mm/s |
| Notes | Lower acceleration than P1 (bed-slinger vibration) | Mini volume limits to small H&N patches only |

### 5.6 Prusa — MK4 / MK4S / MK3S+

| Setting | MK4 / MK4S | MK3S+ |
|---|---|---|
| Extruder | Direct drive (Nextruder) | Direct drive (E3D) |
| Build volume | 250×210×220 | 250×210×210 |
| Bed | Textured / smooth steel sheet | Same |
| TPU profile | PrusaSlicer "Generic Flex 98A" — adjust for your TPU | Same |
| Nozzle temp | 230-235 °C (slightly cooler than Bambu — different extruder) | 230-235 °C |
| Bed temp | 50-55 °C | 50-55 °C |
| Recommended speed | 25-45 mm/s | 25-40 mm/s |
| Linear advance | 0.04-0.05 | 0.04-0.05 |
| MMU3 / MMU2S | BYPASS for TPU | Same |

### 5.7 Raise3D — Pro3 / Pro2

| Setting | Pro3 / Pro2 |
|---|---|
| Extruder | Dual direct drive |
| Build volume | 300×300×300 (single head; dual mode reduces) |
| Bed | BuildTak / glass options |
| Notes | Industrial-grade; heavier, slower; very reliable for large prints |
| Nozzle temp | 230-240 °C |
| Bed temp | 55-60 °C |
| Recommended speed | 30-50 mm/s |
| Enclosure | Full (good for thermal stability on big prints) |
| TPU profile | ideaMaker flex profiles; large build volume = ideal for full chest-wall bolus |

### 5.8 Ultimaker — S3 / S5 / S7

| Setting | S3 / S5 / S7 |
|---|---|
| Extruder | Print Core (swappable); AA0.4 / BB0.4 for TPU |
| Build volume | S3: 230×190×200 · S5: 330×240×300 · S7: 330×240×300 |
| Bed | Glass with adhesive (PrintCore-specific) |
| Nozzle temp | 225-235 °C |
| Bed temp | 60-70 °C (higher than Bambu/Prusa due to glass) |
| Recommended speed | 25-40 mm/s |
| Cura profile | "Ultimaker TPU 95A" — adjust infill to 100% |
| BB extruder for PVA supports | Useful for mold workflow (PVA washes away clean) |

### 5.9 Markforged — Mark Two

| Setting | Mark Two |
|---|---|
| Build volume | 320×132×154 |
| TPU support | Limited — Markforged ships Onyx (nylon + CF) primarily |
| Use case | Better for the RIGID MOLD half of the mold-and-cast workflow (Onyx mold is very durable for production), not for the bolus itself |
| Recommendation | Pair with separate TPU/Flexibolus workflow |

### 5.10 Generic / Custom

For everything else, expose the universal recipe and let the operator dial it
in.

| Setting | Recommended starting point |
|---|---|
| Material | TPU 95A |
| Layer height | 0.20 mm |
| Wall loops | 3 |
| Top/bottom shells | 4 |
| Infill | 100% rectilinear |
| Nozzle temp | 235 °C (tune ±5°C) |
| Bed temp | 55 °C (tune for plate) |
| Speed | 30 mm/s outer wall, 50 mm/s infill |
| Retraction | 0.5 mm @ 30 mm/s |
| Extruder | Direct-drive strongly preferred (Bowden + TPU is painful) |
| Enclosure | Optional for TPU |
| Build volume | Must fit bolus — QuikBolus fit-checks before export |

---

## 6. UX flow

### 6.1 Direct-print workflow (existing + profile system addition)

1. Operator generates bolus from DICOM (as today)
2. Operator picks **Output mode: Direct print** (new dropdown)
3. Operator picks **Target printer** from list (new dropdown)
4. QuikBolus shows the recommended-settings panel from §5.2
5. Build-volume fit check runs; warns if bolus doesn't fit
6. Operator clicks **Download .3mf** (with profile) or **Download STL** or
   **Open in slicer** (if installed)
7. Patient-record entry auto-logged with chosen printer + settings

### 6.2 Mold workflow (new)

1. Operator generates bolus from DICOM (as today)
2. Operator picks **Output mode: Mold for casting**
3. Operator picks **Casting material** (§4.1) — drives downstream defaults
4. **Mold-design view** opens with live 3D preview (Three.js or similar)
5. Operator iterates through parting plane (§4.3), geometry (§4.4), pour
   features (§4.5), registration (§4.6) — each change updates the 3D preview
6. Validation panel (§4.12) shows running warnings + blocks
7. Operator picks **Target printer** (§5) for the mold
8. Operator clicks **Export molds** — produces:
   - Two STLs (one per half) OR 3MF with both halves
   - Per-case PDF instruction sheet (§4.11)
   - Patient-record entry
9. Operator prints the molds, pours Flexibolus per the instruction sheet,
   demolds, applies to patient

### 6.3 Both modes

Operator can pick **Output mode: Both** and export everything — useful when
they want options or when the planner hasn't decided yet.

---

## 7. Open design questions

These deserve discussion before scoping the work.

| # | Question | My current lean |
|---|---|---|
| 1 | Auto-detect best parting plane, or manual only? | **Manual with "Auto-suggest" button.** Auto-only is appealing but algorithms that minimize undercut count can choose planes that are hard to print or demold. Operator always confirms. |
| 2 | Should the per-printer 3MF profiles be live (bake actual slicer settings into the .3mf) or text-only (recommendations on screen + plain STL)? | **Both.** Live for top 3 printers (Bambu P1S, X1C, Prusa MK4) because that's where the convenience pays off. Text-only for the long tail because slicer-format changes break baked profiles. |
| 3 | Live 3D preview in the browser — Three.js or a heavier engine? | **Three.js.** Three.js handles boolean previews, mesh visualization, and interactive sliders comfortably. STL parsing libraries exist. Heavier engines (Babylon, model-viewer) are overkill. |
| 4 | Mold geometry computation in browser or server-side? | **Server-side.** Boolean subtract on real anatomical meshes is heavy; do it in Python with `trimesh` or `pymeshlab` and return STL/mesh to the browser. Browser shows the preview, server does the math. |
| 5 | Embedded patient identifiers in the mold — opt-in or default-off? | **Default-off.** PHI concerns. Operator must explicitly choose to embed any identifier, and the field shows what will go in. |
| 6 | Cast volume + cost estimate — show in mL only, or convert to vendor SKUs (Flexibolus 50 grams = X dollars)? | **mL + grams only for v1.** SKU pricing changes; let the operator do the math. v2 could add a cost-lookup table maintained by the clinic. |
| 7 | Should QuikBolus handle slicing internally, or always export to external slicer? | **Always external.** Slicing is a vast, fast-moving space (PrusaSlicer / Bambu Studio / Orca / Cura). QuikBolus stays focused on the geometry generation; slicing is someone else's job. The 3MF profile bake is the integration point. |

---

## 8. Implementation phasing

Suggested release sequence. Each phase ships independently.

### Phase 2.1 — Printer profile system (direct-print)
- Target Printer dropdown
- Recommended-settings panel
- Build-volume fit check
- Profile JSON per printer (text-only first)
- STL export with companion text file of recommended settings

Effort: **~1-2 weeks** focused work. No new geometry math; just UI + data tables.

### Phase 2.2 — 3MF profile bake for top printers
- 3MF writer that bundles STL + Bambu / Orca / Prusa preset
- 3 printer profiles initially (Bambu P1S, X1C, Prusa MK4)
- "Open in slicer" button (best-effort cross-platform)

Effort: **~1 week** on top of 2.1.

### Phase 2.3 — Mold workflow (basic)
- New Output Mode dropdown
- Mold-design view with parting-plane slider
- Live 3D preview (Three.js) of mold halves
- Pour spout + auto-placed vents
- Two-STL export
- Operator instruction sheet PDF

Effort: **~3-4 weeks** focused work. Geometry math + UI + preview.

### Phase 2.4 — Mold workflow (advanced)
- Registration features (pegs, dovetails)
- Identification embossing
- Validation panel with all §4.12 checks
- 3MF mold export with embedded rigid-print profile

Effort: **~2 weeks** on top of 2.3.

### Phase 2.5 — Profile system expansion
- Profiles for remaining printers (§5.4–5.10)
- "Both" output mode
- Per-clinic profile override (admin-editable defaults)

Effort: **~1 week** for the printer profiles; admin editing is more.

### Total spec effort estimate
**~8-10 focused weeks** for full v2 across all phases. Earliest valuable
ship is 2.1 (~2 weeks) — the per-printer settings panel alone removes the
most common operator confusion.

---

## 9. Dependencies & risks

| Risk | Mitigation |
|---|---|
| Bambu / Prusa change 3MF profile format | Bake formats are stable; pin tested versions; ship updates as needed |
| Boolean mesh operations on patient anatomy can produce non-manifold output | Use `pymeshlab` for boolean (more robust than `trimesh`); always run `is_watertight()` check post-op |
| Three.js performance on large meshes (chest-wall bolus = high triangle count) | Decimate mesh for preview only; keep full-resolution STL for export |
| Operator confusion between "trim base plate" workflow and "mold workflow" | Separate them in the UI; never combine in the same flow |
| Flexibolus formula or part numbers change | Cast-process info in §4.11 stays generic ("per Flexibolus product spec"); operator follows vendor doc |
| Embedded printer profiles get stale as slicer versions advance | Version each profile against a tested slicer release; show "Last tested: Bambu Studio 1.9" in UI |
| Operator picks wrong cast material in §4.1 by accident | All downstream defaults are *defaults*, not locks — operator can override |

---

## 10. Out-of-scope items worth tracking

- **Direct LAN printing** (QuikBolus → Bambu MQTT → printer): separate spec
- **Auto-orient bolus to anatomy** from DICOM landmarks: separate spec
- **Sterilization / disinfection guidance** beyond "no autoclave": belongs in the
  operator print guide, not in QuikBolus itself
- **HDR cap bolus templates** (parametric library): separate Phase 3 spec
- **Tissue compensator / wedge generation**: distinct enough from bolus to be
  its own product, not a QuikBolus extension

---

## Appendix A — Material reference

| Material | Density (g/cc) | CT number (HU) | Use for |
|---|---|---|---|
| Water (reference) | 1.000 | 0 | TPS assumption |
| TPU 95A (100% infill) | 1.21 | ~+75 | Direct-print bolus |
| TPU 95A (90% gyroid) | ~1.09 | ~+45 | Direct-print bolus, density-matched (within TG-176) |
| TPU 85A | 1.13 | ~+60 | Softer direct-print bolus |
| PETG | 1.27 | ~+90 | Rigid mold |
| PLA | 1.24 | ~+85 | Rigid mold (low-cost) |
| ABS | 1.04 | ~+30 | Hot-pour silicone mold |
| Flexibolus (cast) | ~1.00 | ~0 | Cast bolus — water-equivalent by design |
| Smooth-On Ecoflex 30 | ~1.07 | ~+35 | Cast bolus (silicone) |
| Onyx (nylon + CF, Markforged) | 1.20 | ~+70 | Highly durable mold (production) |

(HU values are typical; verify on your CT.)

---

## Appendix B — Printer comparison matrix (quick reference)

| Printer | Build vol (mm) | Enclosure | TPU friendly | Best fit |
|---|---|---|---|---|
| Bambu P1S | 256³ | Yes | ✓✓✓ | Default direct-print TPU |
| Bambu P1P | 256³ | No | ✓✓ | Direct-print TPU (drafts OK) |
| Bambu X1C | 256³ | Yes | ✓✓✓ | Direct-print TPU + AMS for rigid molds |
| Bambu A1 | 256³ | No | ✓✓ | Smaller clinic budget |
| Bambu A1 mini | 180³ | No | ✓ | Small H&N patches only |
| Prusa MK4 | 250×210×220 | No | ✓✓✓ | Direct-print TPU (proven workhorse) |
| Prusa XL | 360×360×360 | No | ✓✓ | Large chest-wall (single tool); multi-tool variant for PVA supports |
| Raise3D Pro3 | 300³ | Yes | ✓✓ | Industrial production environments |
| Ultimaker S5 | 330×240×300 | Yes | ✓✓ | PVA supports via BB extruder = great for molds |
| Markforged Mark Two | 320×132×154 | Yes | (Onyx) | Production-grade rigid molds, not TPU |

---

## Document control

| Version | Date | Author | Change |
|---|---|---|---|
| 0.1 | 2026-05-24 | Radiant MPC / Claude | Initial draft from design conversation |

**Next step:** review with QuikBolus owner, choose phases to commit to a
release window, scope effort per phase, then turn this spec into engineering
tasks. Until then this lives in `design-docs/` and is excluded from the
public site via `.assetsignore`.
