param(
  [string]$SamplePath = '',
  [string]$OutputPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SamplePath)) {
  $SamplePath = Join-Path $projectRoot 'datasets\lichess\lichess_db_standard_rated_2013-01-sample.pgn'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
  $OutputPath = Join-Path $projectRoot 'datasets\runpod\chess-coach-runpod-bundle.tar.gz'
}
$SamplePath = [IO.Path]::GetFullPath($SamplePath)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
if (!(Test-Path -LiteralPath $SamplePath -PathType Leaf)) { throw "Sample PGN was not found: $SamplePath" }
if (!$SamplePath.StartsWith($projectRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The sample must be inside the project so its bundle path is deterministic.'
}
$tar = Get-Command tar.exe -ErrorAction SilentlyContinue
if ($null -eq $tar) { throw 'tar.exe is required to prepare the RunPod bundle.' }

$outputDirectory = Split-Path -Parent $OutputPath
[IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
$relativeSample = $SamplePath.Substring($projectRoot.Length).TrimStart([char[]]'\/')

Push-Location $projectRoot
try {
  & $tar.Source -czf $OutputPath 'ai' 'js' 'tools' 'README.md' $relativeSample
  if ($LASTEXITCODE -ne 0) { throw "tar.exe exited with code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$archive = Get-Item -LiteralPath $OutputPath
$checksum = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{
  Path = $archive.FullName
  Bytes = $archive.Length
  Sha256 = $checksum
}
