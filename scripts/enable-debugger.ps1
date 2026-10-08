param([switch]$Force, [int]$Port = 9229, [int]$Countdown = 3, [switch]$DryRun, [int]$SnoozeMs = 5000, [int]$MaxSnoozeMs = 60000, [int64]$ProbeSignIn = 0)
# enable-debugger.ps1 - switch on Claude Desktop's main-process debugger for Relaymote (Windows).
#
# Clicks Menu > Developer > Enable Main Process Debugger in the Claude Desktop window through UI
# Automation, then dismisses the confirmation dialog. Developer mode must be on in Claude Desktop
# (Help > Troubleshooting > Enable Developer Mode). A small click-through bar on screen counts down
# ("Relaymote: turning on Claude's debugger in 3, 2, 1") and then shows the result. Any mouse or keyboard
# input during the countdown snoozes it: it waits until you have been still for SnoozeMs (5 s), then
# counts down again; still busy after MaxSnoozeMs (60 s), it gives up for now (exit 12, retried later).
# The mouse pointer goes back to where it was; both positions are logged.
#
# The window keeps its size: a maximised or normal window is only brought to the front, never restored
# or resized; a minimised one is restored to its last state and minimised again afterwards. Focus goes
# back to whatever you were using.
#
# Exit codes (lib/heal.js DEBUGGER_REASONS turns each into a sentence for the app):
#   0 debugger listening           1 Claude Desktop not running    2 Menu button not found
#   3 Developer menu missing       4 menu item missing             5 port never opened
#   6 debugger stopped again       7 window could not be raised    8 Windows session disconnected
#   9 Windows session locked       10 Claude Desktop not signed in   12 you kept using the computer
# -DryRun walks every step up to the menu item, lists the Developer menu and closes it without clicking.
# It must run in your interactive desktop session: Windows does not deliver simulated clicks to a
# disconnected or locked session, so 8 and 9 are checked first rather than clicking into nothing.
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing @"
using System; using System.Runtime.InteropServices; using System.Windows.Forms; using System.Drawing;
public class N {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint f, bool i, uint a);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr h);
  [DllImport("wtsapi32.dll")] public static extern bool WTSQuerySessionInformation(IntPtr s, int id, int cls, out IntPtr buf, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr p);
  public const uint LEFTDOWN=0x02, LEFTUP=0x04;
  [StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
  // Tick of the last keyboard or mouse input in this session; changes whenever you touch either.
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vk);
  public static bool MouseButtonDown() { return (GetAsyncKeyState(1) & 0x8000) != 0 || (GetAsyncKeyState(2) & 0x8000) != 0 || (GetAsyncKeyState(4) & 0x8000) != 0; }
  public static uint LastInput() { LII l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return l.dwTime; }
  // WTSConnectState of this session: 0 = active, 4 = disconnected (Remote Desktop closed), -1 = unknown.
  public static int ConnState() { IntPtr b; int n; if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 8, out b, out n)) return -1; int v = Marshal.ReadInt32(b); WTSFreeMemory(b); return v; }
  // The input desktop cannot be opened while the lock screen (or any secure desktop) is showing.
  public static bool InputDesktop() { IntPtr d = OpenInputDesktop(0, false, 0x0100); if (d == IntPtr.Zero) return false; CloseDesktop(d); return true; }
}
public class RelaymoteBar : Form {
  Label l;
  public RelaymoteBar() {
    FormBorderStyle = FormBorderStyle.None; ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
    BackColor = Color.FromArgb(28, 28, 32); Opacity = 0.94; Width = 520; Height = 58;
    l = new Label(); l.Dock = DockStyle.Fill; l.ForeColor = Color.White; l.Font = new Font("Segoe UI", 12.5f);
    l.TextAlign = ContentAlignment.MiddleCenter; Controls.Add(l);
  }
  protected override bool ShowWithoutActivation { get { return true; } }
  // no-activate, tool window (no taskbar/alt-tab), click-through, topmost
  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80 | 0x20 | 0x08; return cp; } }
  public void Say(string s, Color c) { l.Text = s; l.ForeColor = c; Refresh(); Application.DoEvents(); }
}
"@
$ErrorActionPreference = 'Stop'
$UIA = [System.Windows.Automation.AutomationElement]; $root = $UIA::RootElement
$DESC = [System.Windows.Automation.TreeScope]::Descendants
$WHITE = [System.Drawing.Color]::White; $GREEN = [System.Drawing.Color]::FromArgb(110, 220, 140); $RED = [System.Drawing.Color]::FromArgb(255, 130, 120)
function Log($m) { Write-Host ("[{0}] {1}" -f (Get-Date -f HH:mm:ss), $m) }
function IsUp { [bool](netstat -ano | Select-String "127.0.0.1:$Port" | Select-String "LISTENING") }
function Find($name) { $c = New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, $name); try { return $root.FindFirst($DESC, $c) } catch { return $null } }
function WaitFind($name, [int]$ms) { $t = [Environment]::TickCount; do { $e = Find $name; if ($e) { return $e }; Start-Sleep -Milliseconds 80 } while ([Environment]::TickCount - $t -lt $ms); return $null }
function Center($el) { $r = $el.Current.BoundingRectangle; return @([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) }
function MoveTo($el) { $p = Center $el; [void][N]::SetCursorPos($p[0], $p[1]) }
function RealClick($el) { $p = Center $el; [void][N]::SetCursorPos($p[0], $p[1]); Start-Sleep -Milliseconds 40; [N]::mouse_event([N]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero); Start-Sleep -Milliseconds 30; [N]::mouse_event([N]::LEFTUP, 0, 0, 0, [IntPtr]::Zero) }
function InputKind($p0) {
  $p = [System.Windows.Forms.Cursor]::Position
  if ($p.X -ne $p0.X -or $p.Y -ne $p0.Y) { return 'mouse moved' }
  if ([N]::MouseButtonDown()) { return 'mouse clicked' }
  return 'key pressed'
}
function Say($m, $c) { if ($script:bar) { try { $script:bar.Say($m, $c) } catch {} } }

# The Sign In screen's own buttons, read through UI Automation (reading, never clicking).
function SignInScreen($hwnd) {
  try {
    $r = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    $conds = @('Continue with Google', 'Continue with email', 'Continue with Email', 'Continue with SSO') | ForEach-Object {
      New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $_) }
    return [bool]$r.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.OrCondition($conds)))
  } catch { return $false }
}
function Finish([int]$code, [string]$msg) {
  Log $msg
  if ($script:cur0) {
    try {
      [void][N]::SetCursorPos($script:cur0.X, $script:cur0.Y)
      $c1 = [System.Windows.Forms.Cursor]::Position
      Log ("cursor after: {0},{1} (before: {2},{3})" -f $c1.X, $c1.Y, $script:cur0.X, $script:cur0.Y)
    } catch {}
  }
  if ($code -ne 0 -and $script:menuOpen) { try { [System.Windows.Forms.SendKeys]::SendWait('{ESC}{ESC}') } catch {} }
  try {
    if ($script:tgt) { [void][N]::AttachThreadInput($script:my, $script:tgt, $false) }
    if ($script:fg) { [void][N]::AttachThreadInput($script:my, $script:fg, $false) }
    if ($script:wasMinimized) { [void][N]::ShowWindow($script:h, 7) }   # SW_SHOWMINNOACTIVE: back to how it was
    if ($script:prevFgWin -and $script:prevFgWin -ne [IntPtr]::Zero -and $script:prevFgWin -ne $script:h) {
      [void][N]::SetForegroundWindow($script:prevFgWin)
    }
  } catch {}
  if ($script:bar) {
    if ($code -eq 0) { Say "Relaymote: Claude's debugger is on" $GREEN } else { Say ("Relaymote could not turn the debugger on: " + $msg) $RED }
    $t = [Environment]::TickCount; while ([Environment]::TickCount - $t -lt 1800) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50 }
    try { $script:bar.Close() } catch {}
  }
  exit $code
}

