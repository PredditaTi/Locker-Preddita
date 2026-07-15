param(
  [Parameter(Mandatory = $true)]
  [string]$ServerUrl,

  [Parameter(Mandatory = $true)]
  [string]$DeviceKey,

  [string]$LockerId = 'ks1062-aurora'
)

$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $ScriptDir
$WebDir = Join-Path $ProjectRoot 'web'
$DeployScript = Join-Path $ScriptDir 'deploy.ps1'

$env:Path = 'C:\Program Files\nodejs;' + $env:Path
$env:VITE_PREDDITA_REMOTE_URL = $ServerUrl.TrimEnd('/')
$env:VITE_PREDDITA_DEVICE_KEY = $DeviceKey
$env:VITE_PREDDITA_LOCKER_ID = $LockerId

Push-Location $WebDir
try {
  & 'C:\Program Files\nodejs\npm.cmd' run build
  if ($LASTEXITCODE -ne 0) {
    throw 'npm run build falhou.'
  }
}
finally {
  Pop-Location
}

powershell -ExecutionPolicy Bypass -File $DeployScript build-release
