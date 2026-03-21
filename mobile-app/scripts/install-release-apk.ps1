$ErrorActionPreference = 'Stop'

$sdk = Join-Path $env:LOCALAPPDATA 'Android\Sdk'
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$apk = Join-Path $PSScriptRoot '..\android\app\build\outputs\apk\release\app-release.apk'

if (-not (Test-Path $adb)) {
  throw "ADB nao encontrado em $adb"
}

if (-not (Test-Path $apk)) {
  throw 'APK release nao encontrada. Rode: npm run release:apk'
}

$devices = & $adb devices
$connected = $devices | Where-Object { $_ -match "\tdevice$" }

if (-not $connected) {
  throw 'Nenhum dispositivo/emulador conectado. Ative depuracao USB e autorize o PC no celular.'
}

function Invoke-Adb {
  param(
    [string[]]$AdbArgs
  )

  $stdoutFile = [System.IO.Path]::GetTempFileName()
  $stderrFile = [System.IO.Path]::GetTempFileName()
  try {
    $process = Start-Process -FilePath $adb -ArgumentList $AdbArgs -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $stdout = ''
    $stderr = ''
    if (Test-Path $stdoutFile) { $stdout = Get-Content $stdoutFile -Raw }
    if (Test-Path $stderrFile) { $stderr = Get-Content $stderrFile -Raw }
    return [PSCustomObject]@{
      ExitCode = $process.ExitCode
      StdOut = $stdout
      StdErr = $stderr
      Text = ($stdout + "`n" + $stderr).Trim()
    }
  } finally {
    Remove-Item $stdoutFile, $stderrFile -Force -ErrorAction SilentlyContinue
  }
}

$install = Invoke-Adb -AdbArgs @('install', '-r', $apk)
if ($install.ExitCode -eq 0) {
  if ($install.Text) { Write-Output $install.Text }
  Write-Output "APK release instalada com sucesso: $apk"
  exit 0
}

if ($install.Text -match 'INSTALL_FAILED_UPDATE_INCOMPATIBLE') {
  Write-Output 'Assinatura diferente detectada. Removendo app antigo e reinstalando release...'
  [void](Invoke-Adb -AdbArgs @('uninstall', 'com.toca.mobile'))

  $retry = Invoke-Adb -AdbArgs @('install', $apk)
  if ($retry.ExitCode -eq 0) {
    if ($retry.Text) { Write-Output $retry.Text }
    Write-Output "APK release instalada com sucesso: $apk"
    exit 0
  }

  throw "Falha ao reinstalar APK release: $($retry.Text)"
}

throw "Falha ao instalar APK release: $($install.Text)"
