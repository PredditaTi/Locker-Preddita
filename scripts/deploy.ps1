param(
  [Parameter(Position = 0)]
  [ValidateSet('adb-wifi', 'build-web', 'build-apk', 'build-release', 'package-web', 'install', 'install-release', 'kiosk', 'diagnose', 'logs', 'all')]
  [string]$Action = 'all',

  [string]$DeviceIp = $env:DEVICE_IP,
  [int]$AdbPort = 5555
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$WebDir = Join-Path $ProjectRoot 'web'
$AndroidDir = Join-Path $ProjectRoot 'android'
$ApkPath = Join-Path $AndroidDir 'app\build\outputs\apk\debug\app-debug.apk'
$ReleaseApkPath = Join-Path $AndroidDir 'app\build\outputs\apk\release\app-release.apk'
$BuiltWebDir = Join-Path $AndroidDir 'app\src\main\assets\www'
$WebPackageDir = Join-Path $ProjectRoot 'web-package'
$Package = 'com.preddita.entregaslocker'
$Activity = "$Package/.MainActivity"

function Write-Info($Message) {
  Write-Host "[PREDDITA] $Message" -ForegroundColor Cyan
}

function Write-Ok($Message) {
  Write-Host "[OK] $Message" -ForegroundColor Green
}

function Write-Warn($Message) {
  Write-Host "[WARN] $Message" -ForegroundColor Yellow
}

function Add-PathEntry($PathEntry) {
  if (-not $PathEntry) {
    return $false
  }

  if (-not (Test-Path -LiteralPath $PathEntry)) {
    return $false
  }

  $pathEntries = $env:Path -split ';'
  if ($pathEntries -notcontains $PathEntry) {
    $env:Path = "$PathEntry;$env:Path"
  }

  return $true
}

function Resolve-CommandPath($Name) {
  $existing = Get-Command $Name -ErrorAction SilentlyContinue
  if ($existing) {
    return $existing.Source
  }

  $candidates = switch ($Name) {
    'node' { @('C:\Program Files\nodejs') }
    'npm' { @('C:\Program Files\nodejs') }
    'adb' {
      @(
        (Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools'),
        (Join-Path $env:ANDROID_HOME 'platform-tools'),
        (Join-Path $env:ANDROID_SDK_ROOT 'platform-tools')
      )
    }
    default { @() }
  }

  foreach ($candidate in $candidates) {
    if (Add-PathEntry $candidate) {
      $resolved = Get-Command $Name -ErrorAction SilentlyContinue
      if ($resolved) {
        return $resolved.Source
      }
    }
  }

  return $null
}

function Assert-Command($Name, $Hint) {
  if (-not (Resolve-CommandPath $Name)) {
    throw "Comando '$Name' nao encontrado. $Hint"
  }
}

function Invoke-Adb {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Args)
  & adb @Args
}

function Connect-AdbWifi {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."

  if (-not $DeviceIp) {
    $script:DeviceIp = Read-Host 'IP do dispositivo (ex: 192.168.1.20)'
  }

  Write-Info "Conectando ao KS1062 em $DeviceIp`:$AdbPort..."
  Invoke-Adb connect "$DeviceIp`:$AdbPort" | Out-Host
  Invoke-Adb devices | Out-Host
}

function Build-Web {
  Assert-Command node "Instale Node.js 18+."
  Assert-Command npm "Instale Node.js 18+."

  Push-Location $WebDir
  try {
    Write-Info 'Instalando dependencias Node...'
    npm install
    if ($LASTEXITCODE -ne 0) {
      throw 'npm install falhou.'
    }

    Write-Info 'Compilando app React...'
    npm run build
    if ($LASTEXITCODE -ne 0) {
      throw 'npm run build falhou.'
    }
  }
  finally {
    Pop-Location
  }

  Write-Ok 'Build web concluido.'
}

function Build-Apk {
  $gradleBat = Join-Path $AndroidDir 'gradlew.bat'

  if (Test-Path -LiteralPath $gradleBat) {
    Push-Location $AndroidDir
    try {
      Write-Info 'Compilando APK com gradlew.bat...'
      & $gradleBat assembleDebug
      if ($LASTEXITCODE -ne 0) {
        throw 'gradlew.bat assembleDebug falhou.'
      }
    }
    finally {
      Pop-Location
    }
  }
  elseif (Get-Command gradle -ErrorAction SilentlyContinue) {
    Push-Location $AndroidDir
    try {
      Write-Info 'Compilando APK com gradle...'
      gradle assembleDebug
      if ($LASTEXITCODE -ne 0) {
        throw 'gradle assembleDebug falhou.'
      }
    }
    finally {
      Pop-Location
    }
  }
  else {
    throw "Gradle nao encontrado. Adicione o wrapper ('gradlew.bat') ou instale Gradle."
  }

  if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK nao encontrado em $ApkPath"
  }

  Write-Ok "APK gerado em $ApkPath"
}

