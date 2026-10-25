[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$PlayerPath,
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'PotBridge\native'),
    [switch]$PrepareOnly
)
$ErrorActionPreference = 'Stop'
function Assert-PhysicalFilePath([string]$FilePath) {
    if (-not ('PotBridge.InstallFilePath' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace PotBridge {
 public static class InstallFilePath {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder path, uint length, uint flags);
 }
}
'@
    }
    $stream = [System.IO.File]::OpenRead($FilePath)
    try {
        $buffer = New-Object System.Text.StringBuilder 32768
        $length = [PotBridge.InstallFilePath]::GetFinalPathNameByHandle($stream.SafeFileHandle.DangerousGetHandle(), $buffer, 32768, 0)
        if ($length -eq 0 -or $length -ge 32768) { throw 'Could not verify the physical installation path.' }
        $physicalPath = $buffer.ToString()
        if ($physicalPath.StartsWith('\\?\UNC\')) { $physicalPath = '\\' + $physicalPath.Substring(8) }
        elseif ($physicalPath.StartsWith('\\?\')) { $physicalPath = $physicalPath.Substring(4) }
        if ($physicalPath -ne [System.IO.Path]::GetFullPath($FilePath)) {
            throw 'Windows redirected the installation into an app-private directory. Edge cannot use this registration. Open PowerShell yourself from the Windows Start menu and run this installer there. No registry entry was written by this run.'
        }
    } finally { $stream.Dispose() }
}
if ($PlayerPath) {
    if (-not [System.IO.Path]::IsPathRooted($PlayerPath) -or [System.IO.Path]::GetExtension($PlayerPath) -ne '.exe' -or -not (Test-Path -LiteralPath $PlayerPath -PathType Leaf)) {
        throw 'PlayerPath must be the full path of an existing PotPlayer .exe file.'
    }
}
$hostName = 'com.potbridge.host'
$source = Join-Path $PSScriptRoot '..\host\potbridge.exe'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    $source = Join-Path $PSScriptRoot '..\native\bin\potbridge.exe'
}
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'potbridge.exe is missing. Extract the complete release ZIP first.' }
$installDirectory = [System.IO.Path]::GetFullPath($Destination)
$exePath = Join-Path $installDirectory 'potbridge.exe'
$manifestPath = Join-Path $installDirectory ($hostName + '.json')
$registryPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName
if ($PSCmdlet.ShouldProcess($installDirectory, 'Install PotBridge native host for current user')) {
    New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
    if ([System.IO.Path]::GetFullPath($source) -ne $exePath) {
        Copy-Item -LiteralPath $source -Destination $exePath -Force
    }
    $manifest = [ordered]@{
        name = $hostName
        description = 'PotBridge media relay for PotPlayer'
        path = $exePath
        type = 'stdio'
        allowed_origins = @('chrome-extension://' + $ExtensionId + '/')
    } | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($manifestPath, $manifest, (New-Object System.Text.UTF8Encoding($false)))
    Assert-PhysicalFilePath $manifestPath
    if (-not $PrepareOnly) {
        if ($PlayerPath) {
            $configPath = Join-Path $env:LOCALAPPDATA 'PotBridge\config.json'
            $config = [ordered]@{ playerPath = $PlayerPath; proxyMode = 'system'; proxyUrl = ''; ffprobePath = '' }
            if (Test-Path -LiteralPath $configPath) {
                $previousConfig = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
                foreach ($name in @('proxyMode', 'proxyUrl', 'ffprobePath')) {
                    if ($null -ne $previousConfig.PSObject.Properties[$name]) { $config[$name] = $previousConfig.$name }
                }
            }
            New-Item -ItemType Directory -Path (Split-Path -Parent $configPath) -Force | Out-Null
            [System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
            Assert-PhysicalFilePath $configPath
        }
        New-Item -Path $registryPath -Force | Out-Null
        Set-Item -LiteralPath $registryPath -Value $manifestPath
    }
    Write-Output ('Manifest: ' + $manifestPath)
    if ($PrepareOnly) { Write-Output 'Prepared files only; registry unchanged.' }
    else { Write-Output 'Installed for this Windows user. Open PotBridge settings in Edge to verify the connection.' }
}
