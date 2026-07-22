////////////////////////////////////////////////////////////////////////////////
//  Radiant Treatment Summary
//  A one-click ESAPI binary plugin for Varian Eclipse v15.6
//
//  Reads the active external-beam plan and produces a printable
//  treatment-summary / prescription document (self-contained HTML that
//  the physicist can review on screen and print to PDF via Ctrl+P).
//
//  This is a READ-ONLY plugin. It never modifies the patient database.
//
//  © Radiant Medical Physics Consulting LLC.  Provided as-is; validate
//  against your own commissioning and QA program before clinical use.
////////////////////////////////////////////////////////////////////////////////

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows;                       // MessageBox
using VMS.TPS.Common.Model.API;
using VMS.TPS.Common.Model.Types;

namespace VMS.TPS
{
    public class Script
    {
        // ---- Clinic-tunable options ------------------------------------------
        // Set true to blank the patient name / ID / DOB in the report (e.g. for
        // teaching files or screenshots). The MRN is still used to name the file.
        private const bool Anonymize = false;

        // Where the report is written. Falls back to %TEMP% if unwritable.
        private static readonly string OutputFolder =
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);

        // Target coverage metrics reported for every PTV (relative volume %).
        // D95 / D98 = dose to 95 % / 98 % of the volume; D2 = near-max.
        private static readonly double[] TargetCoverageVolumes = { 98, 95, 50, 2 };

        // Organs-at-risk table. Add rows for your standard reporting set; the
        // plugin silently skips any structure that is not present or is empty.
        // Metric kinds: Max, Mean, DoseAtVolume (Dx cc / x%), VolumeAtDose (Vx).
        private static readonly OarMetric[] OarMetrics =
        {
            new OarMetric("SpinalCord",   MetricKind.Max),
            new OarMetric("Cord",         MetricKind.Max),
            new OarMetric("BrainStem",    MetricKind.Max),
            new OarMetric("Parotid_L",    MetricKind.Mean),
            new OarMetric("Parotid_R",    MetricKind.Mean),
            new OarMetric("Lung_L",       MetricKind.Mean),
            new OarMetric("Lung_R",       MetricKind.Mean),
            new OarMetric("Lungs",        MetricKind.VolumeAtDose, 20.0), // V20 (Gy)
            new OarMetric("Heart",        MetricKind.Mean),
            new OarMetric("Rectum",       MetricKind.VolumeAtDose, 70.0), // V70 (Gy)
            new OarMetric("Bladder",      MetricKind.VolumeAtDose, 65.0), // V65 (Gy)
        };
        // ----------------------------------------------------------------------

        public void Execute(ScriptContext context)
        {
            if (context == null || context.Patient == null)
            {
                Show("No patient is open. Open a patient and an approved plan, then run again.");
                return;
            }

            PlanSetup plan = context.PlanSetup;
            if (plan == null)
            {
                Show("No active plan. Open (or set as active) an external-beam plan and run again.");
                return;
            }

            string html;
            try
            {
                html = BuildReport(context, plan);
            }
            catch (Exception ex)
            {
                Show("Could not build the treatment summary:\n\n" + ex.Message);
                return;
            }

            WriteAndOpen(context, plan, html);
        }

