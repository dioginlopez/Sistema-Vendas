$ErrorActionPreference = 'Stop'

$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$apk = Join-Path $PSScriptRoot '..\android\app\build\outputs\apk\debug\app-debug.apk'

if (-not (Test-Path $adb)) {
  throw "ADB nao encontrado em $adb"
}

if (-not (Test-Path $apk)) {
  throw 'APK de debug nao encontrado. Rode: npm run auto:full'
}

$devices = & $adb devices
$connected = $devices | Where-Object { $_ -match "\tdevice$" }

if (-not $connected) {
  throw 'Nenhum dispositivo/emulador conectado. Ative depuracao USB e autorize o PC no celular.'
}

& $adb install -r $apk
Write-Output "APK instalado com sucesso: $apk"
