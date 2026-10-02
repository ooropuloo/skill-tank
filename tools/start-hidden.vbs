' skill-tank: start server.mjs with a hidden console window (log -> .runtime\server.log)
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
If Not fso.FolderExists(dir & "\.runtime") Then fso.CreateFolder(dir & "\.runtime")
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = dir
nodeExe = "C:\Program Files\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
sh.Run "cmd /c title skill-tank server 4700 && """ & nodeExe & """ """ & dir & "\server.mjs"" > """ & dir & "\.runtime\server.log"" 2>&1", 0, False