        // ---------------------------------------------------------------------
        //  Report construction
        // ---------------------------------------------------------------------
        private string BuildReport(ScriptContext context, PlanSetup plan)
        {
            Patient p = context.Patient;
            var sb = new StringBuilder();

            string patientName = Anonymize ? "— (anonymized)" : FormatName(p);
            string patientId   = Anonymize ? "—" : p.Id;
            string dob         = Anonymize || p.DateOfBirth == null
                                 ? "—" : p.DateOfBirth.Value.ToString("yyyy-MM-dd");
            string user        = context.CurrentUser != null ? context.CurrentUser.Name : "—";

            sb.Append(HtmlHead());
            sb.Append("<div class='sheet'>");

            // Header / banner
            sb.Append("<header><div class='mark'>◐ Radiant.</div>")
              .Append("<div class='doctitle'>Treatment Summary &amp; Prescription</div>")
              .Append("<div class='stamp'>Generated ")
              .Append(Esc(DateTime.Now.ToString("yyyy-MM-dd HH:mm")))
              .Append(" &middot; ").Append(Esc(user)).Append("</div></header>");

            sb.Append("<p class='disclaimer'>Read-only summary generated from the Eclipse plan of record. "
                    + "Verify against the signed prescription before use. Not a substitute for chart review.</p>");

            // --- Patient / plan identity ---
            sb.Append(SectionOpen("Patient &amp; Plan"));
            sb.Append(KvTable(new[]
            {
                Kv("Patient", patientName),
                Kv("MRN", patientId),
                Kv("Date of birth", dob),
                Kv("Sex", Safe(() => p.Sex)),
                Kv("Course", Safe(() => plan.Course != null ? plan.Course.Id : "—")),
                Kv("Plan ID", plan.Id),
                Kv("Plan name", Safe(() => plan.Name)),
                Kv("Status", Safe(() => plan.ApprovalStatus.ToString())),
                Kv("Image / CT", Safe(() => plan.StructureSet != null && plan.StructureSet.Image != null
                                            ? plan.StructureSet.Image.Id : "—")),
            }));
            sb.Append(SectionClose());

            // --- Prescription ---
            sb.Append(SectionOpen("Prescription"));
            sb.Append(BuildPrescriptionBlock(plan));
            sb.Append(SectionClose());

            // --- Fields / delivery ---
            sb.Append(SectionOpen("Fields &amp; Delivery"));
            sb.Append(BuildFieldsTable(plan));
            sb.Append(SectionClose());

            // --- Target coverage ---
            sb.Append(SectionOpen("Target Coverage"));
            sb.Append(BuildTargetTable(plan));
            sb.Append(SectionClose());

            // --- OAR doses ---
            sb.Append(SectionOpen("Organ-at-Risk Doses"));
            sb.Append(BuildOarTable(plan));
            sb.Append(SectionClose());

            // --- Sign-off ---
            sb.Append(SectionOpen("Review &amp; Sign-off"));
            sb.Append("<table class='signoff'>"
                    + "<tr><td>Prepared by</td><td class='line'></td><td>Date</td><td class='line'></td></tr>"
                    + "<tr><td>Physics review</td><td class='line'></td><td>Date</td><td class='line'></td></tr>"
                    + "<tr><td>MD approval</td><td class='line'></td><td>Date</td><td class='line'></td></tr>"
                    + "</table>");
            sb.Append(SectionClose());

            sb.Append("<footer>Radiant Treatment Summary &middot; read-only ESAPI plugin &middot; "
                    + "not a legal document &middot; verify all values against Eclipse.</footer>");
            sb.Append("</div>"); // .sheet
            sb.Append("</body></html>");
            return sb.ToString();
        }

        private string BuildPrescriptionBlock(PlanSetup plan)
        {
            var rows = new List<string>();

            // Plan-level fractionation (always available on a planned course).
            string totalDose  = Safe(() => Fmt(plan.TotalDose));
            string perFx      = Safe(() => Fmt(plan.DosePerFraction));
            string nFx         = Safe(() => plan.NumberOfFractions.HasValue
                                           ? plan.NumberOfFractions.Value.ToString() : "—");
            string norm       = Safe(() => string.Format("{0:0.#} %", plan.PlanNormalizationValue));
            string normMethod = Safe(() => plan.PlanNormalizationMethod);
            string target     = Safe(() => string.IsNullOrEmpty(plan.TargetVolumeID) ? "—" : plan.TargetVolumeID);

            rows.Add(Kv("Planned dose", totalDose));
            rows.Add(Kv("Dose / fraction", perFx));
            rows.Add(Kv("Fractions", nFx));
            rows.Add(Kv("Plan target", target));
            rows.Add(Kv("Normalization", norm));
            rows.Add(Kv("Norm. method", normMethod));

            var sb = new StringBuilder();
            sb.Append(KvTable(rows.ToArray()));

            // The formal RTPrescription (physician order) if one is linked.
            try
            {
                var rx = plan.RTPrescription;
                if (rx != null)
                {
                    sb.Append("<div class='subhead'>Linked prescription (physician order)</div>");
                    var meta = new List<string>
                    {
                        Kv("Rx name", Safe(() => rx.Name)),
                        Kv("Status", Safe(() => rx.Status)),
                        Kv("Site", Safe(() => rx.Site)),
                    };
                    sb.Append(KvTable(meta.ToArray()));

                    var targets = rx.Targets;
                    if (targets != null && targets.Any())
                    {
                        sb.Append("<table class='grid'><thead><tr>"
                                + "<th>Target</th><th>Dose/Fx</th><th>Fractions</th><th>Total</th>"
                                + "</tr></thead><tbody>");
                        foreach (var t in targets)
                        {
                            sb.Append("<tr>")
                              .Append(Td(Safe(() => t.TargetId)))
                              .Append(Td(Safe(() => Fmt(t.DosePerFraction))))
                              .Append(Td(Safe(() => t.NumberOfFractions.ToString())))
                              .Append(Td(Safe(() => Fmt(new DoseValue(
                                    t.DosePerFraction.Dose * t.NumberOfFractions,
                                    t.DosePerFraction.Unit)))))
                              .Append("</tr>");
                        }
                        sb.Append("</tbody></table>");
                    }
                    if (!string.IsNullOrWhiteSpace(Safe(() => rx.Notes)))
                        sb.Append("<p class='note'>Note: ").Append(Esc(rx.Notes)).Append("</p>");
                }
            }
            catch
            {
                // RTPrescription is not exposed on every configuration/version — ignore.
            }

            return sb.ToString();
        }

