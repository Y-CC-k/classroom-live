# Create Desktop Shortcuts using PowerShell
$WshShell = New-Object -ComObject WScript.Shell
$desktopPath = [Environment]::GetFolderPath("Desktop")
$projectRoot = "D:\classroom-live"

# 1. Server shortcut
$shortcut = $WshShell.CreateShortcut("$desktopPath\ClassroomLive-Server.lnk")
$shortcut.TargetPath = "cmd.exe"
$shortcut.Arguments = "/c `"$projectRoot\start-server.bat`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = "C:\Windows\System32\cmd.exe, 0"
$shortcut.Description = "Start Classroom Live Signal Server (Port 8787)"
$shortcut.Save()

# 2. Teacher shortcut
$shortcut = $WshShell.CreateShortcut("$desktopPath\ClassroomLive-Teacher.lnk")
$shortcut.TargetPath = "C:\classroom-live-test\teacher\教室直播 — 教師機.exe"
$shortcut.Arguments = "--remote-debugging-port=9222"
$shortcut.WorkingDirectory = "C:\classroom-live-test\teacher"
$shortcut.IconLocation = "C:\classroom-live-test\teacher\教室直播 — 教師機.exe, 0"
$shortcut.Description = "Classroom Live - Teacher"
$shortcut.Save()

# 3. Student shortcut
$shortcut = $WshShell.CreateShortcut("$desktopPath\ClassroomLive-Student.lnk")
$shortcut.TargetPath = "C:\classroom-live-test\student\教室直播 — 學生機.exe"
$shortcut.Arguments = "--remote-debugging-port=9223"
$shortcut.WorkingDirectory = "C:\classroom-live-test\student"
$shortcut.IconLocation = "C:\classroom-live-test\student\教室直播 — 學生機.exe, 0"
$shortcut.Description = "Classroom Live - Student"
$shortcut.Save()

Write-Host "Desktop shortcuts created!"
Write-Host "1. ClassroomLive-Server.lnk (MUST start first)"
Write-Host "2. ClassroomLive-Teacher.lnk"
Write-Host "3. ClassroomLive-Student.lnk"