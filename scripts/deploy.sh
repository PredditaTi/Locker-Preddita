#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  PREDDITA Smart Locker — Script de Deploy                               ║
# ║  Uso: ./deploy.sh [build|install|all|adb-wifi|test-serial]              ║
# ╚══════════════════════════════════════════════════════════════════════════╝

set -e

DEVICE_IP="${DEVICE_IP:-}"          # Ex: export DEVICE_IP=192.168.1.20
ADB_PORT=5555
PACKAGE="com.preddita.entregaslocker"
APK_PATH="android/app/build/outputs/apk/debug/app-debug.apk"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; NC='\033[0m'; BOLD='\033[1m'

log()  { echo -e "${BLUE}[PREDDITA]${NC} $1"; }
ok()   { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()  { echo -e "${RED}[ERR]${NC} $1"; exit 1; }

# ── 1. Conectar ADB via WiFi ──────────────────────────────────────────────
adb_wifi() {
  if [ -z "$DEVICE_IP" ]; then
    echo -n "IP do dispositivo (ex: 192.168.1.20): "; read DEVICE_IP
  fi
  log "Conectando ao KS1062 em $DEVICE_IP:$ADB_PORT..."
  adb connect "$DEVICE_IP:$ADB_PORT" || err "Falha ao conectar. Verifique:
    1. Modo desenvolvedor ativado no Android
    2. Depuração USB habilitada
    3. Depuração wireless habilitada (Android 11+)
    4. Dispositivo na mesma rede Wi-Fi"
  ok "ADB conectado!"
  adb devices
}

# ── 2. Build do app React ────────────────────────────────────────────────
build_web() {
  log "Instalando dependências Node..."
  cd web && npm install
  log "Compilando React app..."
  npm run build
  cd ..
  ok "Build concluído em android/app/src/main/assets/www/"
}

# ── 3. Build do APK Android ───────────────────────────────────────────────
build_apk() {
  log "Compilando APK Android..."
  cd android && ./gradlew assembleDebug 2>&1 | tail -20
  cd ..
  ok "APK gerado: $APK_PATH"
  ls -lh "$APK_PATH"
}

# ── 4. Instalar APK no dispositivo ───────────────────────────────────────
install_apk() {
  log "Instalando APK no dispositivo..."
  adb install -r "$APK_PATH"
  ok "APK instalado!"

  log "Configurando como launcher padrão..."
  adb shell cmd package set-home-activity "$PACKAGE/.MainActivity" 2>/dev/null || warn "Não foi possível definir como launcher. Faça manualmente."

  log "Iniciando o app..."
  adb shell am start -n "$PACKAGE/.MainActivity"
  ok "App iniciado!"
}

# ── 5. Configurar modo quiosque ──────────────────────────────────────────
setup_kiosk() {
  log "Configurando modo quiosque..."

  # Tela sempre ligada
  adb shell settings put system screen_off_timeout 2147483647

  # Desabilitar barra de navegação (RK3562 específico)
  adb shell settings put global policy_control immersive.full=*

  # Definir app como launcher/home
  adb shell cmd package set-home-activity "$PACKAGE/.MainActivity" 2>/dev/null || true

  # Desabilitar animações (melhora responsividade no touch)
  adb shell settings put global window_animation_scale 0.5
  adb shell settings put global transition_animation_scale 0.5
  adb shell settings put global animator_duration_scale 0.5

  ok "Modo quiosque configurado!"
}

# ── 6. Testar porta serial RS-485 ─────────────────────────────────────────
test_serial() {
  log "Testando porta serial /dev/ttyS1..."

  # Verificar se o device existe
  adb shell "ls -la /dev/ttyS*" || err "/dev/ttyS* não encontrado"

  log "Configurando porta serial (9600,8,N,1)..."
  adb shell "stty -F /dev/ttyS1 9600 cs8 -cstopb -parenb raw -echo" 2>/dev/null || \
  adb shell "su -c 'stty -F /dev/ttyS1 9600 cs8 -cstopb -parenb raw -echo'" 2>/dev/null || \
  warn "stty falhou — pode precisar de root ou permissão do fabricante"

  # Envia comando de query de firmware: 82 01 00 22 A1
  log "Enviando query de firmware (82 01 00 22 A1)..."
  adb shell "printf '\x82\x01\x00\x22\xA1' > /dev/ttyS1" 2>/dev/null || \
  adb shell "su -c \"printf '\\x82\\x01\\x00\\x22\\xA1' > /dev/ttyS1\"" 2>/dev/null || \
  warn "Escrita na serial falhou"

  log "Aguardando resposta (2s)..."
  adb shell "timeout 2 cat /dev/ttyS1 | xxd" 2>/dev/null | head -5 || warn "Sem resposta — verifique se a placa CM06 está energizada e conectada"

  # Testa abrir canal 1: 8A 01 01 11 9B
  echo ""
  log "Testando abertura do canal 1 (8A 01 01 11 9B)..."
  echo -n "Deseja enviar o comando de abertura? (s/N): "; read confirm
  if [ "$confirm" = "s" ] || [ "$confirm" = "S" ]; then
    adb shell "printf '\x8A\x01\x01\x11\x9B' > /dev/ttyS1" 2>/dev/null || \
    adb shell "su -c \"printf '\\x8A\\x01\\x01\\x11\\x9B' > /dev/ttyS1\"" 2>/dev/null
    ok "Comando enviado! A trava do canal 1 deveria ter aberto."
    log "Resposta esperada: 8A 01 01 11 9B (success)"
    adb shell "timeout 1 cat /dev/ttyS1 | xxd" 2>/dev/null | head -3
  fi
}

# ── 7. Diagnóstico geral ─────────────────────────────────────────────────
diagnose() {
  log "=== DIAGNÓSTICO DO DISPOSITIVO ==="
  echo ""

  log "Modelo:"
  adb shell getprop ro.product.model
  adb shell getprop ro.product.brand

  log "Android version:"
  adb shell getprop ro.build.version.release

  log "CPU:"
  adb shell getprop ro.hardware

  log "Memória disponível:"
  adb shell cat /proc/meminfo | grep -E "MemTotal|MemAvailable"

  log "Portas seriais:"
  adb shell "ls -la /dev/ttyS* /dev/ttyUSB* 2>/dev/null" || warn "Nenhuma porta serial encontrada"

  log "Câmeras disponíveis:"
  adb shell "ls /dev/video* 2>/dev/null" || warn "Sem device de câmera em /dev/video*"

  log "IP do dispositivo:"
  adb shell ip route | grep -v "^default"
  adb shell ifconfig wlan0 2>/dev/null | grep "inet addr" || \
  adb shell ip addr show wlan0 | grep "inet "

  log "Apps instalados (PREDDITA):"
  adb shell pm list packages | grep preddita || warn "App PREDDITA não instalado"

  echo ""
  ok "Diagnóstico concluído."
}

# ── 8. Logs em tempo real ─────────────────────────────────────────────────
logs() {
  log "Exibindo logs do app em tempo real (Ctrl+C para parar)..."
  adb logcat -c
  adb logcat -v time PredditaLocker:D AndroidRuntime:E *:S
}

# ── Dispatcher ───────────────────────────────────────────────────────────
case "${1:-all}" in
  adb-wifi)     adb_wifi ;;
  build-web)    build_web ;;
  build-apk)    build_apk ;;
  install)      install_apk ;;
  kiosk)        setup_kiosk ;;
  test-serial)  test_serial ;;
  diagnose)     diagnose ;;
  logs)         logs ;;
  build)
    build_web
    build_apk
    ;;
  all)
    echo ""
    echo -e "${BOLD}╔══════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║  PREDDITA SMART LOCKER — DEPLOY      ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════╝${NC}"
    echo ""
    adb_wifi
    build_web
    build_apk
    install_apk
    setup_kiosk
    echo ""
    ok "Deploy completo! O app está rodando no dispositivo."
    echo ""
    log "Próximo passo: ./deploy.sh test-serial"
    ;;
  *)
    echo "Uso: $0 [adb-wifi|build-web|build-apk|install|kiosk|test-serial|diagnose|logs|build|all]"
    ;;
esac
