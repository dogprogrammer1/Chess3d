param(
  [string]$ModelPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'ai\artifacts\chess-coach-grounding.onnx'),
  [string]$PythonPath = '',
  [int]$Port = 8770,
  [int]$ParentProcessId = 0,
  [ValidateSet('auto', 'cpu', 'cuda')]
  [string]$Device = 'cpu'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$model = [IO.Path]::GetFullPath($ModelPath)
if (!(Test-Path -LiteralPath $model -PathType Leaf)) { throw "Grounding checkpoint was not found at: $model" }

if ([string]::IsNullOrWhiteSpace($PythonPath)) {
  $virtualEnvironmentPython = Join-Path $projectRoot 'ai\.venv\Scripts\python.exe'
  $PythonPath = if (Test-Path -LiteralPath $virtualEnvironmentPython -PathType Leaf) {
    $virtualEnvironmentPython
  } else {
    (Get-Command python -ErrorAction Stop).Source
  }
}

$env:PYTHONPATH = Join-Path $projectRoot 'ai'
$arguments = @('-m', 'chess_coach.server', '--model', $model, '--host', '127.0.0.1', '--port', [string]$Port, '--device', $Device)
Write-Host "Starting the local chess grounding service on http://127.0.0.1:$Port/"

if ($ParentProcessId -le 0) {
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
$service = Start-Process -FilePath $PythonPath -ArgumentList $processArguments -WorkingDirectory $projectRoot -NoNewWindow -PassThru
try {
  while (!$service.HasExited) {
    if (!(Get-Process -Id $ParentProcessId -ErrorAction SilentlyContinue)) {
      Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue
      break
    }
    Start-Sleep -Milliseconds 250
    $service.Refresh()
  }
  if ($service.HasExited) { exit $service.ExitCode }
} finally {
  if (!$service.HasExited) { Stop-Process -Id $service.Id -Force -ErrorAction SilentlyContinue }
}
