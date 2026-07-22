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

Write-Host "[PREDDITA v2] Teste do contrato entre Edge Agent e Kiosk UI..."
& $node (Join-Path $root "scripts\v2-edge-agent-contract-test.mjs")

Write-Host "[PREDDITA v2] Teste do wake-up MQTT no app do armario..."
& $node (Join-Path $root "scripts\CommandWakeupTest.mjs")

Write-Host "[PREDDITA v2] Teste da politica e tickets do AWS IoT Core..."
& $node (Join-Path $root "scripts\IotCommandBusTest.mjs")

Write-Host "[PREDDITA v2] Teste de leitura QR do app do armario..."
& $node (Join-Path $root "scripts\v2-qr-scanner-test.mjs")

Write-Host "[PREDDITA v2] Teste de politica e integridade do audio..."
& $node (Join-Path $root "scripts\audio-guidance-test.mjs")

Write-Host "[PREDDITA v2] Teste de autenticacao e sessoes administrativas..."
& $node (Join-Path $root "scripts\AdminAuthTest.mjs")

Write-Host "[PREDDITA v2] Teste de MFA das contas privilegiadas..."
& $node (Join-Path $root "scripts\AdminMfaTest.mjs")

Write-Host "[PREDDITA v2] Teste do ciclo de vida e direitos de privacidade..."
& $node (Join-Path $root "scripts\PrivacyLifecycleTest.mjs")

Write-Host "[PREDDITA v2] Teste do armazenamento operacional normalizado..."
& $node (Join-Path $root "scripts\OperationalStoreTest.mjs")

Write-Host "[PREDDITA v2] Teste das transicoes transacionais de comandos..."
& $node (Join-Path $root "scripts\CommandStoreTest.mjs")

Write-Host "[PREDDITA v2] Teste de correlacao do protocolo RS-485..."
& $node (Join-Path $root "scripts\v2-serial-protocol-test.mjs")

Write-Host "[PREDDITA v2] Teste do contrato da bridge serial coordenada..."
& $node (Join-Path $root "scripts\serial-native-bridge-test.mjs")

Write-Host "[PREDDITA v2] Teste do health check de atualizacao..."
& $node (Join-Path $root "scripts\app-update-health-test.mjs")

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

Write-Host "[PREDDITA v2] Teste do coordenador nativo de comandos RS-485..."
$javaCoordinatorTestOutput = Join-Path ([System.IO.Path]::GetTempPath()) "preddita-serial-coordinator-test"
Remove-Item $javaCoordinatorTestOutput -Recurse -Force -ErrorAction SilentlyContinue
New-Item $javaCoordinatorTestOutput -ItemType Directory | Out-Null
try {
  & $javac -d $javaCoordinatorTestOutput `
    (Join-Path $root "android\app\src\main\java\com\preddita\entregaslocker\SerialCommandCoordinator.java") `
    (Join-Path $root "scripts\SerialCommandCoordinatorTest.java")
  & $java -cp $javaCoordinatorTestOutput SerialCommandCoordinatorTest
} finally {
  Remove-Item $javaCoordinatorTestOutput -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[PREDDITA v2] Teste do contrato nativo de atualizacao do APK..."
$javaUpdateTestOutput = Join-Path ([System.IO.Path]::GetTempPath()) "preddita-app-update-test"
Remove-Item $javaUpdateTestOutput -Recurse -Force -ErrorAction SilentlyContinue
New-Item $javaUpdateTestOutput -ItemType Directory | Out-Null
try {
  & $javac -d $javaUpdateTestOutput `
    (Join-Path $root "android\app\src\main\java\com\preddita\entregaslocker\AppUpdateContract.java") `
    (Join-Path $root "android\app\src\main\java\com\preddita\entregaslocker\AppUpdateHealthContract.java") `
    (Join-Path $root "scripts\AppUpdateHealthContractTest.java") `
    (Join-Path $root "scripts\AppUpdateContractTest.java")
  & $java -cp $javaUpdateTestOutput AppUpdateContractTest
  & $java -cp $javaUpdateTestOutput AppUpdateHealthContractTest
} finally {
  Remove-Item $javaUpdateTestOutput -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[PREDDITA v2] Teste dos contratos do console tecnico..."
& $node (Join-Path $root "scripts\diagnostic-console-test.mjs")
& $node (Join-Path $root "scripts\smart-delivery-telemetry-test.mjs")
$javaDiagnosticTestOutput = Join-Path ([System.IO.Path]::GetTempPath()) "preddita-diagnostic-contract-test"
Remove-Item $javaDiagnosticTestOutput -Recurse -Force -ErrorAction SilentlyContinue
New-Item $javaDiagnosticTestOutput -ItemType Directory | Out-Null
try {
  & $javac -d $javaDiagnosticTestOutput `
    (Join-Path $root "android\app\src\main\java\com\preddita\entregaslocker\DiagnosticControlContract.java") `
    (Join-Path $root "scripts\DiagnosticControlContractTest.java")
  & $java -cp $javaDiagnosticTestOutput DiagnosticControlContractTest
} finally {
  Remove-Item $javaDiagnosticTestOutput -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "[PREDDITA v2] Smoke test do admin online..."
& $node (Join-Path $root "scripts\v2-smoke-test.mjs")

Write-Host "[PREDDITA v2] Teste do contrato consumidor-servidor da API..."
& $node (Join-Path $root "scripts\v2-api-contract-test.mjs")

Write-Host "[PREDDITA v2] Teste de recuperacao do estado JSON..."
& $node (Join-Path $root "scripts\v2-state-recovery-test.mjs")

Write-Host "[PREDDITA v2] Smoke test Postgres opcional..."
& $node (Join-Path $root "scripts\v2-postgres-smoke-test.mjs")

Write-Host "[PREDDITA v2] Checagem de sintaxe do servidor e painel..."
& $node --check (Join-Path $root "admin-online\server.mjs")
& $node --check (Join-Path $root "admin-online\adminMfa.mjs")
& $node --check (Join-Path $root "admin-online\operationalStore.mjs")
& $node --check (Join-Path $root "admin-online\commandStore.mjs")
& $node --check (Join-Path $root "admin-online\iotCommandBus.mjs")
& $node --check (Join-Path $root "admin-online\privacyLifecycle.mjs")
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
    Write-Host "[PREDDITA v2] Fluxo E2E de deposito e retirada no kiosk..."
    & $npm run test:e2e
  }
} finally {
  Pop-Location
}

Write-Host "[PREDDITA v2] Verificacao concluida com sucesso."
