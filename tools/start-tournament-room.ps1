param(
  [int]$WebPort = 8787,
  [int]$BridgePort = 8765,
  [switch]$NoBrowser
)

# Starts the browser app and its local-only Stockfish sidecar with one command.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeScript = Join-Path $PSScriptRoot 'start-stockfish-bridge.ps1'
$serverScript = Join-Path $PSScriptRoot 'start-local-server.ps1'

function Test-PortIsListening([int]$Port) {
  return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port })
}

function Wait-ForPort([int]$Port, [string]$Name) {
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-PortIsListening $Port) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "$Name did not start listening on port $Port."
}

if (Test-PortIsListening $BridgePort) {
  Write-Host "Using the Stockfish bridge already running on port $BridgePort."
} else {
  $powerShell = Join-Path $PSHOME 'powershell.exe'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $bridgeScript), '-Port', $BridgePort, '-ParentProcessId', $PID)
  $bridge = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  try {
    Wait-ForPort $BridgePort 'The Stockfish bridge'
    Write-Host "Stockfish bridge started locally on port $BridgePort."
  } catch {
    if (!$bridge.HasExited) { Stop-Process -Id $bridge.Id -Force }
    throw
  }
}

$serverArguments = @{ Port = $WebPort; Root = $projectRoot }
if (!$NoBrowser) { $serverArguments.OpenBrowser = $true }
& $serverScript @serverArguments
