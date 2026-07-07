<#
    HyperFetch one-step setup for Windows.

    Unlike Linux/macOS, Chrome and Firefox on Windows do NOT read native messaging
    host manifests from a folder. They look up the manifest path in the Windows
    Registry, and they cannot launch a .py file directly. This script therefore:

      1. Writes a small .bat wrapper that runs native_host.py with your Python.
      2. Writes the native host manifest JSON (path -> the .bat wrapper).
      3. Registers the manifest in HKCU so Chrome/Firefox can find it.

    Usage (from PowerShell, in this folder):
      powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1           # both
      powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 chrome    # Chrome only
      powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 firefox   # Firefox only

    Or just double-click setup-windows.bat.
#>
[CmdletBinding()]
param(
    [ValidateSet('chrome', 'firefox', 'both')]
    [string]$Target = 'both'
)

$ErrorActionPreference = 'Stop'

# Fixed extension IDs (match the extension manifests).
$ExtensionId        = 'ekhohmoicafiheojabajlkkfibppajic'
$FirefoxExtensionId = 'hyperfetch@hyperfetch.local'
$HostName           = 'com.hyperfetch.host'

$ScriptDir     = Split-Path -Parent $MyInvocation.MyCommand.Definition
$NativeHostDir = Join-Path $ScriptDir 'native-host'
$HostScript    = Join-Path $NativeHostDir 'native_host.py'

Write-Host "HyperFetch setup for Windows ($Target)"
Write-Host ""

if (-not (Test-Path $HostScript)) {
    throw "Missing native host script: $HostScript"
}

# --- Locate a Python interpreter -------------------------------------------------
$PythonCmd  = $null
$PythonArgs = ''
foreach ($candidate in @('py', 'python', 'python3')) {
    $found = Get-Command $candidate -ErrorAction SilentlyContinue
    if ($found) {
        $PythonCmd = $found.Source
        if ($candidate -eq 'py') { $PythonArgs = '-3 ' }
        break
    }
}
if (-not $PythonCmd) {
    throw "Python was not found on PATH. Install Python 3 from https://www.python.org/downloads/ (check 'Add Python to PATH') and re-run."
}
Write-Host "  Using Python: $PythonCmd"

# --- Write the .bat wrapper Chrome/Firefox will actually launch ------------------
# %~dp0 = directory of the .bat (with trailing backslash); %* forwards the args
# Chrome/Firefox pass (extension origin / manifest path + gecko id).
$WrapperBat = Join-Path $NativeHostDir 'run_native_host.bat'
$wrapperContent = @"
@echo off
"$PythonCmd" $PythonArgs"%~dp0native_host.py" %*
"@
Set-Content -Path $WrapperBat -Value $wrapperContent -Encoding ASCII
Write-Host "  Wrote host wrapper: $WrapperBat"

function Install-Host {
    param(
        [string]$ManifestPath,
        [hashtable]$Manifest,
        [string]$RegistryKey
    )
    $json = $Manifest | ConvertTo-Json -Depth 5
    Set-Content -Path $ManifestPath -Value $json -Encoding ASCII
    New-Item -Path $RegistryKey -Force | Out-Null
    Set-ItemProperty -Path $RegistryKey -Name '(default)' -Value $ManifestPath
    Write-Host "  Manifest:  $ManifestPath"
    Write-Host "  Registry:  $RegistryKey"
}

$didChrome  = $false
$didFirefox = $false

if ($Target -eq 'chrome' -or $Target -eq 'both') {
    Write-Host "== Chrome =="
    Write-Host "  Extension ID: $ExtensionId"
    $manifest = @{
        name            = $HostName
        description     = 'Native messaging host for HyperFetch'
        path            = $WrapperBat
        type            = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
    $manifestPath = Join-Path $NativeHostDir 'com.hyperfetch.host.chrome.win.json'
    Install-Host -ManifestPath $manifestPath -Manifest $manifest `
        -RegistryKey "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
    $didChrome = $true
    Write-Host ""
}

if ($Target -eq 'firefox' -or $Target -eq 'both') {
    Write-Host "== Firefox =="
    Write-Host "  Extension ID: $FirefoxExtensionId"
    $manifest = @{
        name               = $HostName
        description        = 'Native messaging host for HyperFetch'
        path               = $WrapperBat
        type               = 'stdio'
        allowed_extensions = @($FirefoxExtensionId)
    }
    $manifestPath = Join-Path $NativeHostDir 'com.hyperfetch.host.firefox.win.json'
    Install-Host -ManifestPath $manifestPath -Manifest $manifest `
        -RegistryKey "HKCU:\Software\Mozilla\NativeMessagingHosts\$HostName"
    $didFirefox = $true
    Write-Host ""
}

Write-Host "Done."

if ($didChrome) {
    Write-Host ""
    Write-Host "Next steps in Chrome:"
    Write-Host "  1. Open chrome://extensions/"
    Write-Host "  2. Enable Developer mode (top-right)"
    Write-Host "  3. Click 'Load unpacked' and select: $(Join-Path $ScriptDir 'chrome-extension')"
    Write-Host "  4. Confirm the ID shows as: $ExtensionId"
    Write-Host "  5. Fully quit Chrome (all windows) and reopen it, then click 'Test Native Host'"
}

if ($didFirefox) {
    Write-Host ""
    Write-Host "Next steps in Firefox:"
    Write-Host "  1. Open about:debugging#/runtime/this-firefox"
    Write-Host "  2. Click 'Load Temporary Add-on' and select: $(Join-Path $ScriptDir 'firefox-extension\manifest.json')"
    Write-Host "  3. Confirm the Extension ID shows as: $FirefoxExtensionId"
    Write-Host "  4. Restart Firefox, then click 'Test Native Host'"
}
