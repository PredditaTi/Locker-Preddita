param(
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$nodeCommand = Get-Command node -ErrorAction Stop
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction Stop
}
$node = $nodeCommand.Source
$npm = $npmCommand.Source

Write-Host "[PREDDITA v2] Teste de regra de negocio do locker..."
& $node (Join-Path $root "scripts\v2-workflow-test.mjs")

Write-Host "[PREDDITA v2] Teste do diario duravel de eventos offline..."
& $node (Join-Path $root "scripts\v2-device-event-journal-test.mjs")

Write-Host "[PREDDITA v2] Teste do diario idempotente de comandos remotos..."
& $node (Join-Path $root "scripts\v2-remote-command-journal-test.mjs")

Write-Host "[PREDDITA v2] Teste de leitura QR do app do armario..."
& $node (Join-Path $root "scripts\v2-qr-scanner-test.mjs")

Write-Host "[PREDDITA v2] Teste de autenticacao e sessoes administrativas..."
& $node (Join-Path $root "scripts\AdminAuthTest.mjs")

Write-Host "[PREDDITA v2] Teste de MFA das contas privilegiadas..."
& $node (Join-Path $root "scripts\AdminMfaTest.mjs")

Write-Host "[PREDDITA v2] Teste de correlacao do protocolo RS-485..."
& $node (Join-Path $root "scripts\v2-serial-protocol-test.mjs")

Write-Host "[PREDDITA v2] Teste de confirmacao fisica das portas..."
& $node (Join-Path $root "scripts\v2-door-safety-test.mjs")

Write-Host "[PREDDITA v2] Teste do assistente de comissionamento..."
& $node (Join-Path $root "scripts\v2-commissioning-test.mjs")

Write-Host "[PREDDITA v2] Teste do parser nativo de frames RS-485..."
$javac = (Get-Command javac -ErrorAction Stop).Source
$java = (Get-Command java -ErrorAction Stop).Source
$javaTestOutput = Join-Path ([System.IO.Path]::GetTempPath()) "preddita-rs485-parser-test"
Remove-Item $javaTestOutput -Recurse -Force -ErrorAction SilentlyContinue
New-Item $javaTestOutput -ItemType Directory | Out-Null
try {
  & $javac -d $javaTestOutput `
    (Join-Path $root "android\app\src\main\java\com\preddita\entregaslocker\Rs485FrameParser.java") `
    (Join-Path $root "scripts\Rs485FrameParserTest.java")
  & $java -cp $javaTestOutput Rs485FrameParserTest
} finally {
  Remove-Item $javaTestOutput -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[PREDDITA v2] Smoke test do admin online..."
& $node (Join-Path $root "scripts\v2-smoke-test.mjs")

Write-Host "[PREDDITA v2] Teste de recuperacao do estado JSON..."
& $node (Join-Path $root "scripts\v2-state-recovery-test.mjs")

Write-Host "[PREDDITA v2] Smoke test Postgres opcional..."
& $node (Join-Path $root "scripts\v2-postgres-smoke-test.mjs")

Write-Host "[PREDDITA v2] Checagem de sintaxe do servidor e painel..."
& $node --check (Join-Path $root "admin-online\server.mjs")
& $node --check (Join-Path $root "admin-online\adminMfa.mjs")
& $node --check (Join-Path $root "admin-online\public\app.js")

Write-Host "[PREDDITA v2] Auditoria de dependencias do admin..."
Push-Location (Join-Path $root "admin-online")
try {
  & $npm audit --omit=dev
} finally {
  Pop-Location
}

Write-Host "[PREDDITA v2] Auditoria de dependencias do app do armario..."
Push-Location (Join-Path $root "web")
try {
  & $npm audit --omit=dev
  if (-not $SkipBuild) {
    Write-Host "[PREDDITA v2] Build do app do armario..."
    & $npm run build
  }
} finally {
  Pop-Location
}

Write-Host "[PREDDITA v2] Verificacao concluida com sucesso."
