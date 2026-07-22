param(
  [string]$Month = '2013-01',
  [int]$MaxGames = 2000,
  [int]$MinRating = 1600,
  [int]$MinPlies = 12,
  [int]$Seed = 20260721,
  [string]$ArchivePath = '',
  [string]$OutputPath = '',
  [string]$NodePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$importer = Join-Path $PSScriptRoot 'dataset\fetch-lichess-sample.mjs'
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($null -eq $nodeCommand) {
    throw 'Node.js 24 or newer is required. Pass its executable path with -NodePath.'
  }
  $NodePath = $nodeCommand.Source
}

$nodeVersion = & $NodePath -p "Number(process.versions.node.split('.')[0])"
if ($LASTEXITCODE -ne 0 -or [int]$nodeVersion -lt 24) {
  throw 'Node.js 24 or newer is required for streaming .zst archives.'
}

$arguments = @(
  $importer,
  '--month', $Month,
  '--max-games', $MaxGames,
  '--min-rating', $MinRating,
  '--min-plies', $MinPlies,
  '--seed', $Seed
)
if (![string]::IsNullOrWhiteSpace($ArchivePath)) { $arguments += @('--archive', $ArchivePath) }
if (![string]::IsNullOrWhiteSpace($OutputPath)) { $arguments += @('--output', $OutputPath) }

Push-Location $projectRoot
try {
  & $NodePath @arguments
  if ($LASTEXITCODE -ne 0) { throw "The Lichess importer exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}

