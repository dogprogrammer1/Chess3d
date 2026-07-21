param(
  [string]$EnginePath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'lib\stockfish\stockfish-windows-x86-64-avx2.exe'),
  [int]$Port = 8765,
  [int]$ParentProcessId = 0
)

# Local-only UCI bridge. Browsers cannot launch a Windows executable directly;
# this script owns Stockfish and accepts WebSocket messages only on loopback.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (!(Test-Path -LiteralPath $EnginePath -PathType Leaf)) { throw "Stockfish executable was not found at: $EnginePath" }

function Read-Exact([IO.Stream]$Stream, [int]$Count) {
  $buffer = New-Object byte[] $Count
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -le 0) { throw 'Client disconnected.' }
    $offset += $read
  }
  return ,$buffer
}
function Read-HttpRequest([Net.Sockets.TcpClient]$Client) {
  $stream = $Client.GetStream()
  $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
  $firstLine = $reader.ReadLine()
  $headers = @{}
  while ($line = $reader.ReadLine()) {
    $separator = $line.IndexOf(':')
    if ($separator -gt 0) { $headers[$line.Substring(0, $separator).ToLowerInvariant()] = $line.Substring($separator + 1).Trim() }
  }
  return @{ FirstLine = $firstLine; Headers = $headers; Stream = $stream }
}
function Start-WebSocket([Net.Sockets.TcpClient]$Client) {
  $request = Read-HttpRequest $Client
  $key = $request.Headers['sec-websocket-key']
  if ([string]::IsNullOrWhiteSpace($request.FirstLine) -or !$request.FirstLine.StartsWith('GET ') -or [string]::IsNullOrWhiteSpace($key)) { throw 'A WebSocket upgrade request is required.' }
  $magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try { $accept = [Convert]::ToBase64String($sha1.ComputeHash([Text.Encoding]::ASCII.GetBytes($key + $magic))) } finally { $sha1.Dispose() }
  $reply = "HTTP/1.1 101 Switching Protocols`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Accept: $accept`r`n`r`n"
  $bytes = [Text.Encoding]::ASCII.GetBytes($reply)
  $request.Stream.Write($bytes, 0, $bytes.Length)
  return $request.Stream
}
function Receive-WebSocketText([IO.Stream]$Stream) {
  $first = (Read-Exact $Stream 1)[0]
  $second = (Read-Exact $Stream 1)[0]
  $opcode = $first -band 0x0f
  if ($opcode -eq 8) { return $null }
  if ($opcode -ne 1) { throw 'Only text WebSocket messages are supported.' }
  if (($second -band 0x80) -eq 0) { throw 'Client WebSocket frames must be masked.' }
  [int64]$length = $second -band 0x7f
  if ($length -eq 126) { $size = Read-Exact $Stream 2; $length = [int64]$size[0] * 256 + $size[1] }
  elseif ($length -eq 127) {
    $size = Read-Exact $Stream 8; $length = 0
    foreach ($part in $size) { $length = $length * 256 + $part }
  }
  if ($length -gt 65535) { throw 'Request message is too large.' }
  $mask = Read-Exact $Stream 4
  $payload = Read-Exact $Stream ([int]$length)
  for ($index = 0; $index -lt $payload.Length; $index += 1) { $payload[$index] = $payload[$index] -bxor $mask[$index % 4] }
  return [Text.Encoding]::UTF8.GetString($payload)
}
function Send-WebSocketText([IO.Stream]$Stream, [string]$Text) {
  $payload = [Text.Encoding]::UTF8.GetBytes($Text)
  $header = [Collections.Generic.List[byte]]::new()
  [void]$header.Add(0x81)
  if ($payload.Length -lt 126) { [void]$header.Add([byte]$payload.Length) }
  else { [void]$header.Add(126); [void]$header.Add([byte]($payload.Length -shr 8)); [void]$header.Add([byte]($payload.Length -band 0xff)) }
  $head = $header.ToArray()
  $Stream.Write($head, 0, $head.Length); $Stream.Write($payload, 0, $payload.Length)
}
function Send-BridgeJson([IO.Stream]$Stream, $Object) { Send-WebSocketText $Stream ($Object | ConvertTo-Json -Compress -Depth 6) }
function Test-ParentIsRunning {
  if ($ParentProcessId -le 0) { return $true }
  try { return !(Get-Process -Id $ParentProcessId -ErrorAction Stop).HasExited } catch { return $false }
}

$processInfo = [Diagnostics.ProcessStartInfo]::new()
$processInfo.FileName = $EnginePath
$processInfo.UseShellExecute = $false
$processInfo.RedirectStandardInput = $true
$processInfo.RedirectStandardOutput = $true
$processInfo.CreateNoWindow = $true
$engine = [Diagnostics.Process]::new()
$engine.StartInfo = $processInfo
if (!$engine.Start()) { throw 'Could not start Stockfish.' }

