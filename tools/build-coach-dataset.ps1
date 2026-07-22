param(
  [Parameter(Mandatory = $true)]
  [string[]]$InputPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputPath,
  [int]$Depth = 12,
  [int]$MultiPv = 3,
  [int]$SampleEvery = 4,
  [int]$MinPly = 8,
  [int]$MaxPly = 120,
  [int]$MaxGames = 2147483647,
  [int]$MaxExamples = 2147483647,
  [int]$BridgePort = 8765,
  [string]$EnginePath = '',
  [string]$NodePath = '',
  [switch]$Resume,
  [switch]$Strict,
  [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$defaultEnginePath = Join-Path $projectRoot 'lib\stockfish\stockfish-windows-x86-64-avx2.exe'
if ([string]::IsNullOrWhiteSpace($EnginePath)) { $EnginePath = $defaultEnginePath }
$bridgeScript = Join-Path $PSScriptRoot 'start-stockfish-bridge.ps1'
$generator = Join-Path $PSScriptRoot 'dataset\generate-coach-dataset.mjs'

function Test-PortIsListening([int]$Port) {
  return [bool]([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
    Where-Object { $_.Port -eq $Port })
}

function Wait-ForPort([int]$Port) {
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (Test-PortIsListening $Port) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "The Stockfish bridge did not start listening on port $Port."
}

if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) { throw 'Node.js 22 or newer is required. Pass its executable path with -NodePath.' }
  $NodePath = $nodeCommand.Source
}

$nodeVersion = & $NodePath -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 22) { throw 'Node.js 22 or newer is required for the dataset builder.' }

$bridge = $null
try {
  if (!$DryRun -and !(Test-PortIsListening $BridgePort)) {
    $powerShell = Join-Path $PSHOME 'powershell.exe'
    $bridgeArguments = @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $bridgeScript),
      '-EnginePath', ('"{0}"' -f $EnginePath), '-Port', $BridgePort, '-ParentProcessId', $PID
    )
    $bridge = Start-Process -FilePath $powerShell -ArgumentList $bridgeArguments -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru
    Wait-ForPort $BridgePort
  }

  $generatorArguments = @($generator)
  foreach ($sourcePath in $InputPath) { $generatorArguments += @('--input', $sourcePath) }
  $generatorArguments += @(
    '--output', $OutputPath,
    '--bridge', "ws://127.0.0.1:$BridgePort/",
    '--depth', $Depth,
    '--multipv', $MultiPv,
    '--sample-every', $SampleEvery,
    '--min-ply', $MinPly,
    '--max-ply', $MaxPly,
    '--max-games', $MaxGames,
    '--max-examples', $MaxExamples
  )
  if ($Resume) { $generatorArguments += '--resume' }
  if ($Strict) { $generatorArguments += '--strict' }
  if ($DryRun) { $generatorArguments += '--dry-run' }
  & $NodePath @generatorArguments
  if ($LASTEXITCODE -ne 0) { throw "The dataset builder exited with code $LASTEXITCODE." }
} finally {
  if ($null -ne $bridge -and !$bridge.HasExited) { Stop-Process -Id $bridge.Id -Force }
}