        private string BuildFieldsTable(PlanSetup plan)
        {
            var beams = Safe(() => plan.Beams, Enumerable.Empty<Beam>())
                        .Where(b => !b.IsSetupField)
                        .OrderBy(b => b.Id)
                        .ToList();

            if (beams.Count == 0)
                return "<p class='empty'>No treatment fields found.</p>";

            string machine = Safe(() =>
            {
                var m = beams.Select(b => b.TreatmentUnit != null ? b.TreatmentUnit.Id : null)
                             .Where(x => x != null).Distinct().ToList();
                return m.Count > 0 ? string.Join(", ", m) : "—";
            });

            double totalMu = 0;
            var sb = new StringBuilder();
            sb.Append("<table class='grid'><thead><tr>"
                    + "<th>Field</th><th>Technique</th><th>Energy</th><th>MU</th>"
                    + "<th>Gantry</th><th>Coll</th><th>Couch</th><th>MLC</th>"
                    + "</tr></thead><tbody>");

            foreach (var b in beams)
            {
                double mu = 0;
                try { mu = b.Meterset.Value; totalMu += mu; } catch { }

                sb.Append("<tr>")
                  .Append(Td(Safe(() => b.Id)))
                  .Append(Td(Safe(() => TechniqueName(b))))
                  .Append(Td(Safe(() => b.EnergyModeDisplayName)))
                  .Append(Td(mu > 0 ? mu.ToString("0.0") : "—"))
                  .Append(Td(Safe(() => GantryText(b))))
                  .Append(Td(Safe(() => AngleText(b.ControlPoints.First().CollimatorAngle))))
                  .Append(Td(Safe(() => AngleText(b.ControlPoints.First().PatientSupportAngle))))
                  .Append(Td(Safe(() => b.MLCPlanType.ToString())))
                  .Append("</tr>");
            }
            sb.Append("</tbody><tfoot><tr><td colspan='3'>Total MU</td>"
                    + "<td colspan='5'>" + Esc(totalMu.ToString("0.0")) + "</td></tr></tfoot></table>");

            sb.Append("<p class='meta'>Treatment unit: ").Append(Esc(machine)).Append("</p>");
            return sb.ToString();
        }

        private string BuildTargetTable(PlanSetup plan)
        {
            if (!DoseReady(plan))
                return "<p class='empty'>No calculated dose on this plan — coverage metrics unavailable.</p>";

            var ss = plan.StructureSet;
            var targets = ss.Structures
                            .Where(s => !s.IsEmpty && IsTarget(s))
                            .OrderByDescending(s => s.Volume)
                            .ToList();

            if (targets.Count == 0)
                return "<p class='empty'>No target structures (PTV/CTV/GTV) found in the structure set.</p>";

            var sb = new StringBuilder();
            sb.Append("<table class='grid'><thead><tr><th>Target</th><th>Type</th><th>Volume (cc)</th>");
            foreach (var v in TargetCoverageVolumes)
                sb.Append("<th>D").Append(Esc(Trim(v))).Append("%</th>");
            sb.Append("</tr></thead><tbody>");

            foreach (var t in targets)
            {
                sb.Append("<tr>")
                  .Append(Td(t.Id))
                  .Append(Td(t.DicomType))
                  .Append(Td(t.Volume.ToString("0.0")));
                foreach (var v in TargetCoverageVolumes)
                {
                    string d = Safe(() =>
                    {
                        var dv = plan.GetDoseAtVolume(t, v, VolumePresentation.Relative,
                                                      DoseValuePresentation.Absolute);
                        return Fmt(dv);
                    });
                    sb.Append(Td(d));
                }
                sb.Append("</tr>");
            }
            sb.Append("</tbody></table>");
            sb.Append("<p class='meta'>Dx% = dose to x% of the target volume (D95/D98 = coverage, D2 = near-max).</p>");
            return sb.ToString();
        }

