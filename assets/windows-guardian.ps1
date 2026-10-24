# JSON configuration arrives through stdin, never through command-line arguments.
$ErrorActionPreference = 'Stop'
try {
  $runtimeOptions = [Console]::In.ReadLine() | ConvertFrom-Json
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
public sealed class DshMemoryJob : IDisposable {
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a,b,c,d,e,f; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC_LIMIT {
    public long a,b; public uint LimitFlags; public UIntPtr c,d; public uint e; public UIntPtr f; public uint g,h;
  }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMIT {
    public BASIC_LIMIT Basic; public IO_COUNTERS Io; public UIntPtr a,b,c,d;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int info, ref EXTENDED_LIMIT limits, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  IntPtr job; Process process; TextWriter log;
  public DshMemoryJob() {
    job = CreateJobObject(IntPtr.Zero, null);
    var limits = new EXTENDED_LIMIT(); limits.Basic.LimitFlags = 0x2000;
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits))) {
      Dispose(); throw new IOException("Cannot create Windows process job");
    }
  }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char ch in value) {
      if (ch == '\\') { slashes++; continue; }
      if (ch == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
      else { result.Append('\\', slashes); result.Append(ch); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  public int Start(string exe, string[] args, string cwd, IDictionary env, string logPath) {
    var info = new ProcessStartInfo(exe); info.WorkingDirectory = cwd;
    info.UseShellExecute = false; info.CreateNoWindow = true;
    info.RedirectStandardOutput = true; info.RedirectStandardError = true;
    info.Arguments = String.Join(" ", Array.ConvertAll(args, Quote));
    info.EnvironmentVariables.Clear();
    foreach (DictionaryEntry item in env) info.EnvironmentVariables[(string)item.Key] = (string)item.Value;
    log = TextWriter.Synchronized(new StreamWriter(new FileStream(logPath, FileMode.Append, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true });
    process = new Process(); process.StartInfo = info;
    process.OutputDataReceived += (sender, e) => { if (e.Data != null) { try { log.WriteLine(e.Data); } catch {} } };
    process.ErrorDataReceived += (sender, e) => { if (e.Data != null) { try { log.WriteLine(e.Data); } catch {} } };
    if (!process.Start()) throw new IOException("Cannot start Neo4j");
    if (!AssignProcessToJobObject(job, process.Handle)) {
      try { process.Kill(); } catch {} throw new IOException("Cannot assign Neo4j to Windows process job");
    }
    process.BeginOutputReadLine(); process.BeginErrorReadLine(); return process.Id;
  }
  public void Dispose() {
    if (job != IntPtr.Zero) { TerminateJobObject(job, 1); CloseHandle(job); job = IntPtr.Zero; }
    if (process != null) { try { process.WaitForExit(5000); } catch {} process.Dispose(); process = null; }
    if (log != null) { log.Dispose(); log = null; }
  }
}
'@
  $runtimeEnvironment = @{}
  foreach ($property in $runtimeOptions.env.PSObject.Properties) { $runtimeEnvironment[$property.Name] = [string]$property.Value }
  $runtimeJob = New-Object DshMemoryJob
  try {
    $runtimePid = $runtimeJob.Start([string]$runtimeOptions.executable, [string[]]$runtimeOptions.args, [string]$runtimeOptions.cwd, $runtimeEnvironment, [string]$runtimeOptions.log)
    [Console]::Out.WriteLine(('{"pid":' + $runtimePid + '}'))
    [Console]::Out.Flush()
    # Parent death closes stdin. Job handle closure also covers watchdog termination.
    while ($null -ne [Console]::In.ReadLine()) {}
  } finally { $runtimeJob.Dispose() }
} catch {
  if ($runtimeOptions.log) { Add-Content -LiteralPath ($runtimeOptions.log + '.guardian') -Value $_.Exception.Message }
  [Console]::Out.WriteLine((@{error='Cannot launch local Neo4j Windows job'; diagnostic=$_.Exception.Message} | ConvertTo-Json -Compress))
  exit 1
}