function Send-Uci([string]$Command) { $engine.StandardInput.WriteLine($Command); $engine.StandardInput.Flush() }
function Read-Until([string]$Expected) { while (!$engine.HasExited) { if ($engine.StandardOutput.ReadLine() -eq $Expected) { return } }; throw "Stockfish closed while waiting for $Expected" }
function Search-Position([string]$Fen, [int]$Depth, [int]$MultiPv = 1) {
  $fenParts = $Fen -split ' '
  $validFen = $Fen -notmatch "[\r\n]" -and $fenParts.Count -eq 6 -and $fenParts[1] -match '^[wb]$' -and $fenParts[2] -match '^(?:-|[KQkq]+)$' -and $fenParts[3] -match '^(?:-|[a-h][36])$' -and $fenParts[4] -match '^\d+$' -and $fenParts[5] -match '^\d+$'
  $ranks = $fenParts[0] -split '/'
  if ($ranks.Count -ne 8) { $validFen = $false }
  foreach ($rank in $ranks) {
    if ($rank -notmatch '^[prnbqkPRNBQK1-8]+$') { $validFen = $false; continue }
    $squareCount = 0
    foreach ($character in $rank.ToCharArray()) { $squareCount += if ($character -match '[1-8]') { [int]::Parse([string]$character) } else { 1 } }
    if ($squareCount -ne 8) { $validFen = $false }
  }
  if (!$validFen) { throw 'Invalid FEN.' }
  $safeDepth = [Math]::Max(1, [Math]::Min(30, $Depth))
  $safeMultiPv = [Math]::Max(1, [Math]::Min(5, $MultiPv))
  Send-Uci "setoption name MultiPV value $safeMultiPv"
  Send-Uci "position fen $Fen"
  Send-Uci "go depth $safeDepth"
  $lines = @{}
  $bestMove = '(none)'
  while (!$engine.HasExited) {
    $line = $engine.StandardOutput.ReadLine()
    if ($line -match '^info ' -and $line -match '\bdepth (\d+)' -and $line -match '\bscore (cp|mate) (-?\d+)' -and $line -match '\bpv (.+)$') {
      $reportedDepth = [int]([regex]::Match($line, '\bdepth (\d+)').Groups[1].Value)
      $scoreMatch = [regex]::Match($line, '\bscore (cp|mate) (-?\d+)')
      $rankMatch = [regex]::Match($line, '\bmultipv (\d+)')
      $nodesMatch = [regex]::Match($line, '\bnodes (\d+)')
      $wdlMatch = [regex]::Match($line, '\bwdl (\d+) (\d+) (\d+)')
      $pvMatch = [regex]::Match($line, '\bpv (.+)$')
      $rank = if ($rankMatch.Success) { [int]$rankMatch.Groups[1].Value } else { 1 }
      $candidate = @{
        rank = $rank
        scoreType = $scoreMatch.Groups[1].Value
        score = [int]$scoreMatch.Groups[2].Value
        pv = $pvMatch.Groups[1].Value
        nodes = if ($nodesMatch.Success) { [int64]$nodesMatch.Groups[1].Value } else { 0 }
        depth = $reportedDepth
        wdl = if ($wdlMatch.Success) { @([int]$wdlMatch.Groups[1].Value, [int]$wdlMatch.Groups[2].Value, [int]$wdlMatch.Groups[3].Value) } else { @() }
      }
      if (!$lines.ContainsKey($rank) -or $reportedDepth -ge $lines[$rank].depth) { $lines[$rank] = $candidate }
    }
    if ($line -match '^bestmove (\S+)') { $bestMove = $Matches[1]; break }
  }
  $orderedLines = @($lines.Values | Sort-Object rank)
  $top = if ($orderedLines.Count) { $orderedLines[0] } else { @{ scoreType = 'cp'; score = 0; pv = ''; nodes = 0; depth = 0; wdl = @() } }
  return @{ scoreType = $top.scoreType; score = $top.score; pv = $top.pv; nodes = $top.nodes; depth = $top.depth; wdl = $top.wdl; lines = $orderedLines; move = $bestMove }
}

Send-Uci 'uci'; Read-Until 'uciok'; Send-Uci 'setoption name UCI_ShowWDL value true'; Send-Uci 'isready'; Read-Until 'readyok'
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
$listener.Start()
Write-Host "Stockfish bridge running at ws://127.0.0.1:$Port/ (local connections only)"
try {
  while (Test-ParentIsRunning) {
    while (!$listener.Pending()) {
      if (!(Test-ParentIsRunning)) { return }
      Start-Sleep -Milliseconds 100
    }
    $client = $listener.AcceptTcpClient()
    try {
      $stream = Start-WebSocket $client
      while ($client.Connected) {
        $rawRequest = Receive-WebSocketText $stream
        if ($null -eq $rawRequest) { break }
        $request = $rawRequest | ConvertFrom-Json
        try {
          if ($request.type -notin @('analyse', 'move')) { throw 'Unsupported request.' }
          $requestedMultiPv = if ($request.type -eq 'analyse' -and $request.PSObject.Properties['multiPv']) { [int]$request.multiPv } else { 1 }
          $result = Search-Position ([string]$request.fen) ([int]$request.depth) $requestedMultiPv
          $message = @{ type = if ($request.type -eq 'move') { 'bestmove' } else { 'analysis' }; requestId = $request.requestId; fen = $request.fen; scoreType = $result.scoreType; score = $result.score; pv = $result.pv; nodes = $result.nodes; depth = $result.depth; wdl = $result.wdl; lines = $result.lines; move = $result.move }
          Send-BridgeJson $stream $message
        } catch { Send-BridgeJson $stream @{ type = 'error'; requestId = $request.requestId; message = $_.Exception.Message } }
      }
    } catch { Write-Warning "Bridge client error: $($_.Exception.Message)" }
    finally { $client.Close() }
  }
} finally {
  $listener.Stop()
  if (!$engine.HasExited) { $engine.Kill() }
  $engine.Dispose()
}
