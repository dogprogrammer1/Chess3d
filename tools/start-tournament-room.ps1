param(
  [int]$WebPort = 8787,
  [int]$BridgePort = 8765,
  [int]$GroundingPort = 8770,
  [string]$CoachModelPath = '',
  [string]$PythonPath = '',
  [switch]$NoGrounding,
  [switch]$NoBrowser
)

# Starts the browser app and its local-only Stockfish sidecar with one command.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$bridgeScript = Join-Path $PSScriptRoot 'start-stockfish-bridge.ps1'
$roomScript = Join-Path $PSScriptRoot 'start-room-relay.ps1'
$serverScript = Join-Path $PSScriptRoot 'start-local-server.ps1'
$groundingScript = Join-Path $PSScriptRoot 'start-grounding-coach.ps1'
$roomPort = 8766
$defaultOnnxModel = Join-Path $projectRoot 'ai\artifacts\chess-coach-grounding.onnx'
$defaultTorchModel = Join-Path $projectRoot 'ai\artifacts\chess-coach-grounding.pt'
$resolvedModel = if (![string]::IsNullOrWhiteSpace($CoachModelPath)) {
  [IO.Path]::GetFullPath($CoachModelPath)
} elseif (Test-Path -LiteralPath $defaultOnnxModel -PathType Leaf) {
  $defaultOnnxModel
} else {
  $defaultTorchModel
}

function Test-PortIsListening([int]$Port) {
  return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port })
}

function Wait-ForPort(
  [int]$Port,
  [string]$Name,
  [int]$TimeoutSeconds = 8,
  [Diagnostics.Process]$Process = $null
) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-PortIsListening $Port) { return }
    if ($null -ne $Process) {
      $Process.Refresh()
      if ($Process.HasExited) { throw "$Name exited before it became ready." }
    }
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
    Wait-ForPort $BridgePort 'The Stockfish bridge' 30 $bridge
    Write-Host "Stockfish bridge started locally on port $BridgePort."
  } catch {
    if (!$bridge.HasExited) { Stop-Process -Id $bridge.Id -Force }
    throw
  }
}

if (Test-PortIsListening $RoomPort) {
  Write-Host "Using the tournament room relay already running on port $RoomPort."
} else {
  $powerShell = Join-Path $PSHOME 'powershell.exe'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $roomScript), '-Port', $RoomPort, '-WebPort', $WebPort, '-ParentProcessId', $PID)
  $roomRelay = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
  try {
    Wait-ForPort $RoomPort 'The tournament room relay' 30 $roomRelay
    Write-Host "Tournament room relay started on the local network."
  } catch {
    if (!$roomRelay.HasExited) { Stop-Process -Id $roomRelay.Id -Force }
    throw
  }
}

if (!$NoGrounding) {
  if (Test-PortIsListening $GroundingPort) {
    Write-Host "Using the grounding service already running on port $GroundingPort."
  } elseif (Test-Path -LiteralPath $resolvedModel -PathType Leaf) {
    $powerShell = Join-Path $PSHOME 'powershell.exe'
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $groundingScript), '-ModelPath', ('"{0}"' -f $resolvedModel), '-Port', $GroundingPort, '-ParentProcessId', $PID)
    if (![string]::IsNullOrWhiteSpace($PythonPath)) { $arguments += @('-PythonPath', ('"{0}"' -f $PythonPath)) }
    $grounding = Start-Process -FilePath $powerShell -ArgumentList $arguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    try {
      Wait-ForPort $GroundingPort 'The grounding service' 30 $grounding
      Write-Host "Grounding checkpoint service started on port $GroundingPort."
    } catch {
      if (!$grounding.HasExited) { Stop-Process -Id $grounding.Id -Force }
      Write-Warning "The neural grounding service did not start. The verified Stockfish coach will continue without it. $($_.Exception.Message)"
    }
  } else {
    Write-Host "Grounding checkpoint not present at $resolvedModel; the verified Stockfish coach remains available."
  }
}

$serverArguments = @{ Port = $WebPort; Root = $projectRoot; Network = $true }
if (!$NoBrowser) { $serverArguments.OpenBrowser = $true }
& $serverScript @serverArguments
