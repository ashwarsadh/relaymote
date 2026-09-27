' run-hidden.vbs - run a command line with no console window (used by the Relaymote autostart tasks).
' A first argument of --wait makes it wait for the command and return its exit code, so a scheduled
' task tracks the real process: "IgnoreNew" then really means "already running", and "restart on
' failure" sees a crash instead of wscript's instant success.
Dim sh, i, a, cmd, wait, first
Set sh = CreateObject("WScript.Shell")
cmd = ""
wait = False
first = 0
If WScript.Arguments.Count > 0 Then
  If WScript.Arguments(0) = "--wait" Then
    wait = True
    first = 1
  End If
End If
For i = first To WScript.Arguments.Count - 1
  a = WScript.Arguments(i)
  If InStr(a, " ") > 0 Then a = Chr(34) & a & Chr(34)
  cmd = cmd & a & " "
Next
If wait Then
  WScript.Quit sh.Run(Trim(cmd), 0, True)
Else
  sh.Run Trim(cmd), 0, False
End If
