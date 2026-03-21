$ErrorActionPreference = 'Stop'

$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $jdk) {
  throw 'JDK 21 nao encontrado. Instale com: winget install --id Microsoft.OpenJDK.21 -e'
}

if (-not (Test-Path $sdk)) {
  New-Item -ItemType Directory -Force -Path $sdk | Out-Null
}

$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = $sdk
$env:ANDROID_SDK_ROOT = $sdk
$env:Path = "$jdk\bin;$sdk\platform-tools;$sdk\cmdline-tools\latest\bin;" + $env:Path

$sdkManager = Join-Path $sdk 'cmdline-tools\latest\bin\sdkmanager.bat'
if (-not (Test-Path $sdkManager)) {
  throw "sdkmanager nao encontrado em $sdkManager"
}

# Aceita licencas e garante dependencias do projeto Android
1..300 | ForEach-Object { 'y' } | & $sdkManager --sdk_root=$sdk --licenses | Out-Null
& $sdkManager --sdk_root=$sdk 'platform-tools' 'platforms;android-36' 'build-tools;36.0.0' | Out-Null

Push-Location (Join-Path $PSScriptRoot '..\android')
Set-Content -Path .\local.properties -Value 'sdk.dir=C:\\Users\\diogi\\AppData\\Local\\Android\\Sdk' -NoNewline
& .\gradlew.bat --no-daemon assembleDebug

$apk = Resolve-Path .\app\build\outputs\apk\debug\app-debug.apk -ErrorAction SilentlyContinue
if ($apk) {
  Write-Output "APK_PATH=$($apk.Path)"
} else {
  Write-Output 'APK_PATH='
}
Pop-Location
