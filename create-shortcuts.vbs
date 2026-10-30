' Create Desktop Shortcuts
Set WshShell = CreateObject("WScript.Shell")
desktopPath = WshShell.SpecialFolders("Desktop")
projectRoot = "D:\classroom-live"

' 1. Server shortcut
Set shortcut1 = WshShell.CreateShortcut(desktopPath & "\ClassroomLive-Server.lnk")
shortcut1.TargetPath = "cmd.exe"
shortcut1.Arguments = "/c " & Chr(34) & projectRoot & "\start-server.bat" & Chr(34)
shortcut1.WorkingDirectory = projectRoot
shortcut1.IconLocation = "C:\Windows\System32\cmd.exe, 0"
shortcut1.Description = "Start Classroom Live Signal Server (Port 8787)"
shortcut1.Save

' 2. Teacher shortcut
Set shortcut2 = WshShell.CreateShortcut(desktopPath & "\ClassroomLive-Teacher.lnk")
shortcut2.TargetPath = "C:\classroom-live-test\teacher\教室直播 — 教師機.exe"
shortcut2.Arguments = "--remote-debugging-port=9222"
shortcut2.WorkingDirectory = "C:\classroom-live-test\teacher"
shortcut2.IconLocation = "C:\classroom-live-test\teacher\教室直播 — 教師機.exe, 0"
shortcut2.Description = "Classroom Live - Teacher"
shortcut2.Save

' 3. Student shortcut
Set shortcut3 = WshShell.CreateShortcut(desktopPath & "\ClassroomLive-Student.lnk")
shortcut3.TargetPath = "C:\classroom-live-test\student\教室直播 — 學生機.exe"
shortcut3.Arguments = "--remote-debugging-port=9223"
shortcut3.WorkingDirectory = "C:\classroom-live-test\student"
shortcut3.IconLocation = "C:\classroom-live-test\student\教室直播 — 學生機.exe, 0"
shortcut3.Description = "Classroom Live - Student"
shortcut3.Save

MsgBox "Desktop shortcuts created!" & vbCrLf & _
       "1. ClassroomLive-Server.lnk (MUST start first)" & vbCrLf & _
       "2. ClassroomLive-Teacher.lnk" & vbCrLf & _
       "3. ClassroomLive-Student.lnk", vbInformation, "Done"