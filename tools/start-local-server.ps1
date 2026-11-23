param(
  [ValidateRange(1, 65535)][int]$Port = 8787,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$OpenBrowser,
  [switch]$Network,
  [ValidateRange(1, 65535)][int]$BridgePort = 8765,
  [ValidateRange(1, 65535)][int]$RoomPort = 8766,
  [ValidateRange(1, 65535)][int]$GroundingPort = 8770
)

function Send-WebAsset([IO.Stream]$Stream, [string]$RequestLine) {
  $parts = $RequestLine -split ' '
  if ($parts.Length -lt 2 -or $parts[0] -notin @('GET', 'HEAD')) {
    $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 405 Method Not Allowed`r`nAllow: GET, HEAD`r`nContent-Length: 0`r`nConnection: close`r`n`r`n")
    $Stream.Write($header, 0, $header.Length)
    return
  }
  $asset = [Uri]::UnescapeDataString(($parts[1] -split '\?')[0]).TrimStart('/')
  if (!$asset) { $asset = 'index.html' }
  $public = $asset -cin @('index.html', 'styles.css', 'data/openings/openings.json') -or
    $asset -cmatch '^(?:js|CustomChessEngine)/(?:[a-zA-Z0-9_-]+/)*[a-zA-Z0-9_-]+\.js$'
  if ($public -and (Test-Path -LiteralPath (Join-Path $rootPath $asset) -PathType Leaf)) {
    $filePath = Join-Path $rootPath $asset
    $status = '200 OK'
    $contentType = $contentTypes[[IO.Path]::GetExtension($filePath)]
    if ($asset -ceq 'index.html') {
      $html = [IO.File]::ReadAllText($filePath)
      foreach ($service in $servicePorts.Keys) {
        $attribute = "data-$service-port"
        $html = $html -replace ($attribute + '="\d+"'), ('{0}="{1}"' -f $attribute, $servicePorts[$service])
      }
      $bytes = [Text.Encoding]::UTF8.GetBytes($html)
    } else {
      $bytes = [IO.File]::ReadAllBytes($filePath)
    }
  } else {
    $status = '404 Not Found'
    $contentType = 'text/plain; charset=utf-8'
    $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
  }
  $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 $status`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n")
  $Stream.Write($header, 0, $header.Length)
  if ($parts[0] -eq 'GET') { $Stream.Write($bytes, 0, $bytes.Length) }
}

$rootPath = [IO.Path]::GetFullPath($Root)
$bindAddress = if ($Network) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
$listener = [Net.Sockets.TcpListener]::new($bindAddress, $Port)
$listener.ExclusiveAddressUse = $true
$ErrorActionPreference = 'Stop'
$listener.Start()
try {
  $url = "http://127.0.0.1:$Port/"
  Write-Host "Tournament Room is available at $url"
  if ($Network) {
    try {
      $addresses = [Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) |
        Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and !$_.IPAddressToString.StartsWith('127.') }
      foreach ($address in $addresses) { Write-Host "Another device can open http://$($address.IPAddressToString):$Port/" }
    } catch { Write-Warning "For network play, open this computer's LAN address on port $Port." }
  }
  Write-Host "Press Ctrl+C to stop Tournament Room."
  if ($OpenBrowser) {
    try {
      if ([Environment]::OSVersion.Platform -eq [PlatformID]::Win32NT) { Start-Process $url }
      elseif ($IsMacOS) { Start-Process open -ArgumentList $url }
      else { Start-Process xdg-open -ArgumentList $url }
    } catch { Write-Warning "Open $url in your browser." }
  }

  $contentTypes = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8' }
  $servicePorts = @{ bridge = $BridgePort; room = $RoomPort; grounding = $GroundingPort }
  while ($true) {
    if (!$listener.Pending()) { Start-Sleep -Milliseconds 30; continue }
    $client = $listener.AcceptTcpClient()
    $reader = $null
    try {
      $client.ReceiveTimeout = 2000
      $client.SendTimeout = 5000
      $stream = $client.GetStream()
      $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
      $requestLine = $reader.ReadLine()
      if ($null -eq $requestLine) { continue }
      do { $headerLine = $reader.ReadLine() } while ($headerLine)
      Send-WebAsset $stream $requestLine
    } catch [IO.IOException] {
      # Browsers can cancel an in-flight asset request during navigation or reload.
      # That client disconnect must not stop the server for every other client.
      Write-Verbose "Client disconnected before the response completed: $($_.Exception.Message)"
    } catch [Net.Sockets.SocketException] {
      Write-Verbose "Client socket closed before the response completed: $($_.Exception.Message)"
    } finally {
      if ($null -ne $reader) { $reader.Dispose() }
      $client.Dispose()
    }
  }
} finally { $listener.Stop() }