        private string BuildOarTable(PlanSetup plan)
        {
            if (!DoseReady(plan))
                return "<p class='empty'>No calculated dose on this plan — OAR metrics unavailable.</p>";

            var ss = plan.StructureSet;
            var sb = new StringBuilder();
            var rows = new List<string>();

            foreach (var m in OarMetrics)
            {
                var s = ss.Structures.FirstOrDefault(
                    x => string.Equals(x.Id, m.StructureId, StringComparison.OrdinalIgnoreCase));
                if (s == null || s.IsEmpty) continue;

                string label, value;
                if (!EvaluateMetric(plan, s, m, out label, out value)) continue;

                rows.Add("<tr>" + Td(s.Id) + Td(label) + Td(value) + "</tr>");
            }

            if (rows.Count == 0)
                return "<p class='empty'>None of the configured OAR structures were present with dose. "
                     + "Edit <code>OarMetrics</code> in the plugin to match your naming.</p>";

            sb.Append("<table class='grid'><thead><tr><th>Structure</th><th>Metric</th><th>Value</th></tr></thead><tbody>");
            foreach (var r in rows) sb.Append(r);
            sb.Append("</tbody></table>");
            return sb.ToString();
        }

        private bool EvaluateMetric(PlanSetup plan, Structure s, OarMetric m,
                                    out string label, out string value)
        {
            label = ""; value = "";
            try
            {
                switch (m.Kind)
                {
                    case MetricKind.Max:
                        label = "Max (D0.03cc approx / Dmax)";
                        value = Fmt(plan.GetDoseAtVolume(s, 0.0, VolumePresentation.Relative,
                                                         DoseValuePresentation.Absolute));
                        return true;

                    case MetricKind.Mean:
                        label = "Mean";
                        var dvh = plan.GetDVHCumulativeData(s, DoseValuePresentation.Absolute,
                                                            VolumePresentation.Relative, 0.1);
                        if (dvh == null) return false;
                        value = Fmt(dvh.MeanDose);
                        return true;

                    case MetricKind.VolumeAtDose:
                        label = "V" + Trim(m.Parameter) + " (Gy)";
                        var dose = new DoseValue(m.Parameter, DoseValue.DoseUnit.Gy);
                        double vol = plan.GetVolumeAtDose(s, dose, VolumePresentation.Relative);
                        value = double.IsNaN(vol) ? "—" : vol.ToString("0.0") + " %";
                        return true;

                    case MetricKind.DoseAtVolume:
                        label = "D" + Trim(m.Parameter) + "%";
                        value = Fmt(plan.GetDoseAtVolume(s, m.Parameter, VolumePresentation.Relative,
                                                         DoseValuePresentation.Absolute));
                        return true;
                }
            }
            catch { return false; }
            return false;
        }

        // ---------------------------------------------------------------------
        //  Output
        // ---------------------------------------------------------------------
        private void WriteAndOpen(ScriptContext context, PlanSetup plan, string html)
        {
            string idPart = Anonymize ? "anon" : Sanitize(context.Patient.Id);
            string file = string.Format("TreatmentSummary_{0}_{1}_{2}.html",
                idPart, Sanitize(plan.Id), DateTime.Now.ToString("yyyyMMdd_HHmmss"));

            string path = TryWrite(OutputFolder, file, html)
                       ?? TryWrite(Path.GetTempPath(), file, html);

            if (path == null)
            {
                Show("The report was built but could not be written to disk (check folder permissions).");
                return;
            }

            try { Process.Start(new ProcessStartInfo(path) { UseShellExecute = true }); }
            catch { /* file is on disk even if the browser fails to launch */ }

            Show("Treatment summary created:\n\n" + path +
                 "\n\nIt opened in your browser — use Ctrl+P → Save as PDF to file it.");
        }

