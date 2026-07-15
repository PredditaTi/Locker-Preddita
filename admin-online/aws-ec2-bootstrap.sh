#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y ca-certificates curl unzip docker.io docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu || true

mkdir -p "$HOME/preddita-admin-online"

cat <<'MSG'
[PREDDITA] Bootstrap concluido.

Proximos passos:
1. Envie preddita-admin-online-servidor.zip para /home/ubuntu.
2. Rode:
   unzip -o ~/preddita-admin-online-servidor.zip -d ~/preddita-admin-online
   cd ~/preddita-admin-online
   cp .env.production.example .env
   nano .env
   docker compose -f docker-compose.prod.yml up -d --build

Se o usuario docker ainda pedir sudo, saia do SSH e entre de novo.
MSG
