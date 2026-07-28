$ErrorActionPreference = 'Stop'

$androidDir = Join-Path $PSScriptRoot '..\android'
$keyStorePath = Join-Path $androidDir 'toca-release-key.jks'
$propertiesPath = Join-Path $androidDir 'keystore.properties'

$jdk = Get-ChildItem 'C:\Program Files\Microsoft' -Directory -Filter 'jdk-21*' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending |
  Select-Object -First 1 -ExpandProperty FullName

if (-not $jdk) {
  throw 'JDK 21 nao encontrado. Instale com: winget install --id Microsoft.OpenJDK.21 -e'
}

$keytool = Join-Path $jdk 'bin\keytool.exe'
if (-not (Test-Path $keytool)) {
  throw "keytool nao encontrado em $keytool"
}

if (-not (Test-Path $keyStorePath)) {
  $storePass = [Guid]::NewGuid().ToString('N').Substring(0, 16)
  $keyPass = $storePass
  $alias = 'toca-release'

  & $keytool -genkeypair -v `
    -keystore $keyStorePath `
    -alias $alias `
    -keyalg RSA `
    -keysize 2048 `
    -validity 10000 `
    -storepass $storePass `
    -dname "CN=Toca App, OU=Mobile, O=Toca, L=Uruguaiana, ST=RS, C=BR"

  @(
    "storeFile=toca-release-key.jks"
    "storePassword=$storePass"
    "keyAlias=$alias"
    "keyPassword=$keyPass"
  ) | Set-Content -Path $propertiesPath -Encoding ascii

  Write-Output "KEYSTORE_CREATED=1"
  Write-Output "KEYSTORE_PATH=$keyStorePath"
  Write-Output "PROPERTIES_PATH=$propertiesPath"
} else {
  if (-not (Test-Path $propertiesPath)) {
    throw "Keystore existe mas keystore.properties nao encontrado em $propertiesPath"
  }

  $props = @{}
  Get-Content $propertiesPath | ForEach-Object {
    if ($_ -match '^(.*?)=(.*)$') {
      $props[$matches[1]] = $matches[2]
    }
  }

  if ($props.ContainsKey('storePassword')) {
    $storePassword = $props['storePassword']
    $props['keyPassword'] = $storePassword
    @(
      "storeFile=$($props['storeFile'])"
      "storePassword=$storePassword"
      "keyAlias=$($props['keyAlias'])"
      "keyPassword=$storePassword"
    ) | Set-Content -Path $propertiesPath -Encoding ascii
    Write-Output 'KEYSTORE_PROPERTIES_FIXED=1'
  }

  Write-Output 'KEYSTORE_CREATED=0'
  Write-Output "KEYSTORE_PATH=$keyStorePath"
}
