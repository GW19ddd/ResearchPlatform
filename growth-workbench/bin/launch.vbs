' Workbench launcher: start server + public tunnel, then open the browser.
' Usage: double-click this file.  With argument "boot" it skips opening the browser
'        (used by the Startup folder entry).
Option Explicit

Dim sh, fs, here, ps1, cmd
Set sh = CreateObject("WScript.Shell")
Set fs = CreateObject("Scripting.FileSystemObject")

here = fs.GetParentFolderName(WScript.ScriptFullName)
ps1 = fs.BuildPath(here, "launch.ps1")
If Not fs.FileExists(ps1) Then
    MsgBox "Missing launch.ps1 next to this launcher.", 16, "Workbench"
    WScript.Quit 1
End If

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """"
If WScript.Arguments.Count > 0 Then
    If LCase(WScript.Arguments(0)) = "boot" Then cmd = cmd & " -NoBrowser"
End If

' 0 = hidden window, False = do not wait
sh.Run cmd, 0, False
