param(
  [string]$ModelPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ai\artifacts\chess-coach-grounding.onnx'),
  [string]$PythonPath = '',
  [int]$Port = 8770,
  [int]$ParentProcessId = 0,
  [ValidateSet('auto', 'cpu', 'cuda')]
  [string]$Device = 'cpu',
  [string]$ReadyFile = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$model = [IO.Path]::GetFullPath($ModelPath)
if (!(Test-Path -LiteralPath $model -PathType Leaf)) { throw "Grounding checkpoint was not found at: $model" }

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $pythonCommand = if ($onWindows) { 'python' } else { 'python3' }
  $virtualEnvironmentPython = if ($onWindows) { Join-Path $projectRoot 'ai/.venv/Scripts/python.exe' } else { Join-Path $projectRoot 'ai/.venv/bin/python' }
  $PythonPath = if (Test-Path -LiteralPath $virtualEnvironmentPython -PathType Leaf) {
    $virtualEnvironmentPython
  } else {
    (Get-Command $pythonCommand -ErrorAction Stop).Source
  }
}

$env:PYTHONPATH = Join-Path $projectRoot 'ai'
$arguments = @('-m', 'chess_coach.server', '--model', $model, '--host', '127.0.0.1', '--port', [string]$Port, '--device', $Device)
Write-Host "Starting the local chess grounding service on http://127.0.0.1:$Port/"

if ($ParentProcessId -le 0) {
  if ($ReadyFile) { $arguments += @('--ready-file', $ReadyFile) }
  & $PythonPath @arguments
  exit $LASTEXITCODE
}

$processArguments = @(
  '-m', 'chess_coach.server',
  '--model', ('"{0}"' -f $model),
  '--host', '127.0.0.1',
  '--port', [string]$Port,
  '--device', $Device
)
if ($ReadyFile) { $processArguments += @('--ready-file', ('"{0}"' -f $ReadyFile)) }
$launch = @{ FilePath = $PythonPath; ArgumentList = $processArguments; WorkingDirectory = $projectRoot; PassThru = $true }
if ($onWindows) { $launch.WindowStyle = 'Hidden' }
$service = Start-Process @launch
$becameReady = $false
try {
  while (!$service.HasExited) {
    if ($ReadyFile -and [IO.File]::Exists($ReadyFile)) { $becameReady = $true }
    if (($becameReady -and ![IO.File]::Exists($ReadyFile)) -or !(Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue
      break
    }
    Start-Sleep -Milliseconds 250
    $service.Refresh()
  }
  if ($service.HasExited) { exit $service.ExitCode }
} finally {
  if (!$service.HasExited) { Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue }
  if ($ReadyFile) { [IO.File]::Delete($ReadyFile) }
}