function Build-Release {
  $gradleBat = Join-Path $AndroidDir 'gradlew.bat'

  if (Test-Path -LiteralPath $gradleBat) {
    Push-Location $AndroidDir
    try {
      Write-Info 'Compilando APK release com gradlew.bat...'
      & $gradleBat assembleRelease
      if ($LASTEXITCODE -ne 0) {
        throw 'gradlew.bat assembleRelease falhou.'
      }
    }
    finally {
      Pop-Location
    }
  }
  elseif (Get-Command gradle -ErrorAction SilentlyContinue) {
    Push-Location $AndroidDir
    try {
      Write-Info 'Compilando APK release com gradle...'
      gradle assembleRelease
      if ($LASTEXITCODE -ne 0) {
        throw 'gradle assembleRelease falhou.'
      }
    }
    finally {
      Pop-Location
    }
  }
  else {
    throw "Gradle nao encontrado. Adicione o wrapper ('gradlew.bat') ou instale Gradle."
  }

  if (-not (Test-Path -LiteralPath $ReleaseApkPath)) {
    throw "APK release nao encontrado em $ReleaseApkPath"
  }

  Write-Ok "APK release gerado em $ReleaseApkPath"
}

function Package-Web {
  if (-not (Test-Path -LiteralPath $BuiltWebDir)) {
    throw "Build web nao encontrado em $BuiltWebDir. Rode build-web antes."
  }

  if (Test-Path -LiteralPath $WebPackageDir) {
    Remove-Item -LiteralPath $WebPackageDir -Recurse -Force
  }

  New-Item -ItemType Directory -Path $WebPackageDir | Out-Null
  Copy-Item -LiteralPath $BuiltWebDir -Destination (Join-Path $WebPackageDir 'site') -Recurse -Force
  Copy-Item -LiteralPath (Join-Path $ScriptDir 'serve-web.mjs') -Destination (Join-Path $WebPackageDir 'serve-web.mjs') -Force

  $readme = @'
# PREDDITA Entregas - Versao Web

## Como publicar na rede local

1. Abra o PowerShell nesta pasta.
2. Rode:
   node .\serve-web.mjs
3. No dispositivo, abra o endereco mostrado no terminal.

## Observacao

Esta versao web abre no navegador e funciona em modo simulado.
Ela nao acessa a serial RS-485 real porque o bridge Android (`window.Android`) so existe no APK.
'@

  Set-Content -LiteralPath (Join-Path $WebPackageDir 'README-WEB.txt') -Value $readme -Encoding UTF8

  Write-Ok "Pacote web gerado em $WebPackageDir"
}

function Install-Apk {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."

  if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "APK nao encontrado em $ApkPath"
  }

  Write-Info 'Instalando APK no dispositivo...'
  Invoke-Adb install -r $ApkPath | Out-Host

  Write-Info 'Iniciando o app...'
  Invoke-Adb shell am start -n $Activity | Out-Host

  Write-Info 'Configurando launcher padrao...'
  try {
    Invoke-Adb shell cmd package set-home-activity $Activity | Out-Host
  }
  catch {
    Write-Warn 'Nao foi possivel definir o app como launcher. Configure manualmente no dispositivo.'
  }

  Write-Ok 'App instalado e iniciado.'
}

function Install-ReleaseApk {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."

  if (-not (Test-Path -LiteralPath $ReleaseApkPath)) {
    throw "APK release nao encontrado em $ReleaseApkPath"
  }

  Write-Info 'Instalando APK release no dispositivo...'
  Invoke-Adb install -r $ReleaseApkPath | Out-Host

  Write-Info 'Iniciando o app...'
  Invoke-Adb shell am start -n $Activity | Out-Host

  Write-Ok 'App release instalado e iniciado.'
}

function Setup-Kiosk {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."

  Write-Info 'Configurando modo quiosque...'
  Invoke-Adb shell settings put system screen_off_timeout 2147483647 | Out-Host
  Invoke-Adb shell settings put global policy_control immersive.full=* | Out-Host
  Invoke-Adb shell settings put global window_animation_scale 0.5 | Out-Host
  Invoke-Adb shell settings put global transition_animation_scale 0.5 | Out-Host
  Invoke-Adb shell settings put global animator_duration_scale 0.5 | Out-Host
  Invoke-Adb shell cmd package set-home-activity $Activity | Out-Host

  Write-Ok 'Modo quiosque configurado.'
}

function Diagnose-Device {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."

  Write-Info '=== DIAGNOSTICO DO DISPOSITIVO ==='
  Invoke-Adb shell getprop ro.product.model | Out-Host
  Invoke-Adb shell getprop ro.product.brand | Out-Host
  Invoke-Adb shell getprop ro.build.version.release | Out-Host
  Invoke-Adb shell getprop ro.hardware | Out-Host
  Invoke-Adb shell cat /proc/meminfo | Select-String 'MemTotal|MemAvailable' | Out-Host
  Invoke-Adb shell "ls -la /dev/ttyS* /dev/ttyUSB* 2>/dev/null" | Out-Host
  Invoke-Adb shell pm list packages | Select-String 'preddita' | Out-Host
}

function Show-Logs {
  Assert-Command adb "Instale o Android Platform Tools antes de continuar."
  Invoke-Adb logcat -c | Out-Null
  Invoke-Adb logcat -v time PredditaLocker:D AndroidRuntime:E *:S
}

switch ($Action) {
  'adb-wifi' { Connect-AdbWifi }
  'build-web' { Build-Web }
  'build-apk' { Build-Apk }
  'build-release' { Build-Release }
  'package-web' { Package-Web }
  'install' { Install-Apk }
  'install-release' { Install-ReleaseApk }
  'kiosk' { Setup-Kiosk }
  'diagnose' { Diagnose-Device }
  'logs' { Show-Logs }
  'all' {
    Connect-AdbWifi
    Build-Web
    Build-Apk
    Install-Apk
    Setup-Kiosk
    Write-Ok 'Deploy completo.'
  }
}
