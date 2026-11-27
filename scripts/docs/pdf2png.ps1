param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 2200
)

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

$asTaskAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction'
  })[0]

function Await-Op($op, [Type]$type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

function Await-Action($op) {
  $task = $asTaskAction.Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfDocument, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Pdf.PdfPageRenderOptions, Windows.Data.Pdf, ContentType = WindowsRuntime] | Out-Null

$pdfPath = (Resolve-Path -LiteralPath $Pdf).Path
$file = Await-Op ([Windows.Storage.StorageFile]::GetFileFromPathAsync($pdfPath)) ([Windows.Storage.StorageFile])
$doc = Await-Op ([Windows.Data.Pdf.PdfDocument]::LoadFromFileAsync($file)) ([Windows.Data.Pdf.PdfDocument])

$outDir = Split-Path -Parent $Out
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
$base = [System.IO.Path]::GetFileNameWithoutExtension($Out)

for ($i = 0; $i -lt $doc.PageCount; $i++) {
  $page = $doc.GetPage($i)
  $stream = [Windows.Storage.Streams.InMemoryRandomAccessStream]::new()
  $opts = [Windows.Data.Pdf.PdfPageRenderOptions]::new()
  $ratio = $page.Size.Height / $page.Size.Width
  $opts.DestinationWidth = [uint32]$Width
  $opts.DestinationHeight = [uint32]($Width * $ratio)
  Await-Action ($page.RenderToStreamAsync($stream, $opts))

  $suffix = if ($doc.PageCount -gt 1) { "-p$($i + 1)" } else { "" }
  $target = Join-Path $outDir "$base$suffix.png"
  $reader = [System.IO.WindowsRuntimeStreamExtensions]::AsStreamForRead($stream)
  $outFs = [System.IO.File]::Create($target)
  $reader.CopyTo($outFs)
  $outFs.Close(); $reader.Close(); $stream.Dispose(); $page.Dispose()
  "wrote $target"
}
"pages=$($doc.PageCount)"
