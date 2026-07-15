# Comparativo de mercado - PREDDITA Locker 2.0

Pesquisa feita para orientar a v2 experimental. Fontes principais:

- Luxer One Mobile App: https://www.luxerone.com/luxer-one-mobile-app/
- Luxer One smart package lockers: https://www.luxerone.com/smart-locker-solutions/smart-package-lockers/
- Luxer One suporte/fluxos operacionais: https://www.luxerone.com/support/
- Bloq.it smart locker software: https://www.bloq.it/products/software
- Bloq.it tests/certifications: https://www.bloq.it/products/tests-certifications
- Smiota package lockers: https://dev.smiota.com/
- AWS IoT Device Shadows: https://docs.aws.amazon.com/iot/latest/developerguide/iot-device-shadows.html
- AWS IoT Secure Tunneling: https://docs.aws.amazon.com/iot/latest/developerguide/secure-tunneling.html
- Android WebView native bridge risks: https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges

## Padroes fortes encontrados

1. **Morador com autonomia**
   - App, portal ou fluxo simples para ver entregas, receber notificacoes e abrir locker.
   - Luxer One destaca abertura pelo celular, lista de entregas e ajustes de acessibilidade.

2. **Entrega em poucos passos**
   - Identificar morador por sobrenome/unidade.
   - Escanear codigo da encomenda quando existir.
   - Selecionar tamanho do volume.
   - Abrir automaticamente uma porta compativel.

3. **Notificacao multicanal**
   - PIN, QR, e-mail, SMS/app push.
   - Historico de notificacoes e suporte para reenviar codigo.

4. **Admin com rastreabilidade**
   - Bloq.it enfatiza logs, analytics, controle remoto e diagnostico de saude.
   - Smiota cita abertura de lockers, gestao de retiradas vencidas e admin no webapp/tablet.

5. **Saude do locker**
   - Uptime, ultimo sinal, status de rede, status de sensores, falhas, manutencao e diagnostico remoto.
   - Bloq.it Vitals reforca monitoramento 24/7, issue management e network health.

6. **Hardware agnostico e integravel**
   - Bloq.it vende uma camada agnostica para diferentes fabricantes.
   - O caminho para PREDDITA e transformar o protocolo RS-485 atual em driver plugavel.

7. **Operacao offline**
   - O armario precisa continuar operando localmente quando a internet cair.
   - A nuvem deve reconciliar depois, sem perder auditoria.

8. **Suporte remoto seguro**
   - AWS IoT Secure Tunneling e um caminho para diagnostico remoto sem abrir ADB/rede local.
   - Device Shadows ajudam a separar estado desejado pelo painel e estado reportado pelo armario.

## Onde a PREDDITA v2 deve ser diferente

- Ser mais simples que grandes plataformas no inicio, mas com arquitetura que nao bloqueie escala.
- Focar no nicho de condominios brasileiros, com cadastro de moradores, unidades, torres, CPF/e-mail/telefone e operacao por sindico.
- Manter controle local do hardware para nao depender da internet para retirada.
- Ter comissionamento guiado: quantidade de portas, tamanho fisico, sensor invertido, board, porta serial e teste de cada trava.
- Criar uma trilha clara de suporte: "comando criado", "entregue ao armario", "porta acionada", "sensor confirmou", "morador retirou".

## Melhorias implementadas ja nesta v2 local

- O admin ganhou resumo de saude operacional.
- Abertura remota agora tem endpoint de acompanhamento por comando.
- Comandos ganharam timeline.
- O painel deixa claro se o armario esta sem sinal recente.
- Abertura remota pode ser bloqueada quando o device esta stale/sem serial.
- O servidor tem rate limit, sessoes HttpOnly, CSRF e papeis administrativos.
- A persistencia JSON ficou atomica e com backup local, ate migrarmos para banco real.

## Gaps que continuam para uma v2 de verdade

- Banco real.
- Login real.
- MFA e papeis.
- HTTPS/dominio definitivo.
- App do morador ou portal web.
- SMS/WhatsApp/push alem de e-mail.
- AWS IoT Core ou MQTT.
- Atualizacao remota do APK.
- Testes de UI/kiosk automatizados.
- LGPD: retencao, mascaramento de CPF, exportacao e exclusao.
