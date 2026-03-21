$ErrorActionPreference = 'Stop'

$logoUrl = 'https://csspp.quantumandtime.com.br/assets/imgs/11-rc-mec-logo.png'
$root = Join-Path $PSScriptRoot '..'
$resDir = Join-Path $root 'android\app\src\main\res'

$iconSizes = @{
  'mipmap-mdpi' = 48
  'mipmap-hdpi' = 72
  'mipmap-xhdpi' = 96
  'mipmap-xxhdpi' = 144
  'mipmap-xxxhdpi' = 192
}

$tempDir = Join-Path $env:TEMP 'toca-mobile-logo'
New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$srcPath = Join-Path $tempDir 'logo-source.png'

Invoke-WebRequest -Uri $logoUrl -OutFile $srcPath -UseBasicParsing

Add-Type -AssemblyName System.Drawing

$sourceImage = [System.Drawing.Image]::FromFile($srcPath)

try {
  foreach ($entry in $iconSizes.GetEnumerator()) {
    $folder = Join-Path $resDir $entry.Key
    $size = [int]$entry.Value

    $bitmap = New-Object System.Drawing.Bitmap($size, $size)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.DrawImage($sourceImage, 0, 0, $size, $size)

    $launcher = Join-Path $folder 'ic_launcher.png'
    $round = Join-Path $folder 'ic_launcher_round.png'
    $foreground = Join-Path $folder 'ic_launcher_foreground.png'

    $bitmap.Save($launcher, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Save($round, [System.Drawing.Imaging.ImageFormat]::Png)
    $bitmap.Save($foreground, [System.Drawing.Imaging.ImageFormat]::Png)

    $graphics.Dispose()
    $bitmap.Dispose()
  }
}
finally {
  $sourceImage.Dispose()
}

Write-Output 'APP_LOGO_UPDATED=1'
