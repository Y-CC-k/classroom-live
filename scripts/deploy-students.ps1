# Bulk-deploys the student installer across a computer room.
#
# Usage (from an admin workstation, running in an ELEVATED PowerShell):
#   powershell -ExecutionPolicy Bypass -File .\deploy-students.ps1 -SetupPath "C:\deploy\StudentSetup.exe" -Base 172.16.100 -First 101 -Last 130
#
# Requirements:
#   - PsExec.exe (Sysinternals) available (download: https://learn.microsoft.com/sysinternals/psexec)
#   - The workstation account must be a local administrator on each target machine
#     (school domain accounts usually already are).
#
# What each machine gets, in order:
#   1. any running instance of the old app is killed (so files can be replaced)
#   2. silent one-click install (/S): Program Files + firewall rules (installer.nsh)
#   3. the app is launched in the logged-on user's interactive session
#      (silent install does NOT auto-run the app, so we do it here)
#
# NOTE: installs run sequentially ON PURPOSE. Launching two installs in
# parallel (-d mode) makes the second copy fail while the first installer
# still holds the temp file. Roughly 30-60 seconds per machine.
param(
  [Parameter(Mandatory = $true)]
  [string]$SetupPath,
  [string]$Base = "172.16.100",
  [int]$First = 3,
  [int]$Last = 60,
  # Optional explicit list: -Ips "172.16.100.6,172.16.100.8"
  # Takes precedence over Base/First/Last when non-empty.
  [string]$Ips = "",
  [string]$PsExecPath = "psexec"
)

if (-not (Test-Path $SetupPath)) {
  Write-Error "Setup not found: $SetupPath"
  exit 1
}

if (-not (Get-Command $PsExecPath -ErrorAction SilentlyContinue) -and $PsExecPath -ne 'psexec') {
  Write-Error "PsExec not found at: $PsExecPath"
  exit 1
}

if (-not (whoami /groups | Select-String 'S-1-5-32-544 ')) {
  Write-Warning "This console does not look elevated; PsExec against admin shares usually fails in that case."
}

# Remote kill command; fully ASCII: we match the installed folder, not the
# Chinese exe name, so name round-trips are never an issue.
$killCmd = 'Get-Process | Where-Object { $_.Path -like "*@classroomstudent*" } | Stop-Process -Force'

$results = @{}

$targets = if ($Ips.Trim() -ne "") {
  $Ips.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
} else {
  foreach ($n in $First..$Last) { "$Base.$n" }
}

foreach ($ip in $targets) {
  Write-Host "==> $ip : " -NoNewline

  # 1) stop any running app instance (ignore failures: probably not running)
  & $PsExecPath "\\$ip" -accepteula powershell -NoProfile -Command $killCmd > $null 2>&1

  # 2) silent install; we WAIT so the temp copy is not locked by the next run
  & $PsExecPath "\\$ip" -accepteula -c -f "$SetupPath" /S > $null 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "INSTALL FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    $results[$ip] = "install-failed:$LASTEXITCODE"
    continue
  }

  # 3) launch the app for the logged-on user
  #    The install folder is derived from the package id (ASCII). The main
  #    exe carries the Chinese product name, so we pick the largest
  #    non-uninstaller exe from the admin share instead of typing it.
  $appDir = "\\$ip\C$\Program Files\@classroomstudent"
  $exe = Get-ChildItem $appDir -Filter *.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -notlike 'unins*' } |
    Sort-Object Length -Descending | Select-Object -First 1
  if (-not $exe) {
    Write-Host "installed, but main exe not found" -ForegroundColor Yellow
    $results[$ip] = "installed;exe-not-found"
    continue
  }
  $remoteExe = $exe.FullName -replace [regex]::Escape("\\$ip\C$"), 'C:'

  # -d detaches; on success PsExec reports the remote process id and its own
  # exit code EQUALS that pid (a positive 4-5 digit number). Small codes
  # mean a real error (1 = cannot access, 6 = copy error, and so on).
  & $PsExecPath "\\$ip" -accepteula -i -d "$remoteExe" > $null 2>&1
  if ($LASTEXITCODE -ge 1000) {
    Write-Host "OK (installed + launched)" -ForegroundColor Green
    $results[$ip] = "installed+launched"
  }
  else {
    Write-Host "installed, launch exit $LASTEXITCODE" -ForegroundColor Yellow
    $results[$ip] = "installed;launch-exit:$LASTEXITCODE"
  }
}

Write-Host ""
Write-Host "Summary:"
foreach ($ip in ($results.Keys | Sort-Object)) {
  Write-Host "$ip -> $($results[$ip])"
}

Write-Host ""
Write-Host "Verify afterwards on the teacher machine: every machine shows up in the student list."
Write-Host "If a machine sits at the Windows logon screen, the app starts once someone logs in (or double-click the desktop shortcut)."
