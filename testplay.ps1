# Leaf Fight - test play launcher (one click from the desktop shortcut)
#
# 1. Starts the dev server on port 5300 (minimized) if it is not running yet.
# 2. Closes test-play windows left over from a previous run.
# 3. Opens two app windows: ?testplay=host and ?testplay=guest.
#    The app connects them automatically (src/ui/board/useTestPlay.ts).
# 4. Host -> primary monitor, guest -> second monitor, both maximized.
#    With a single monitor, they are placed side by side (left / right half).
#
# NOTE: keep this file ASCII-only. The project path contains Japanese characters;
# it is resolved at runtime from $PSScriptRoot, never written here.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LfWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static List<IntPtr> Find(string prefix) {
    var list = new List<IntPtr>();
    EnumWindows((h, p) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().StartsWith(prefix)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

$port = 5300
$base = "http://localhost:$port/"
$root = $PSScriptRoot

function Test-Listening { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }
function Fail($msg) {
  [System.Windows.Forms.MessageBox]::Show($msg, 'Leaf Fight test play') | Out-Null
  exit 1
}

# 1. dev server
if (-not (Test-Listening)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', 'title leaffight dev server && npm run dev' -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 90 -and -not (Test-Listening); $i++) { Start-Sleep -Milliseconds 500 }
  if (-not (Test-Listening)) { Fail 'The dev server did not start within 45 seconds. See the minimized "leaffight dev server" window.' }
}

# 2. close windows from a previous run (WM_CLOSE)
foreach ($h in [LfWin]::Find('LF TestPlay')) { [LfWin]::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
Start-Sleep -Milliseconds 800

# 3. browser (Chrome first, then Edge)
$browser = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { Fail 'Chrome or Edge was not found.' }

Start-Process -FilePath $browser -ArgumentList '--new-window', "--app=${base}?testplay=host"
Start-Sleep -Milliseconds 1500
Start-Process -FilePath $browser -ArgumentList '--new-window', "--app=${base}?testplay=guest"

# wait until both windows show their titles (set by the app at startup)
$hostWin = $null; $guestWin = $null
for ($i = 0; $i -lt 60; $i++) {
  $hostWin = [LfWin]::Find('LF TestPlay - HOST') | Select-Object -First 1
  $guestWin = [LfWin]::Find('LF TestPlay - GUEST') | Select-Object -First 1
  if ($hostWin -and $guestWin) { break }
  Start-Sleep -Milliseconds 500
}
if (-not ($hostWin -and $guestWin)) { exit 0 } # windows are open; just could not arrange them

# 4. arrange
function Place($h, $area, [bool]$maximize) {
  [LfWin]::ShowWindow($h, 9) | Out-Null  # SW_RESTORE
  [LfWin]::SetWindowPos($h, [IntPtr]::Zero, $area.X, $area.Y, $area.Width, $area.Height, 0x0040) | Out-Null
  if ($maximize) { [LfWin]::ShowWindow($h, 3) | Out-Null }  # SW_MAXIMIZE
}
$screens = [System.Windows.Forms.Screen]::AllScreens
$primary = ($screens | Where-Object { $_.Primary } | Select-Object -First 1).WorkingArea
$second = $screens | Where-Object { -not $_.Primary } | Select-Object -First 1
if ($second) {
  Place $guestWin $second.WorkingArea $true
  Place $hostWin $primary $true
} else {
  $half = [int]($primary.Width / 2)
  Place $hostWin (New-Object System.Drawing.Rectangle($primary.X, $primary.Y, $half, $primary.Height)) $false
  Place $guestWin (New-Object System.Drawing.Rectangle(($primary.X + $half), $primary.Y, ($primary.Width - $half), $primary.Height)) $false
}
[LfWin]::SetForegroundWindow($hostWin) | Out-Null