        private static string TryWrite(string folder, string file, string html)
        {
            try
            {
                if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return null;
                string path = Path.Combine(folder, file);
                File.WriteAllText(path, html, Encoding.UTF8);
                return path;
            }
            catch { return null; }
        }

        // ---------------------------------------------------------------------
        //  ESAPI helpers
        // ---------------------------------------------------------------------
        private static bool DoseReady(PlanSetup plan)
        {
            try { return plan.IsDoseValid && plan.Dose != null && plan.StructureSet != null; }
            catch { return false; }
        }

        private static bool IsTarget(Structure s)
        {
            string t = (s.DicomType ?? "").ToUpperInvariant();
            return t == "PTV" || t == "CTV" || t == "GTV";
        }

        private static string TechniqueName(Beam b)
        {
            switch (b.MLCPlanType)
            {
                case MLCPlanType.VMAT:        return "VMAT";
                case MLCPlanType.DoseDynamic: return "IMRT (dyn)";
                case MLCPlanType.ArcDynamic:  return "Conformal Arc";
                case MLCPlanType.Static:      return b.ControlPoints.Count > 1 ? "Field-in-Field" : "3D / Static";
                default:                      return b.MLCPlanType.ToString();
            }
        }

        private static string GantryText(Beam b)
        {
            var cps = b.ControlPoints;
            double start = cps.First().GantryAngle;
            if (b.MLCPlanType == MLCPlanType.VMAT || b.MLCPlanType == MLCPlanType.ArcDynamic)
            {
                double stop = cps.Last().GantryAngle;
                string dir = b.GantryDirection == GantryDirection.Clockwise ? "CW"
                           : b.GantryDirection == GantryDirection.CounterClockwise ? "CCW" : "";
                return string.Format("{0:0.#}→{1:0.#}° {2}", start, stop, dir).Trim();
            }
            return AngleText(start);
        }

        private static string AngleText(double deg)
        {
            return deg.ToString("0.#") + "°";
        }

        private static string FormatName(Patient p)
        {
            try
            {
                string last = p.LastName ?? "";
                string first = p.FirstName ?? "";
                string joined = (last + ", " + first).Trim(',', ' ');
                return string.IsNullOrEmpty(joined) ? (p.Name ?? "—") : joined;
            }
            catch { return "—"; }
        }

        private static string Fmt(DoseValue dv)
        {
            if (dv.Dose < 0 || double.IsNaN(dv.Dose)) return "—";
            return dv.Dose.ToString("0.##") + " " + dv.UnitAsString;
        }

        // ---------------------------------------------------------------------
        //  Small utilities
        // ---------------------------------------------------------------------
        private static string Safe(Func<string> f)
        {
            try { string s = f(); return string.IsNullOrEmpty(s) ? "—" : s; }
            catch { return "—"; }
        }

        private static T Safe<T>(Func<T> f, T fallback)
        {
            try { return f(); }
            catch { return fallback; }
        }

        private static string Trim(double v)
        {
            return v.ToString("0.###");
        }

