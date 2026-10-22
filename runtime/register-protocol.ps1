# Registers the "dsh-win-notify:" URL protocol for the current user (HKCU).
# Clicking a toast notification launches wscript.exe with activate.vbs, which
# records the clicked conversation in a spool directory and focuses the app.
# Keep this file ASCII: Windows PowerShell reads -File scripts with the ANSI code
# page, so any non-ASCII literal here would break parsing.
[CmdletBinding()]
param(
  [string]$Protocol = 'dsh-win-notify',
  [Parameter(Mandatory = $true)][string]$ActivateScript,
  [Parameter(Mandatory = $true)][string]$SpoolDir,
  [Parameter(Mandatory = $true)][string]$WscriptPath,
  [string]$AppExe = '',
  [switch]$NoAppExe,
  [string]$LogPath = ''
)

function Write-Log([string]$Message) {
  if ($LogPath -ne '') {
    try { Add-Content -LiteralPath $LogPath -Value ((Get-Date -Format 'o') + ' register: ' + $Message) -Encoding UTF8 } catch { }
  }
}

try {
  if (-not (Test-Path -LiteralPath $WscriptPath)) { throw ('wscript.exe not found: ' + $WscriptPath) }
  if (-not (Test-Path -LiteralPath $ActivateScript)) { throw ('activation script not found: ' + $ActivateScript) }
  if (-not (Test-Path -LiteralPath $SpoolDir)) { New-Item -ItemType Directory -Path $SpoolDir -Force | Out-Null }

  $exe = ''
  if (-not $NoAppExe) { $exe = $AppExe }

  $command = '"' + $WscriptPath + '" //nologo "' + $ActivateScript + '" "%1" "' + $SpoolDir + '"'
  if ($exe -ne '') { $command = $command + ' "' + $exe + '"' }

  $root = 'HKCU:\Software\Classes\' + $Protocol
  New-Item -Path $root -Force | Out-Null
  Set-Item -LiteralPath $root -Value ('URL:' + $Protocol + ' notification activation') -Force
  New-ItemProperty -Path $root -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null

  $iconKey = $root + '\DefaultIcon'
  New-Item -Path $iconKey -Force | Out-Null
  if ($exe -ne '') {
    Set-Item -LiteralPath $iconKey -Value ('"' + $exe + '",1') -Force
  } else {
    Set-Item -LiteralPath $iconKey -Value ('"' + $WscriptPath + '",0') -Force
  }

  $commandKey = $root + '\shell\open\command'
  New-Item -Path $commandKey -Force | Out-Null
  Set-Item -LiteralPath $commandKey -Value $command -Force

  Write-Log ('registered ' + $Protocol + ' -> ' + $command)
  exit 0
} catch {
  Write-Log ('register error: ' + $_.Exception.Message)
  exit 1
}
