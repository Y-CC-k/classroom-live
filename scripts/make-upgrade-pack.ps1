# Packs the student app code (resources/app, JS only) into student-code-pack.zip
# for the in-app hot-update channel. Pure ASCII on purpose.
#
# Source of truth: the LAST electron-builder run
#   listen: dist-electron/student/win-unpacked/resources/app
# Run after `npm run build --workspace @classroom/student` (+ pack) so the
# zip matches what was just compiled.
#
# Usage:  node scripts/make-upgrade-pack.mjs
# Output: dist-electron/student/student-code-pack.zip

param(
  [string]$Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$appDir = Join-Path $Root 'dist-electron\student\win-unpacked\resources\app'
$outDir = Join-Path $Root 'dist-electron\student'
$zip = Join-Path $outDir 'student-code-pack.zip'

if (-not (Test-Path $appDir)) {
  Write-Error "Not found: $appDir - run the student build + pack first."
  exit 1
}

# Stage a copy excluding config.json: the deployed machine keeps its own
# deployment-layer config; overwriting it from the pack would clobber
# the classroom settings.
$stage = Join-Path ([System.IO.Path]::GetTempPath()) "classroom-code-pack-$(Get-Random)"
New-Item -ItemType Directory -Force $stage | Out-Null
robocopy $appDir $stage /E /XF config.json /NFL /NDL /NJH /NJS | Out-Null

# Padding: some deployed students still gate upgrades on "zip >= 256 KB".
# Zero bytes would deflate to almost nothing, so use random bytes which
# stay ~1:1 under compression. The pad lands as resources/app/_pad.bin on
# the student machine and is harmless (it is not part of the app code).
$padSize = 320 * 1024
$pad = New-Object byte[] $padSize
$rng = New-Object System.Random 20260101
for ($i = 0; $i -lt $padSize; $i++) { $pad[$i] = [byte]$rng.Next(256) }
[System.IO.File]::WriteAllBytes((Join-Path $stage '_pad.bin'), $pad)

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force

$size = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Output "Pack ready: $zip ($size MB)"
