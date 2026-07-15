$ErrorActionPreference = 'Stop'

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = 'C:\Program Files\nodejs\node.exe'
$Adb = 'C:\Users\Usuario\Desktop\platform-tools\adb.exe'
$Device = '192.168.0.39:5555'
$Port = '8787'
$EnvFile = Join-Path $ProjectDir '.env'

if (Test-Path -LiteralPath $EnvFile) {
  Get-Content -LiteralPath $EnvFile | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#') -or -not $line.Contains('=')) {
      return
    }

    $name, $value = $line.Split('=', 2)
    $name = $name.Trim()
    $value = $value.Trim().Trim('"').Trim("'")
    if ($name) {
      [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
  }
}

Write-Host '[PREDDITA] Iniciando painel online...'

$isRunning = $false
try {
  Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/healthz" -TimeoutSec 2 | Out-Null
  $isRunning = $true
} catch {
  $isRunning = $false
}

if (-not $isRunning) {
  Start-Process -FilePath $Node -ArgumentList 'server.mjs' -WorkingDirectory $ProjectDir -WindowStyle Hidden
  Start-Sleep -Seconds 1
}

Write-Host '[PREDDITA] Conectando ao armario por ADB...'
& $Adb connect $Device | Write-Host

Write-Host '[PREDDITA] Criando tunel local para o armario acessar o painel...'
& $Adb -s $Device reverse "tcp:$Port" "tcp:$Port" | Write-Host

Write-Host "[OK] Painel: http://localhost:$Port"
Write-Host '[OK] Token inicial: preddita-admin-local'
