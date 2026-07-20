# Passo a Passo - Redesign Publico do App do Armario

> Este documento registra a implementacao da interface publica V3. O proximo
> ciclo visual e operacional esta definido no
> [plano do Kiosk V4 e melhorias](PLANO-IMPLEMENTACAO-MELHORIAS-REDESIGN-2026-07-20.md).

## Fase 1 - Base Segura

1. Criar testes para as novas regras de experiencia publica.
2. Garantir que o entregador so veja PIN/QR quando o apartamento nao tiver e-mail.
3. Garantir que a retirada por PIN valide automaticamente ao completar 6 numeros.

## Fase 2 - Nova Interface Publica

4. Criar textos publicos centralizados, sem termos tecnicos.
5. Criar componentes novos para Home, Entregador e Retirada.
6. Conectar os componentes novos na logica atual de abertura de portas.

## Fase 3 - Visual de Autoatendimento

7. Aplicar CSS novo com telas grandes, poucas escolhas e botoes de toque.
8. Validar em tela `1024x600`, sem scroll externo.
9. Ajustar densidade visual ate caber bem no painel do armario.

## Fase 4 - Validacao

10. Rodar testes de workflow, QR, smoke do painel, auditoria e build.
11. Gerar APK release.
12. Instalar no armario via ADB.

## Fase 5 - Teste Fisico

13. Testar entrega que cabe na porta pequena.
14. Testar entrega que nao cabe e precisa de porta grande.
15. Testar retirada por PIN.
16. Conferir se eventos offline e e-mail continuam sendo enviados ao painel.

## Status da Execucao - 09/07/2026

- Interface publica V3 aplicada no app do armario.
- Home publica ficou com apenas duas escolhas: entregar encomenda e retirar encomenda.
- Tela do entregador foi validada em `1024x600` com teclado numerico e cards de apartamento sem scroll.
- Tela de retirada por PIN foi validada em `1024x600` sem botao redundante; ao completar 6 numeros, o app confere automaticamente.
- Testes automatizados executados: workflow, QR scanner, smoke do admin, auditorias e build web.
- APK release gerada e instalada no armario `KS1062-N-ZY` via ADB.
- App confirmado em primeiro plano no pacote `com.preddita.entregaslocker`.

## Proximo Teste no Armario

1. Toque em `Entregar encomenda`.
2. Digite ou toque em um apartamento.
3. Confirme se abriu uma porta pequena.
4. Se a encomenda couber, feche a porta e toque em `Item guardado`.
5. Se nao couber, toque em `Nao coube`, feche a porta pequena e confirme se uma porta grande abre.
6. Toque em `Retirar encomenda`, digite um PIN valido e confirme se a porta correta abre.
