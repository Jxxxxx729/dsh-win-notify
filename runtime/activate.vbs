' DeepSeek Harness notification activation shim.
' Registered as the handler of the dsh-win-notify: protocol. Windows invokes it
' through wscript.exe (no console window) as:
'   wscript //nologo activate.vbs "<url>" "<spool dir>" "<DeepSeek Harness.exe>"
' It records the clicked notification in the spool directory and brings the
' DeepSeek Harness window to the foreground. The running GUI picks the spool file
' up and navigates to the originating conversation.
Option Explicit

Dim argList, url, spoolDir, exePath, sessionId, kind, fso, shell, fileName, file, epoch

If WScript.Arguments.Count < 2 Then WScript.Quit 2
Set argList = WScript.Arguments
url = argList(0)
spoolDir = argList(1)
exePath = ""
If argList.Count > 2 Then exePath = argList(2)

sessionId = GetParam(url, "s")
kind = GetParam(url, "k")
If kind = "" Then kind = "open"

On Error Resume Next
Set fso = CreateObject("Scripting.FileSystemObject")
If Err.Number <> 0 Then WScript.Quit 3
If Not fso.FolderExists(spoolDir) Then
  fso.CreateFolder spoolDir
  If Err.Number <> 0 Then WScript.Quit 3
End If
On Error GoTo 0

Randomize
epoch = DateDiff("s", "1970-01-01 00:00:00", Now())
fileName = "p-" & epoch & "-" & CStr(Int(Rnd() * 1000000)) & ".json"

On Error Resume Next
Set file = fso.CreateTextFile(fso.BuildPath(spoolDir, fileName), True, False)
If Err.Number <> 0 Then WScript.Quit 4
file.Write "{""sessionId"":""" & JsonEscape(sessionId) & """,""kind"":""" & JsonEscape(kind) & """,""at"":" & epoch & "}"
file.Close
If Err.Number <> 0 Then WScript.Quit 4
On Error GoTo 0

If exePath <> "" Then
  On Error Resume Next
  Set shell = CreateObject("WScript.Shell")
  shell.Run """" & exePath & """", 1, False
  On Error GoTo 0
End If

WScript.Quit 0

' Returns the raw (unencoded) value of a key in a query-style URL.
Function GetParam(ByVal text, ByVal key)
  Dim marker, startAt, endAt, rest
  GetParam = ""
  marker = key & "="
  startAt = InStr(1, text, "?" & marker, 1)
  If startAt = 0 Then startAt = InStr(1, text, "&" & marker, 1)
  If startAt = 0 Then Exit Function
  startAt = startAt + Len(marker) + 1
  rest = Mid(text, startAt)
  endAt = InStr(1, rest, "&", 1)
  If endAt > 0 Then rest = Left(rest, endAt - 1)
  GetParam = rest
End Function

' Escapes a value for a JSON string literal and drops characters that are not
' safe ASCII, so the spool file stays readable with any ANSI code page.
Function JsonEscape(ByVal value)
  Dim i, ch, code, out
  out = ""
  For i = 1 To Len(value)
    ch = Mid(value, i, 1)
    code = AscW(ch)
    If code >= 0 Then
      If ch = "\" Then
        out = out & "\\"
      ElseIf ch = """" Then
        out = out & "\"""
      ElseIf code < 32 Or code > 126 Then
        out = out & "?"
      Else
        out = out & ch
      End If
    End If
  Next
  JsonEscape = out
End Function
