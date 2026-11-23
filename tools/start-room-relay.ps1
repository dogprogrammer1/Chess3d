param(
  [int]$Port = 8766,
  [int]$WebPort = 8787,
  [int]$ParentProcessId = 0,
  [string]$ReadyFile = ''
)

# A tiny local-network WebSocket relay. It never interprets chess state; it
# pairs two browsers by room code and forwards their small JSON messages.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
  $origin = $request.Headers['origin']
  $originUri = if ($origin) { [Uri]$origin } else { $null }
  $validOrigin = $originUri -and $originUri.Port -eq $WebPort -and $originUri.Scheme -eq 'http'
  if ([string]::IsNullOrWhiteSpace($request.FirstLine) -or !$request.FirstLine.StartsWith('GET ') -or [string]::IsNullOrWhiteSpace($key) -or !$validOrigin) {
    throw 'A Tournament Room WebSocket request is required.'
  }
  $sha1 = [Security.Cryptography.SHA1]::Create()
  try {
    $magic = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
    $accept = [Convert]::ToBase64String($sha1.ComputeHash([Text.Encoding]::ASCII.GetBytes($key + $magic)))
  } finally { $sha1.Dispose() }
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
  if (($second -band 0x80) -eq 0) { throw 'Client frames must be masked.' }
  [int64]$length = $second -band 0x7f
  if ($length -eq 126) {
    $size = Read-Exact $Stream 2
    $length = [int64]$size[0] * 256 + $size[1]
  } elseif ($length -eq 127) {
    $size = Read-Exact $Stream 8
    $length = 0
    foreach ($part in $size) { $length = $length * 256 + $part }
  }
  if ($length -gt 16384) { throw 'Room message is too large.' }
  $mask = Read-Exact $Stream 4
  $payload = Read-Exact $Stream ([int]$length)
  for ($index = 0; $index -lt $payload.Length; $index += 1) {
    $payload[$index] = $payload[$index] -bxor $mask[$index % 4]
  }
  return [Text.Encoding]::UTF8.GetString($payload)
}

function Send-WebSocketText($ClientState, [string]$Text) {
  $payload = [Text.Encoding]::UTF8.GetBytes($Text)
  $header = [Collections.Generic.List[byte]]::new()
  [void]$header.Add(0x81)
  if ($payload.Length -lt 126) {
    [void]$header.Add([byte]$payload.Length)
  } else {
    [void]$header.Add(126)
    [void]$header.Add([byte]($payload.Length -shr 8))
    [void]$header.Add([byte]($payload.Length -band 0xff))
  }
  $head = $header.ToArray()
  $ClientState.Stream.Write($head, 0, $head.Length)
  $ClientState.Stream.Write($payload, 0, $payload.Length)
}

function Send-RoomState($ClientState, [bool]$Ready, [string]$ErrorMessage = '') {
  $message = @{ type = 'room-state'; room = $ClientState.Room; seat = $ClientState.Role; ready = $Ready }
  if ($ErrorMessage) { $message.error = $ErrorMessage }
  Send-WebSocketText $ClientState ($message | ConvertTo-Json -Compress)
}

function Test-ParentIsRunning {
  if ($ReadyFile -and ![IO.File]::Exists($ReadyFile)) { return $false }
  if ($ParentProcessId -le 0) { return $true }
  try { return !(Get-Process -Id $ParentProcessId -ErrorAction Stop).HasExited } catch { return $false }
}

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $Port)
$listener.ExclusiveAddressUse = $true
$clients = [Collections.ArrayList]::new()
$listener.Start()
Write-Host "Tournament room relay listening on the local network at port $Port."

try {
  if ($ReadyFile) { [IO.File]::WriteAllText($ReadyFile, 'ready') }
  while (Test-ParentIsRunning) {
    if ($listener.Pending()) {
      $tcp = $listener.AcceptTcpClient()
      try {
        $tcp.ReceiveTimeout = 3000
        $tcp.SendTimeout = 3000
        $stream = Start-WebSocket $tcp
        $state = [PSCustomObject]@{ Tcp = $tcp; Stream = $stream; Room = ''; Role = '' }
        [void]$clients.Add($state)
      } catch {
        $tcp.Close()
        Write-Warning "Rejected room connection: $($_.Exception.Message)"
      }
    }

    foreach ($client in @($clients)) {
      try {
        if (!$client.Stream.DataAvailable) {
          if ($client.Tcp.Client.Poll(0, [Net.Sockets.SelectMode]::SelectRead)) { throw 'Client disconnected.' }
          continue
        }
        $raw = Receive-WebSocketText $client.Stream
        if ($null -eq $raw) { throw 'Client closed the room.' }
        if (!$client.Room) {
          $join = $raw | ConvertFrom-Json
          $room = ([string]$join.room).ToUpperInvariant()
          $role = [string]$join.role
          if ($join.type -ne 'join' -or $room -notmatch '^[A-Z2-9]{6}$' -or $role -notin @('host', 'guest')) {
            Send-RoomState $client $false 'Invalid room request.'
            throw 'Invalid room request.'
          }
          $members = @($clients | Where-Object { $_.Room -eq $room })
          if ($role -eq 'host' -and $members.Count -gt 0) {
            Send-RoomState $client $false 'That room code is already in use.'
            throw 'Room already exists.'
          }
          if ($role -eq 'guest' -and ($members.Count -ne 1 -or $members[0].Role -ne 'host')) {
            Send-RoomState $client $false 'No host is waiting in that room.'
            throw 'Host not found.'
          }
          $client.Room = $room
          $client.Role = $role
          $members = @($clients | Where-Object { $_.Room -eq $room })
          $ready = $members.Count -eq 2
          foreach ($member in $members) { Send-RoomState $member $ready }
        } else {
          foreach ($peer in @($clients | Where-Object { $_.Room -eq $client.Room -and $_ -ne $client })) {
            Send-WebSocketText $peer $raw
          }
        }
      } catch {
        $room = $client.Room
        $client.Tcp.Close()
        [void]$clients.Remove($client)
        if ($room) {
          $left = '{"type":"peer-left"}'
          foreach ($peer in @($clients | Where-Object { $_.Room -eq $room })) { Send-WebSocketText $peer $left }
        }
      }
    }
    Start-Sleep -Milliseconds 10
  }
} finally {
  foreach ($client in @($clients)) { $client.Tcp.Close() }
  $listener.Stop()
  if ($ReadyFile) { [IO.File]::Delete($ReadyFile) }
}
