param(
  [int]$Port = 8787,
  [string]$Root = (Split-Path -Parent $PSScriptRoot),
  [switch]$OpenBrowser,
  [switch]$Network
)

$rootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar)
$bindAddress = if ($Network) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
$listener = [Net.Sockets.TcpListener]::new($bindAddress, $Port)
$listener.Start()
Write-Host "Tournament Room is available at http://127.0.0.1:$Port/"
if ($Network) {
  $addresses = [Net.Dns]::GetHostAddresses([Net.Dns]::GetHostName()) |
    Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and !$_.IPAddressToString.StartsWith('127.') }
  foreach ($address in $addresses) { Write-Host "Another device can open http://$($address.IPAddressToString):$Port/" }
}
Write-Host "Press Ctrl+C to stop the local web server."
if ($OpenBrowser) { Start-Process "http://127.0.0.1:$Port/" }

$contentTypes = @{ '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'; '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.ico' = 'image/x-icon' }
try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    do { $headerLine = $reader.ReadLine() } while ($headerLine)
    $requestParts = $requestLine -split ' '
    $relativePath = if ($requestParts.Length -gt 1) { [Uri]::UnescapeDataString(($requestParts[1] -split '\?')[0].TrimStart('/')).Replace('/', [IO.Path]::DirectorySeparatorChar) } else { '' }
    if ([string]::IsNullOrWhiteSpace($relativePath)) { $relativePath = 'index.html' }
    $webPath = $relativePath.Replace([IO.Path]::DirectorySeparatorChar, '/')
    $allowedAsset = $webPath -in @('index.html', 'styles.css') -or
      (($webPath.StartsWith('js/') -or $webPath.StartsWith('CustomChessEngine/')) -and $webPath.EndsWith('.js'))
    $serveRoot = $rootPath
    $serveRelative = $relativePath
    $filePath = [IO.Path]::GetFullPath((Join-Path $serveRoot $serveRelative))
    $insideRoot = $filePath.StartsWith($serveRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    if (!$allowedAsset -or !$insideRoot -or !(Test-Path -LiteralPath $filePath -PathType Leaf)) {
      $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
      $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 404 Not Found`r`nContent-Type: text/plain; charset=utf-8`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
      $stream.Write($header, 0, $header.Length); $stream.Write($bytes, 0, $bytes.Length); $client.Close()
      continue
    }
    $extension = [IO.Path]::GetExtension($filePath).ToLowerInvariant()
    $contentType = if ($contentTypes.ContainsKey($extension)) { $contentTypes[$extension] } else { 'application/octet-stream' }
    $bytes = [IO.File]::ReadAllBytes($filePath)
    $header = [Text.Encoding]::ASCII.GetBytes("HTTP/1.1 200 OK`r`nContent-Type: $contentType`r`nContent-Length: $($bytes.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n")
    $stream.Write($header, 0, $header.Length); $stream.Write($bytes, 0, $bytes.Length); $client.Close()
  }
} finally { $listener.Stop() }