# -ProbeSignIn <window handle>: only answer "is this the Sign In screen" (exit 10 yes, 0 no). Test seam.
if ($ProbeSignIn) { if (SignInScreen $ProbeSignIn) { Log 'sign-in screen'; exit 10 } else { Log 'not the sign-in screen'; exit 0 } }
if ((IsUp) -and (-not $Force) -and (-not $DryRun)) { Log 'debugger already on'; exit 0 }
$cs = [N]::ConnState()
if ($cs -eq 4) { Finish 8 'the Windows session is disconnected (Remote Desktop closed), and Windows does not deliver clicks to it' }
if (-not [N]::InputDesktop()) { Finish 9 'Windows is locked, and Windows does not deliver clicks behind the lock screen' }
$cl = Get-Process -Name claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $cl) { Finish 1 'Claude Desktop is not running (or has no window)' }
$h = $cl.MainWindowHandle; $script:h = $h

# The debugger item does nothing before Claude Desktop has signed in and finished starting.
$signedIn = $false
try {
  $cfg = Get-Content (Join-Path $env:APPDATA 'Claude\config.json') -Raw | ConvertFrom-Json
  $signedIn = [bool]($cfg.'oauth:tokenCacheV2' -or $cfg.'oauth:tokenCache')
} catch {}
if (-not $signedIn) { Finish 10 'Claude Desktop is not signed in yet' }
# g1518: after an account switch the token cache above still holds the OLD account's token while the
# window shows Sign In ("Continue with Google / Continue with email"), so that test passed and the menus
# were clicked on the login screen. Look at what the window actually shows; nothing is clicked here.
if (SignInScreen $h) { Finish 10 'Claude Desktop is showing its Sign In screen' }
try { $age = ((Get-Date) - $cl.StartTime).TotalSeconds; if ($age -lt 20) { Start-Sleep -Milliseconds ([int]((20 - $age) * 1000)) } } catch {}

