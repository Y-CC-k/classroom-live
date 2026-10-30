# Runs a program/batch file on every student machine, from the teacher PC.
#
# Usage (ELEVATED PowerShell on the teacher machine):
#   powershell -ExecutionPolicy Bypass -File .\run-students.ps1 `
#     -Ips "172.16.100.6,172.16.100.8" -Run "D:\t.bat"
#
#   Copy a file to every D:\ first, then run it (author once, run everywhere):
#   powershell -ExecutionPolicy Bypass -File .\run-students.ps1 `
#     -Ips "172.16.100.6,172.16.100.8" `
#     -Deploy "C:\deploy\usb\usb-unlock.bat" `
#     -Run "D:\usb-unlock.bat" -Elevated
#
# Notes:
#   - Requires admin$ reachable on each target (see usb\usb-unlock.bat, run
#     once per machine). No app changes needed.
#   - .bat/.cmd are launched via cmd /c. .ps1 via powershell.
#     Anything else is started as the given program.
#   - -Elevated runs the target as the local admin (useful for .bat files
#     that touch the firewall/registry), intro  prompt appears on each screen.
#   - The run is detached (-d): the script fires it and moves on, roughly
#     1-2 seconds per machine.
param(
  [Parameter(Mandatory = $true)]
  [string]$Run,
  [string]$Deploy = "",
  [string]$Base = "172.16.100",
  [int]$First = 3,
  [int]$Last = 60,
  [string]$Ips = "",
  [string]$PsExecPath = "psexec",
  [switch]$Elevated,
  # Launch in the logged-on user's interactive session (default: yes).
  [switch]$NoInteractive
)

if (-not (Test-Path $Run)) {
  Write-Error "Program/batch not found on the teacher machine: $Run"
  exit 1
}
if ($Deploy -ne "" -and -not (Test-Path $Deploy)) {
  Write-Error "-Deploy not found: $Deploy"
  exit 1
}

$fileExt = [System.IO.Path]::GetExtension($Run).ToLowerInvariant()

$targets = if ($Ips.Trim() -ne "") {
  $Ips.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
} else {
  foreach ($n in $First..$Last) { "$Base.$n" }
}

$results = @{}
foreach ($ip in $targets) {
  Write-Host "==> $ip : " -NoNewline
  try {
    if ($Deploy -ne "") {
      # copy into D:\ so every machine sees the same absolute path
      $dest = "\\$ip\D$\"
      if (-not (Test-Path $dest)) { throw "D$ share unreachable" }
      Copy-Item $Deploy $dest -Force
    }

    $args = @("\\$ip", "-accepteula")
    if (-not $NoInteractive.IsPresent) { $args += "-i" }
    $args += "-d"
    if ($Elevated) { $args += "-e" }
    if ($fileExt -eq '.bat' -or $fileExt -eq '.cmd') {
      $args += "cmd.exe"; $args += "/c"; $args += $Run
    } elseif ($fileExt -eq '.ps1') {
      $args += "powershell.exe"; $args += "-NoProfile"; $args += "-ExecutionPolicy"
      $args += "Bypass"; $args += "-File"; $args += $Run
    } else {
      $args += $Run
    }
    & $PsExecPath @args > $null 2>&1
    # -d mode: PsExec exit code equals the REMOTE process id (>= 1000);
    # small codes are real errors (1 access denied, 6 copy error, ...).
    if ($LASTEXITCODE -ge 1000) {
      Write-Host "launched (pid $($LASTEXITCODE))" -ForegroundColor Green
      $results[$ip] = "launched"
    } else {
      Write-Host "FAILED exit $LASTEXITCODE" -ForegroundColor Red
      $results[$ip] = "failed:$LASTEXITCODE"
    }
  } catch {
    Write-Host "unreachable ($($_.Exception.Message))" -ForegroundColor Yellow
    $results[$ip] = "unreachable"
  }
}

Write-Host ""
Write-Host "Summary:"
foreach ($ip in ($results.Keys | Sort-Object)) {
  Write-Host "$ip -> $($results[$ip])"
}
