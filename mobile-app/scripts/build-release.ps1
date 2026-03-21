$ErrorActionPreference = 'Stop'

$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $jdk) {
  throw 'JDK 21 nao encontrado. Instale com: winget install --id Microsoft.OpenJDK.21 -e'
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$sdk\platform-tools;$sdk\cmdline-tools\latest\bin;" + $env:Path

$androidDir = Join-Path $PSScriptRoot '..\android'
Push-Location $androidDir

Set-Content -Path .\local.properties -Value 'sdk.dir=C:\\Users\\diogi\\AppData\\Local\\Android\\Sdk' -NoNewline
& .\gradlew.bat --no-daemon assembleRelease

$apk = Resolve-Path .\app\build\outputs\apk\release\app-release.apk -ErrorAction SilentlyContinue
if ($apk) {
  Write-Output "RELEASE_APK_PATH=$($apk.Path)"
} else {
  throw 'APK release nao foi gerada.'
}

Pop-Location
