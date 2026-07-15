# PREDDITA SMART LOCKER — Guia de Implantação
[![CI](https://github.com/PredditaTi/Locker-Preddita/actions/workflows/ci.yml/badge.svg)](https://github.com/PredditaTi/Locker-Preddita/actions/workflows/ci.yml)

**Dispositivo:** KS1062-N-ZY · RK3562 · Android 11/13 · serial validada em `/dev/ttyS5`

## Documentacao para programadores

Para entender a versao atual antes de alterar codigo, leia:

- `docs/ARCHITECTURE.md`: arquitetura do app do armario, Admin Online,
  sincronizacao offline, comandos remotos e modelo de dados.
- `docs/DEVELOPER-RUNBOOK.md`: setup, testes, build, ADB, checklist e
  depuracao rapida.
- `docs/CI-RELEASE.md`: GitHub Actions, assinatura e geracao dos APKs.

---

## PRÉ-REQUISITOS (máquina do desenvolvedor)

```bash
# Verificar instalações necessárias
node --version       # >= 18
npm --version        # >= 9
java --version       # >= 11  (para compilar o APK)
adb --version        # Android SDK Platform Tools
```

**Instalar Android SDK Platform Tools (se não tiver):**
```bash
# macOS
brew install android-platform-tools

# Ubuntu/Debian
sudo apt install android-tools-adb

# Windows — baixar em:
# https://developer.android.com/tools/releases/platform-tools
```

---

## PASSO 1 — Ativar ADB Wireless no KS1062

No dispositivo (tela Android):

```
Configurações → Sobre o dispositivo
  → Tocar em "Número da versão" 7 vezes (ativa modo desenvolvedor)

Configurações → Opções do desenvolvedor
  → Depuração USB: ATIVAR
  → Depuração wireless: ATIVAR        ← Android 11+
  → "Desativar verificações ADB": ATIVAR (se disponível)
```

**Verificar o IP do dispositivo:**
```
Configurações → Wi-Fi → (rede conectada) → IP: 192.168.1.XXX
```

---

## PASSO 2 — Conectar via ADB WiFi

```bash
# No computador — conectar ao dispositivo
adb connect 192.168.1.20:5555

# Confirmar conexão
adb devices
# Saída esperada:
# 192.168.1.20:5555    device

# Se pedir autorização: aceitar no dispositivo
```

**Alternativa — primeiro via USB, depois wireless:**
```bash
# 1. Conectar cabo USB no USB4 (OTG)
adb devices                          # confirmar dispositivo
adb tcpip 5555                       # habilitar TCP
adb connect 192.168.1.20:5555        # conectar por WiFi
# 2. Pode desconectar o cabo
```

---

## PASSO 3 — Diagnóstico do Dispositivo

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh diagnose
```

**Output esperado:**
```
[PREDDITA] Modelo: KS1062-N-ZY
[PREDDITA] Android version: 11
[PREDDITA] CPU: rk3562
[PREDDITA] Portas seriais:
crw-rw-rw- root dialout /dev/ttyS0
crw-rw-rw- root dialout /dev/ttyS1   ← ESTA É A COM1 (RS-485)
crw-rw-rw- root dialout /dev/ttyS2
crw-rw-rw- root dialout /dev/ttyS3
```

---

## PASSO 4 — Testar RS-485 ANTES de instalar o app

> ⚠️ Confirme que a placa CM06 está energizada (12-24V) e o cabo RS-485
> (par trançado A/B) está conectado à COM1 do KS1062.

```bash
./scripts/deploy.sh test-serial
```

**Teste manual via ADB shell:**
```bash
# Abrir shell no dispositivo
adb shell

# Configurar porta serial
stty -F /dev/ttyS1 9600 cs8 -cstopb -parenb raw -echo

# Enviar query de firmware (82 01 00 22 A1)
printf '\x82\x01\x00\x22\xA1' > /dev/ttyS1

# Ler resposta (1 segundo)
timeout 1 cat /dev/ttyS1 | xxd

# Resultado esperado:
# 00000000: 8201 00ab ce                     .....
# (AB = versão do firmware, CE = BCC)

# Testar abertura do canal 1 (8A 01 01 33 B9)
printf '\x8A\x01\x01\x33\xB9' > /dev/ttyS5
timeout 1 cat /dev/ttyS1 | xxd
# Resultado esperado:
# 00000000: 8a01 0111 9b                     .....
# (11 = aberta confirmada pela placa)
```

**Se não tiver permissão na serial:**
```bash
# Com root (se disponível)
su -c "chmod 666 /dev/ttyS1"
su -c "printf '\x8A\x01\x01\x11\x9B' > /dev/ttyS1"
```

---

## PASSO 5 — Build do App React

```bash
cd web
npm install
npm run build
# Saída vai para: android/app/src/main/assets/www/
```

Copiar o arquivo `src/App.jsx` (o app consolidado) para `web/src/App.jsx`.

---

## PASSO 6 — Build e Instalação do APK

```bash
# Build completo (web + APK) e instalação
./scripts/deploy.sh all

# OU passo a passo:
./scripts/deploy.sh build-web
./scripts/deploy.sh build-apk
./scripts/deploy.sh install
```

**Instalar manualmente (APK já compilado):**
```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.preddita.locker/.MainActivity
```

---

## PASSO 7 — Configurar Modo Quiosque

```bash
./scripts/deploy.sh kiosk
```

**Configurações manuais adicionais (via ADB):**
```bash
# Tela sempre ligada
adb shell settings put system screen_off_timeout 2147483647

# Modo imersivo (sem barra de navegação/status)
adb shell settings put global policy_control immersive.full=*

# Definir como launcher padrão
adb shell cmd package set-home-activity com.preddita.locker/.MainActivity

# Reduzir animações (resposta mais rápida no touch)
adb shell settings put global window_animation_scale 0.5
adb shell settings put global transition_animation_scale 0.5
```

---

## PASSO 8 — Verificar Autostart

```bash
# Simular reboot para testar boot receiver
adb shell reboot

# Aguardar ~30 segundos e reconectar
adb connect 192.168.1.20:5555
adb shell "dumpsys activity | grep preddita"
# O app deve aparecer como atividade ativa
```

---

## PASSO 9 — Verificar Integração RS-485 pelo App

Abrir o painel Admin → aba **Diagnóstico → RS-485 Terminal**:

1. Clicar em **"Versão firmware"** → deve retornar `82 01 00 AB XX`
2. Clicar em **"Status canal"** → deve retornar `80 01 01 XX XX`
3. Clicar em **"Abrir canal"** → trava física do canal 1 deve abrir
4. Verificar **feedback ativo**: ligar e testar fechar a trava manualmente

---

## COMANDOS ADB ÚTEIS

```bash
# Logs em tempo real
./scripts/deploy.sh logs
# ou: adb logcat -v time PredditaLocker:D *:S

# Screenshot
adb exec-out screencap -p > screenshot.png

# Reiniciar o app sem reboot
adb shell am force-stop com.preddita.locker
adb shell am start -n com.preddita.locker/.MainActivity

# Verificar uso de memória
adb shell dumpsys meminfo com.preddita.locker

# Push de arquivo para o dispositivo
adb push arquivo.txt /sdcard/

# Checar permissões da serial
adb shell ls -la /dev/ttyS*

# Chrome DevTools (inspecionar a WebView)
# Abrir no Chrome: chrome://inspect
# Selecionar o dispositivo e "inspect"
```

---

## SOLUÇÃO DE PROBLEMAS

| Problema | Causa Provável | Solução |
|---|---|---|
| `adb: no devices` | ADB não habilitado | Ativar depuração USB nas opções do desenvolvedor |
| `unauthorized` | Não autorizado | Aceitar prompt no dispositivo |
| `stty: /dev/ttyS1: Permission denied` | Sem permissão | Tentar com `su` ou solicitar ao fabricante KS |
| Trava não abre | BCC incorreto | Verificar cálculo XOR no terminal de diagnóstico |
| Trava não abre | Endereço errado | Checar DIP switches na placa CM06 (endereço = 1) |
| App não abre na WebView | Build incorreto | Verificar se `dist/` foi copiado para `assets/www/` |
| Tela preta | WebView sem conteúdo | `adb logcat` para ver erros JavaScript |
| App fecha sozinho | OOM | Aumentar `largeHeap` no AndroidManifest |

---

## CONTATO E SUPORTE

**PREDDITA Tecnologia Ltda.**
Sistema: PSL-2025-001 · Versão: 1.0.0-alpha
Hardware: KS1062-N-ZY (Kaibei) + CM06-24-396-5557FB V2.0
Protocolo: Kecheng RS-485 V4.0

---
*Documento técnico interno — CONFIDENCIAL*
