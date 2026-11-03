param(
  [switch]$Auto,
  [string]$Url = ""
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Write-Host '=== 教室直播 - 重設伺服器位址 ===' -ForegroundColor Cyan

$configPath = Join-Path $env:APPDATA "@classroom\student\student-config.json"
if (-not (Test-Path $configPath)) {
  Write-Host '找不到學生機設定檔（student-config.json）' -ForegroundColor Red
  Read-Host "按 Enter 結束"
  exit 1
}

try {
  $config = Get-Content $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
} catch {
  Write-Host '設定檔損毀，無法解析' -ForegroundColor Red
  Read-Host "按 Enter 結束"
  exit 1
}

Write-Host ("目前伺服器位址: " + $config.serverUrl) -ForegroundColor Gray

$target = $Url
if (-not $target) {
  Write-Host '搜尋區網伺服器中（UDP 廣播，約 3 秒）...' -ForegroundColor Cyan
  $udp = New-Object System.Net.Sockets.UdpClient
  $udp.EnableBroadcast = $true
  $udp.Client.ReceiveTimeout = 1000
  $packet = [Text.Encoding]::UTF8.GetBytes('{"t":"classroom-discover"}')
  $udp.Send($packet, $packet.Length, "255.255.255.255", 8787) | Out-Null
  $udp.Send($packet, $packet.Length, "127.0.0.1", 8787) | Out-Null
  foreach ($ni in [System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
    foreach ($ip in $ni.GetIPProperties().UnicastAddresses) {
      if ($ip.Address.AddressFamily -eq 'InterNetwork') {
        $a = $ip.Address.ToString().Split('.')
        if ($a[3] -ne '255') {
          $bc = $a[0] + '.' + $a[1] + '.' + $a[2] + '.255'
          $udp.Send($packet, $packet.Length, $bc, 8787) | Out-Null
        }
      }
    }
  }

  $found = @{}
  $remoteEP = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
  $deadline = (Get-Date).AddSeconds(3)
  while ((Get-Date) -lt $deadline) {
    try {
      $data = $udp.Receive([ref]$remoteEP)
      $msg = [Text.Encoding]::UTF8.GetString($data) | ConvertFrom-Json
      if ($msg.t -eq 'classroom-announce' -and $msg.wsUrl) { $found[$msg.wsUrl] = $true }
    } catch {
      
    }
  }
  $udp.Close()

  if ($found.Count -eq 0) {
    Write-Host '區網內找不到任何伺服器。請確認伺服器已啟動且在同一網段。' -ForegroundColor Red
    Read-Host "按 Enter 結束"
    exit 1
  }

  $list = @($found.Keys)
  if ($Auto) {
    $target = $list[0]
  } else {
    for ($i = 0; $i -lt $list.Count; $i++) { Write-Host ("  [" + ($i + 1) + "] " + $list[$i]) -ForegroundColor White }
    $sel = Read-Host '請輸入編號'
    $idx = 0
    if (-not [int]::TryParse($sel, [ref]$idx) -or $idx -lt 1 -or $idx -gt $list.Count) {
      Write-Host '無效選擇' -ForegroundColor Red
      Read-Host "按 Enter 結束"
      exit 1
    }
    $target = $list[$idx - 1]
  }
}

Write-Host ("將伺服器位址重設為: " + $target) -ForegroundColor Yellow
$config.serverUrl = $target
Set-Content -Path $configPath -Value ($config | ConvertTo-Json -Depth 10) -Encoding UTF8
Write-Host '已寫入學生機設定檔。請重新啟動學生機程式以套用。' -ForegroundColor Green
Read-Host "按 Enter 結束"