# The on-screen countdown, top centre of the screen Claude Desktop is on (not over its text box). It never takes focus
# and clicks pass through it.
try {
  $script:bar = New-Object RelaymoteBar
  $wa = [System.Windows.Forms.Screen]::FromHandle($h).WorkingArea
  $script:bar.Left = [int]($wa.Left + ($wa.Width - $script:bar.Width) / 2); $script:bar.Top = [int]($wa.Top + 8)   # top: at the bottom it covered the Claude text box
  $script:bar.Show()
  $snoozeStart = $null
  while ($true) {
    $base = [N]::LastInput(); $busy = $false; $p0 = [System.Windows.Forms.Cursor]::Position
    for ($i = $Countdown; $i -ge 1 -and -not $busy; $i--) {
      Say ("Relaymote: turning on Claude's debugger in $i" + $(if ($i -gt 1) { '...' } else { ' - hands off the keyboard' })) $WHITE
      $t = [Environment]::TickCount
      while ([Environment]::TickCount - $t -lt 1000) {
        [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50
        # g546: only the KEYBOARD snoozes, and only in the last second ("1"). The mouse never does.
        $now = [N]::LastInput()
        if ($now -ne $base) {
          $kind = InputKind $p0
          if ($i -eq 1 -and $kind -eq 'key pressed') { $busy = $true; $why = $kind; break }
          $base = $now; $p0 = [System.Windows.Forms.Cursor]::Position
        }
      }
    }
    if (-not $busy) { break }
    # You typed during the "1": wait until the keyboard has been quiet for SnoozeMs, then count again.
    if (-not $snoozeStart) { $snoozeStart = [Environment]::TickCount }
    $script:snoozes++
    Log ("snoozed - " + $why + " during the countdown (snooze " + $script:snoozes + ")")
    $last = [N]::LastInput(); $quiet = [Environment]::TickCount
    while ([Environment]::TickCount - $quiet -lt $SnoozeMs) {
      if ([Environment]::TickCount - $snoozeStart -gt $MaxSnoozeMs) { Finish 12 'you kept using the computer, so Relaymote will try again in a minute' }
      $left = [Math]::Ceiling(($SnoozeMs - ([Environment]::TickCount - $quiet)) / 1000)
      Say ("Relaymote: snoozed - " + $why + ". Trying again in ${left}s") $WHITE
      [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100
      $now = [N]::LastInput(); if ($now -ne $last) { if ((InputKind $p0) -eq 'key pressed') { $quiet = [Environment]::TickCount }; $p0 = [System.Windows.Forms.Cursor]::Position; $last = $now }
    }
  }
  Say "Relaymote: turning on Claude's debugger..." $WHITE
} catch { Log ("countdown bar unavailable: " + $_.Exception.Message); $script:bar = $null }
if ((IsUp) -and (-not $DryRun)) { Finish 0 "debugger on (port $Port)" }

$script:cur0 = [System.Windows.Forms.Cursor]::Position
Log ("cursor before: {0},{1}" -f $script:cur0.X, $script:cur0.Y)
$script:my = [N]::GetCurrentThreadId()
$script:prevFgWin = [N]::GetForegroundWindow()
$script:wasMinimized = [N]::IsIconic($h)

# The clicks are real mouse clicks at the element's position, so Claude Desktop must be the top
# window. Bring it forward WITHOUT resizing: only a minimised window is restored (to its last state).
if ([N]::GetForegroundWindow() -ne $h) {
  $script:fg = [N]::GetWindowThreadProcessId($script:prevFgWin, [IntPtr]::Zero)
  $script:tgt = [N]::GetWindowThreadProcessId($h, [IntPtr]::Zero)
  [void][N]::AttachThreadInput($script:my, $script:fg, $true)
  [void][N]::AttachThreadInput($script:my, $script:tgt, $true)
  $raised = $false
  for ($i = 0; $i -lt 10; $i++) {
    if ([N]::IsIconic($h)) { [void][N]::ShowWindow($h, 9) }   # SW_RESTORE on a minimised window returns it to maximised or normal as it was
    [void][N]::BringWindowToTop($h)
    [void][N]::SetForegroundWindow($h)
    Start-Sleep -Milliseconds 120
    if ([N]::GetForegroundWindow() -eq $h) { $raised = $true; break }
  }
  if (-not $raised) { Finish 7 'Windows would not let Relaymote bring Claude Desktop to the front' }
}
$root = [System.Windows.Automation.AutomationElement]::FromHandle($h)

$menu = WaitFind 'Menu' 4000
if (-not $menu) { Finish 2 "Claude Desktop's Menu button was not found (its window was not ready)" }
RealClick $menu; $script:menuOpen = $true

$dev = WaitFind 'Developer' 3000
if (-not $dev) { Finish 3 'the Developer menu is missing - turn on Developer Mode (Help > Troubleshooting) and restart Claude Desktop' }
MoveTo $dev   # a submenu opens on hover, not on click

$dbg = WaitFind 'Enable Main Process Debugger' 3000
if ($DryRun) {
  $names = @($root.FindAll($DESC, (New-Object System.Windows.Automation.PropertyCondition($UIA::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem))) | ForEach-Object { $_.Current.Name }) -join ' | '
  Log ('menu items: ' + $names)
  if ($dbg) { Finish 11 'dry run: every step reached the menu item, nothing clicked' } else { Finish 4 'the Enable Main Process Debugger item was not in the Developer menu' }
}
if (-not $dbg) { Finish 4 'the Enable Main Process Debugger item was not in the Developer menu' }
RealClick $dbg; $script:menuOpen = $false

$up = $false
for ($i = 0; $i -lt 80; $i++) { if (IsUp) { $up = $true; break }; Start-Sleep -Milliseconds 100 }
if (-not $up) { Finish 5 "the menu item was clicked but nothing started listening on port $Port" }

# Enabling also shows a modal "Inspector" dialog (its own top-level window); its default button is OK.
$root = $UIA::RootElement
$ok = $null; $t = [Environment]::TickCount
do {
  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition($UIA::ProcessIdProperty, $cl.Id)))) {
    if ($w.Current.NativeWindowHandle -eq [int]$h) { continue }
    $ok = $w.FindFirst($DESC, (New-Object System.Windows.Automation.PropertyCondition($UIA::NameProperty, 'OK')))
    if ($ok) { break }
  }
  if ($ok) { break }; Start-Sleep -Milliseconds 80
} while ([Environment]::TickCount - $t -lt 2000)
if ($ok) { RealClick $ok } else { try { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') } catch {} }
Start-Sleep -Milliseconds 300

if (IsUp) { Finish 0 "debugger on (port $Port)" }
Finish 6 'the debugger started and then stopped again'
