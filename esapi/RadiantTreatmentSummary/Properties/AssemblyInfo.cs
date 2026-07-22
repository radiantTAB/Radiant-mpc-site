using System.Reflection;
using System.Runtime.InteropServices;
using VMS.TPS.Common.Model.API;

// Standard assembly identity for the binary plugin.
[assembly: AssemblyTitle("Radiant Treatment Summary")]
[assembly: AssemblyDescription("One-click treatment summary / prescription document for Eclipse v15.6")]
[assembly: AssemblyCompany("Radiant Medical Physics Consulting LLC")]
[assembly: AssemblyProduct("Radiant Treatment Summary")]
[assembly: AssemblyCopyright("© Radiant Medical Physics Consulting LLC")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

// Required for Eclipse v15.5+ : declare that this plugin never writes to the
// database. Approved (non-research) Eclipse only loads read-only plugins.
[assembly: ESAPIScript(IsWriteable = false)]
