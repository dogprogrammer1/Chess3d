param(
  [ValidateRange(1, 65535)][int]$WebPort = 8787,
  [ValidateRange(1, 65535)][int]$BridgePort = 8765,
  [ValidateRange(1, 65535)][int]$GroundingPort = 8770,
  [string]$CoachModelPath = '',
  [string]$PythonPath = '',
  [switch]$NoGrounding,
  [switch]$NoBrowser,
  [ValidateRange(1, 65535)][int]$RoomPort = 8766,
  [string]$EnginePath = '',
  [switch]$WebOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$onWindows = [Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT
$shellName = if ($PSVersionTable.PSEdition -eq 'Desktop') { 'powershell.exe' } elseif ($onWindows) { 'pwsh.exe' } else { 'pwsh' }
$shellPath = Join-Path $PSHOME $shellName
$ownedServices = [Collections.Generic.List[object]]::new()

function Test-PortInUse([int]$Port, [Net.IPAddress]$Address = [Net.IPAddress]::Loopback) {
  $probe = [Net.Sockets.TcpListener]::new($Address, $Port)
  $probe.ExclusiveAddressUse = $true
  try {
    $probe.Start()
    return $false
  } catch [Net.Sockets.SocketException] {
    if ($_.Exception.SocketErrorCode -in @('AddressAlreadyInUse', 'AccessDenied')) { return $true }
    throw
  } finally { $probe.Stop() }
}

function Stop-OwnedService($Service) {
  $child = $Service.Process
  if ([IO.File]::Exists($Service.ReadyFile)) {
    [IO.File]::Delete($Service.ReadyFile)
    if ($child.WaitForExit(1500)) { return }
  }
  if ($child.HasExited) { return }
  # Also stop a native child when a search or model load outlasts the grace period.
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    & taskkill.exe /PID $child.Id /T /F | Out-Null
  } else {
    $child.Kill($true)
  }
  if (!$child.WaitForExit(3000)) { throw "Service $($child.Id) is still running." }
}

function Start-OptionalService([string]$Name, [string]$Script, [int]$Port, [string[]]$Options) {
  $service = $null
  $readyFile = Join-Path ([IO.Path]::GetTempPath()) ("chess3d-" + [Guid]::NewGuid() + ".ready")
  try {
    $scriptPath = Join-Path $PSScriptRoot $Script
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $scriptPath), '-Port', $Port,
      '-ParentProcessId', $PID, '-ReadyFile', ('"{0}"' -f $readyFile)) + $Options
    $launch = @{ FilePath = $shellPath; ArgumentList = $arguments; WorkingDirectory = $projectRoot; PassThru = $true }
    if ($onWindows) { $launch.WindowStyle = 'Hidden' }
    $child = Start-Process @launch
    $service = [PSCustomObject]@{ Process = $child; ReadyFile = $readyFile }
    $ownedServices.Add($service)
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (!(Test-Path -LiteralPath $readyFile -PathType Leaf)) {
      if ($child.HasExited) { throw "Service exited with code $($child.ExitCode)." }
      if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for port $Port." }
      Start-Sleep -Milliseconds 100
    }
    Write-Host "$Name ready on port $Port."
    return $true
  } catch {
    $reason = $_.Exception.Message
    if ($null -ne $service) {
      try { Stop-OwnedService $service } catch { Write-Warning $_.Exception.Message }
    }
    Write-Warning "$Name unavailable. $reason The browser engine is available."
    return $false
  }
}

$webAddress = if ($WebOnly) { [Net.IPAddress]::Loopback } else { [Net.IPAddress]::Any }
if (Test-PortInUse $WebPort $webAddress) { throw "Web port $WebPort is in use. Close the other server or pass -WebPort with a free port." }
if (!$WebOnly) {
  $ports = @($WebPort, $BridgePort, $RoomPort)
  if (!$NoGrounding) { $ports += $GroundingPort }
  if (@($ports | Sort-Object -Unique).Count -ne $ports.Count) { throw 'Choose a distinct port for each service.' }
}

try {
  $network = $false
  if (!$WebOnly) {
    if (!$EnginePath) {
      $bundled = Join-Path $projectRoot 'lib/stockfish/stockfish-windows-x86-64-avx2.exe'
      if ($onWindows -and (Test-Path -LiteralPath $bundled -PathType Leaf)) {
        $EnginePath = $bundled
      } else {
        $command = Get-Command stockfish -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $EnginePath = $command.Source }
      }
    }
    if (Test-PortInUse $BridgePort) {
      Write-Host "Port $BridgePort is occupied. Skipping Stockfish startup and leaving the existing listener available to the app."
    } elseif (!$EnginePath -or !(Test-Path -LiteralPath $EnginePath -PathType Leaf)) {
      Write-Warning 'Stockfish was not found. Use -EnginePath to supply a native executable.'
    } elseif ((Get-Item -LiteralPath $EnginePath).Length -lt 256 -and (Select-String -LiteralPath $EnginePath -SimpleMatch 'git-lfs.github.com/spec' -Quiet)) {
      Write-Warning 'The bundled Stockfish file is a Git LFS pointer. Run git lfs pull to download the engine.'
    } else {
      $nativeEngine = (Get-Item -LiteralPath $EnginePath).FullName
      [void](Start-OptionalService 'Stockfish bridge' 'start-stockfish-bridge.ps1' $BridgePort @('-EnginePath', ('"{0}"' -f $nativeEngine)))
    }
    if (Test-PortInUse $RoomPort ([Net.IPAddress]::Any)) {
      Write-Host "Port $RoomPort is occupied. The app will try the existing listener for LAN rooms."
      $network = $true
    } else {
      $network = Start-OptionalService 'LAN room relay' 'start-room-relay.ps1' $RoomPort @('-WebPort', $WebPort)
    }

    if (!$NoGrounding) {
      if (!$CoachModelPath) {
        foreach ($file in @('chess-coach-grounding.onnx', 'chess-coach-grounding.pt')) {
          $candidate = Join-Path $projectRoot "ai/artifacts/$file"
          if (Test-Path -LiteralPath $candidate -PathType Leaf) { $CoachModelPath = $candidate; break }
        }
      }
      if (Test-PortInUse $GroundingPort) {
        Write-Host "Port $GroundingPort is occupied. The app will try the existing listener for neural coaching."
      } elseif ($CoachModelPath -and (Test-Path -LiteralPath $CoachModelPath -PathType Leaf)) {
        $options = @('-ModelPath', ('"{0}"' -f (Get-Item -LiteralPath $CoachModelPath).FullName))
        if ($PythonPath) { $options += @('-PythonPath', ('"{0}"' -f $PythonPath)) }
        [void](Start-OptionalService 'Neural coach' 'start-grounding-coach.ps1' $GroundingPort $options)
      } else {
        Write-Host 'No neural checkpoint found. Stockfish coaching can run independently.'
      }
    }
  }
  & (Join-Path $PSScriptRoot 'start-local-server.ps1') -Root $projectRoot -Port $WebPort -BridgePort $BridgePort -RoomPort $RoomPort -GroundingPort $GroundingPort -Network:$network -OpenBrowser:(!$NoBrowser)
} finally {
  foreach ($service in $ownedServices) {
    try { Stop-OwnedService $service } catch { Write-Warning $_.Exception.Message }
    $service.Process.Dispose()
  }
}
