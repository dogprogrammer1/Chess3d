param(
  [Parameter(Mandatory = $true)]
  [string[]]$InputPath,
  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory,
  [int]$Workers = 2,
  [int]$EngineThreads = 2,
  [int]$EngineHashMb = 256,
  [int]$Depth = 12,
  [int]$MultiPv = 3,
  [int]$SampleEvery = 4,
  [int]$MinPly = 8,
  [int]$MaxPly = 120,
  [int]$MaxExamples = 0,
  [string]$EnginePath = '',
  [string]$NodePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($EnginePath)) {
  $EnginePath = Join-Path $projectRoot 'lib\stockfish\stockfish-windows-x86-64-avx2.exe'
}
if (!(Test-Path -LiteralPath $EnginePath -PathType Leaf)) { throw "Stockfish was not found at $EnginePath" }
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) { throw 'Node.js 18 or newer is required. Pass its executable path with -NodePath.' }
  $NodePath = $nodeCommand.Source
}
$nodeVersion = & $NodePath -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 18) { throw 'Node.js 18 or newer is required.' }

$orchestrator = Join-Path $PSScriptRoot 'dataset\parallel-label-coach-dataset.mjs'
$arguments = @($orchestrator)
foreach ($sourcePath in $InputPath) { $arguments += @('--input', $sourcePath) }
$arguments += @(
  '--output-dir', $OutputDirectory,
  '--engine', $EnginePath,
  '--workers', $Workers,
  '--engine-threads', $EngineThreads,
  '--engine-hash', $EngineHashMb,
  '--depth', $Depth,
  '--multipv', $MultiPv,
  '--sample-every', $SampleEvery,
  '--min-ply', $MinPly,
  '--max-ply', $MaxPly
)
if ($MaxExamples -gt 0) { $arguments += @('--max-examples', $MaxExamples) }

Push-Location $projectRoot
try {
  & $NodePath @arguments
  if ($LASTEXITCODE -ne 0) { throw "Parallel labeling exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}

