[CmdletBinding(SupportsShouldProcess = $true)]
param([switch]$KeepSettings)
$ErrorActionPreference = 'Stop'
$hostName = 'com.potbridge.host'
$registryPath = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\' + $hostName
if (-not (Test-Path -LiteralPath $registryPath)) { Write-Output 'PotBridge native host is not registered.'; return }
$manifestPath = [string](Get-Item -LiteralPath $registryPath).GetValue('')
if ($PSCmdlet.ShouldProcess($registryPath, 'Unregister PotBridge native host for current user')) {
    Remove-Item -LiteralPath $registryPath
    # Only delete exact files in our standard directory, never a path read from manifest JSON.
    $knownRoot = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PotBridge'))
    $knownNative = Join-Path $knownRoot 'native'
    $expectedManifest = Join-Path $knownNative ($hostName + '.json')
    if ([System.IO.Path]::GetFullPath($manifestPath) -eq $expectedManifest) {
        foreach ($file in @($expectedManifest, (Join-Path $knownNative 'potbridge.exe'))) {
            if (Test-Path -LiteralPath $file -PathType Leaf) {
                try { Remove-Item -LiteralPath $file -ErrorAction Stop }
                catch { Write-Warning ('Could not remove ' + $file + '. Stop playback, close Edge and remove this file manually.') }
            }
        }
    } else { Write-Output ('Custom installation retained for manual cleanup: ' + $manifestPath) }
    $configPath = Join-Path $knownRoot 'config.json'
    if (-not $KeepSettings -and (Test-Path -LiteralPath $configPath -PathType Leaf)) { Remove-Item -LiteralPath $configPath }
    Write-Output 'Native host unregistered. Remove the Edge extension separately. PotPlayer files are untouched.'
    if ($KeepSettings) { Write-Output 'Settings retained as requested.' }
}
