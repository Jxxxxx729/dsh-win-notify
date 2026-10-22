# Sends one Windows toast notification under the DeepSeek Harness application id.
# This file is executed by powershell.exe (Windows PowerShell 5.1). Keep it pure
# ASCII: Windows PowerShell reads -File scripts with the ANSI code page, so any
# non-ASCII literal here would break parsing. All localized text travels in the
# UTF-8 XML payload file instead.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$XmlPath,
  [string]$AppId = 'com.deepseek.dsh',
  [string]$SkipIfForeground = '',
  [string]$LogPath = ''
)

function Write-Log([string]$Message) {
  if ($LogPath -ne '') {
    try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'o') + ' ' + $Message) -Encoding UTF8 } catch { }
  }
}

try {
  if ($SkipIfForeground -ne '') {
    if (-not ('Win32Notify.NativeMethods' -as [type])) {
      Add-Type -Namespace Win32Notify -Name NativeMethods -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr GetForegroundWindow();
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(System.IntPtr hWnd, out uint lpdwProcessId);
'@
    }
    $hwnd = [Win32Notify.NativeMethods]::GetForegroundWindow()
    $procId = [uint32]0
    [void][Win32Notify.NativeMethods]::GetWindowThreadProcessId($hwnd, [ref]$procId)
    if ($procId -gt 0) {
      $foreground = Get-Process -Id $procId -ErrorAction SilentlyContinue
      if ($null -ne $foreground -and $foreground.ProcessName -eq $SkipIfForeground) {
        Write-Log ('skipped: ' + $SkipIfForeground + ' is foreground')
        exit 0
      }
    }
  }

  $xml = [System.IO.File]::ReadAllText($XmlPath, [System.Text.Encoding]::UTF8)
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $document = New-Object Windows.Data.Xml.Dom.XmlDocument
  $document.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $document
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($AppId).Show($toast)
  Write-Log 'shown'
  exit 0
} catch {
  Write-Log ('error: ' + $_.Exception.Message)
  exit 1
}
