# Own the PTY host and all shells BEFORE any shell or user profile can run.
# Only this launcher owns the kill-on-close handle. No PID lookup / taskkill.
param([string] $Node, [string] $Runner)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class TerminalJob {
  public static System.Threading.Tasks.Task Pump(System.IO.Stream source, System.IO.Stream target) {
    return System.Threading.Tasks.Task.Run(() => {
      byte[] buffer = new byte[8192]; int count;
      while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
        target.Write(buffer, 0, count); target.Flush();
      }
    });
  }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j, int k, IntPtr i, uint s);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j, IntPtr p);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr Min, Max; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Limits {
    public Basic Basic; public ulong A, B, C, D, E, F; public UIntPtr G, H, I, J;
  }
  public static IntPtr Own() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new Limits(); limits.Basic.Flags = 0x2000;
    int size = Marshal.SizeOf(limits); IntPtr info = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, info, false);
      if (!SetInformationJobObject(job, 9, info, (uint)size) || !AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
      return job;
    } catch { CloseHandle(job); throw; }
    finally { Marshal.FreeHGlobal(info); }
  }
}
'@
  $job = [TerminalJob]::Own()
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Node
  $start.Arguments = '"' + $Runner + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $inputCopy = [TerminalJob]::Pump([Console]::OpenStandardInput(), $child.StandardInput.BaseStream)
  $output = [TerminalJob]::Pump($child.StandardOutput.BaseStream, [Console]::OpenStandardOutput())
  $errors = [TerminalJob]::Pump($child.StandardError.BaseStream, [Console]::OpenStandardError())
  # EOF means the backend died; a normal worker exit also closes the job.
  while (!$child.WaitForExit(100)) { if ($inputCopy.IsCompleted) { exit 0 } }
  $null = $output.GetAwaiter().GetResult()
  $null = $errors.GetAwaiter().GetResult()
  exit $child.ExitCode
} catch {
  [Console]::Error.WriteLine('Terminal job launcher failed: ' + $_)
  exit 1
}