        private static string Sanitize(string s)
        {
            if (string.IsNullOrEmpty(s)) return "unknown";
            foreach (char c in Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            return s.Replace(' ', '_');
        }

        private static void Show(string msg)
        {
            MessageBox.Show(msg, "Radiant Treatment Summary",
                            MessageBoxButton.OK, MessageBoxImage.Information);
        }

        // ---- HTML builders ---------------------------------------------------
        private static string Esc(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            return s.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;")
                    .Replace("\"", "&quot;");
        }

        private static string Kv(string k, string v)
        {
            return "<tr><th>" + Esc(k) + "</th><td>" + Esc(v) + "</td></tr>";
        }

        private static string KvTable(string[] rows)
        {
            return "<table class='kv'>" + string.Concat(rows) + "</table>";
        }

        private static string Td(string s) { return "<td>" + Esc(s) + "</td>"; }

        private static string SectionOpen(string title)
        {
            return "<section><h2>" + title + "</h2>";
        }

        private static string SectionClose() { return "</section>"; }

        private static string HtmlHead()
        {
            // Self-contained styling that mirrors the Varian Portal Dosimetry /
            // Eclipse clinical UI: dark charcoal panels, light text, Varian blue
            // accent. A print override drops to a clean white sheet so the PDF
            // stays legible and toner-friendly.
            return
"<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>" +
"<title>Radiant Treatment Summary</title><style>" +
// ---- Varian Portal Dosimetry palette ----
":root{--bg:#1e1e1e;--panel:#252526;--panel2:#2d2d30;--ink:#e6e6e6;" +
"--muted:#9d9d9d;--line:#3f3f46;--accent:#3a9fd4;--accent2:#2b7bb0;" +
"--head:#16466b;--headink:#dbeafe;--row:#2a2a2c;--rowalt:#242426;}" +
"*{box-sizing:border-box}" +
"body{margin:0;background:var(--bg);color:var(--ink);" +
"font:13px/1.5 'Segoe UI',Roboto,Helvetica,Arial,sans-serif;}" +
".sheet{max-width:880px;margin:0 auto;background:var(--panel);min-height:100vh;" +
"border-left:1px solid var(--line);border-right:1px solid var(--line);}" +
// title bar, like the PD workspace header
"header{display:flex;align-items:center;gap:14px;flex-wrap:wrap;" +
"background:linear-gradient(180deg,#2d2d30,#232326);" +
"border-bottom:2px solid var(--accent);padding:14px 40px;}" +
".mark{font-size:20px;font-weight:700;color:var(--accent);letter-spacing:-.3px;}" +
".doctitle{font-size:18px;font-weight:600;color:var(--ink);}" +
".stamp{margin-left:auto;color:var(--muted);font-size:11px;text-align:right;}" +
".sheet>section,.sheet>.disclaimer,.sheet>footer{margin-left:40px;margin-right:40px;}" +
".disclaimer{color:var(--muted);font-size:11px;font-style:italic;margin-top:14px;}" +
"section{margin-top:20px;}" +
"h2{font-size:12px;text-transform:uppercase;letter-spacing:.8px;color:var(--accent);" +
"border-bottom:1px solid var(--line);padding-bottom:5px;margin:0 0 10px;}" +
".subhead{font-weight:600;margin:14px 0 6px;font-size:12px;color:var(--headink);}" +
"table{border-collapse:collapse;width:100%;font-size:12.5px;}" +
".kv{width:100%;}" +
".kv th{width:170px;text-align:left;color:var(--muted);font-weight:600;" +
"padding:3px 8px 3px 0;vertical-align:top;}" +
".kv td{padding:3px 0;color:var(--ink);}" +
".grid th,.grid td{border:1px solid var(--line);padding:6px 9px;text-align:left;}" +
".grid thead th{background:var(--head);color:var(--headink);font-weight:600;}" +
".grid tbody tr:nth-child(odd){background:var(--row);}" +
".grid tbody tr:nth-child(even){background:var(--rowalt);}" +
".grid tfoot td{background:var(--panel2);font-weight:700;color:var(--accent);}" +
".signoff td{padding:16px 8px 4px;color:var(--muted);}" +
".signoff .line{border-bottom:1px solid #6b7280;width:180px;}" +
".empty,.note,.meta{color:var(--muted);font-size:11px;font-style:italic;}" +
".meta{margin-top:6px;}" +
"code{background:var(--panel2);padding:1px 4px;border-radius:3px;font-size:11px;color:var(--accent);}" +
"footer{margin-top:24px;border-top:1px solid var(--line);padding:10px 0 24px;" +
"color:var(--muted);font-size:10.5px;text-align:center;}" +
// ---- print: clean white sheet, keep accents ----
"@media print{" +
"body{background:#fff;color:#111;}" +
".sheet{background:#fff;border:none;max-width:none;margin:0;}" +
"header{background:#fff;border-bottom:2px solid var(--accent2);}" +
".doctitle{color:#111;}.kv td{color:#111;}" +
".grid thead th{background:var(--head);color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}" +
".grid tbody tr:nth-child(odd),.grid tbody tr:nth-child(even){background:#fff;}" +
".grid tfoot td{background:#f1f5f9;color:var(--accent2);}" +
".grid th,.grid td{border-color:#cbd5e1;}" +
"h2{color:var(--accent2);}.subhead{color:#111;}" +
"}" +
"</style></head><body>";
        }

        // ---- config types ----------------------------------------------------
        private enum MetricKind { Max, Mean, DoseAtVolume, VolumeAtDose }

        private class OarMetric
        {
            public string StructureId;
            public MetricKind Kind;
            public double Parameter;     // % for Dx%, Gy for Vx
            public OarMetric(string id, MetricKind kind, double parameter = 0)
            {
                StructureId = id; Kind = kind; Parameter = parameter;
            }
        }
    }
}
