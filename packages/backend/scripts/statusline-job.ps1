# This process owns the only job handle. Assign OURSELVES before launching any
# user code: descendants inherit membership, even when their parent exits.
# Killing this launcher closes the handle and kills the entire job. No PID tree
# walks, detached-PID guesses, native addon, or external compiler are needed.
param([string] $Node, [string] $Runner)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class StatusLineJob {
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, IntPtr info, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  public static IntPtr Own() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway
    int size = Marshal.SizeOf(limits);
    IntPtr info = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, info, false);
      if (!SetInformationJobObject(job, 9, info, (uint)size) ||
          !AssignProcessToJobObject(job, GetCurrentProcess()))
        throw new Win32Exception();
      return job;
    } catch {
      CloseHandle(job);
      throw;
    } finally { Marshal.FreeHGlobal(info); }
  }
}
'@
  $job = [StatusLineJob]::Own()
  # Copy raw streams, not PowerShell text pipelines (which re-encode ANSI/UTF8).
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $Node
  $start.Arguments = '"' + $Runner + '"'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $child = [System.Diagnostics.Process]::Start($start)
  $output = $child.StandardOutput.BaseStream.CopyToAsync([Console]::OpenStandardOutput())
  $errors = $child.StandardError.BaseStream.CopyToAsync([Console]::OpenStandardError())
  [Console]::OpenStandardInput().CopyTo($child.StandardInput.BaseStream)
  $child.StandardInput.Close()
  $child.WaitForExit()
  $null = $output.GetAwaiter().GetResult()
  $null = $errors.GetAwaiter().GetResult()
  $code = $child.ExitCode
  $child.Dispose()
  # Exiting closes the job handle, including after normal completion. Keep the
  # handle open until then (closing it here would also terminate this process).
  exit $code
} catch {
  [Console]::Error.WriteLine('Statusline job launcher failed before/while running command: ' + $_)
  exit 1
}
