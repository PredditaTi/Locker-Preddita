# Deploy PREDDITA Locker em AWS EC2

## Arquitetura

- EC2 Ubuntu online
- Docker Compose
- App Node em `preddita-admin-online`
- Caddy como proxy HTTPS automatico
- Volume Docker persistente para `/data/state.json`
- Subdominio: `locker.preddita.com`

## EC2 recomendada

- AMI: Ubuntu Server 24.04 LTS ou 22.04 LTS
- Arquitetura: x86_64
- Tipo: `t3.micro`
- Storage: 20 a 30 GB gp3
- Elastic IP associado

## Security Group

Libere:

- SSH `22`: apenas o seu IP
- HTTP `80`: `0.0.0.0/0` e `::/0`
- HTTPS `443`: `0.0.0.0/0` e `::/0`

Nao precisa liberar a porta `8787` publicamente; o Caddy acessa essa porta por rede interna do Docker.

## DNS

Crie um registro `A`:

```text
locker.preddita.com -> Elastic IP da EC2
```

## Instalar Docker na EC2

Envie ou cole o conteudo de `aws-ec2-bootstrap.sh` na EC2 e rode:

```bash
bash aws-ec2-bootstrap.sh
```

## Enviar o pacote

No Windows, a partir da pasta onde esta a chave `.pem`:

```powershell
scp -i .\preddita-aws.pem "C:\Users\Usuario\Documents\App armário preddita\entrega-dispositivo\preddita-admin-online-servidor.zip" ubuntu@IP_DA_EC2:/home/ubuntu/
```

## Subir o painel

Na EC2:

```bash
unzip -o ~/preddita-admin-online-servidor.zip -d ~/preddita-admin-online
cd ~/preddita-admin-online
cp .env.production.example .env
nano .env
docker compose -f docker-compose.prod.yml up -d --build
```

## Variaveis principais do `.env`

```text
PREDDITA_DOMAIN=locker.preddita.com
PREDDITA_ADMIN_USERS='[{"username":"preddita","name":"Admin Geral PREDDITA","role":"super_admin","passwordHash":"scrypt-v1$...","tenantId":"residencial-aurora","lockerIds":["*"]},{"username":"sindico","name":"Sindico","role":"sindico","passwordHash":"scrypt-v1$...","tenantId":"residencial-aurora","lockerIds":["ks1062-aurora"]}]'
PREDDITA_ADMIN_SESSION_TTL_MS=28800000
PREDDITA_DEVICE_KEY=crie-uma-chave-forte-do-armario
PREDDITA_DEVICE_KEYS={"ks1062-aurora":"crie-uma-chave-forte-do-armario"}
PREDDITA_DEVICE_AUTH_MODE=hmac
PREDDITA_DEVICE_SIGNATURE_TTL_MS=120000
PREDDITA_SMTP_USER=enviopreddita@gmail.com
PREDDITA_SMTP_PASS=senha-de-app-google
```

Gere os `passwordHash` antes de editar o `.env`, a partir da raiz do repositorio:

```bash
read -s PASSWORD && printf '%s\n' "$PASSWORD" | node scripts/generate-admin-password.mjs --username sindico --name "Sindico" --role sindico --locker-id ks1062-aurora
unset PASSWORD
```

Com Postgres, reiniciar o processo preserva sessoes validas e revogadas. Mantenha
uma unica replica nesta versao porque as mutacoes do snapshot de cada locker e o
worker de notificacoes ainda nao usam coordenacao distribuida.

## Verificar

```bash
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs -f
```

Depois acesse:

```text
https://locker.preddita.com
```

## APK online

Depois que o dominio estiver no ar, compile o APK apontando para a nuvem:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\Usuario\Documents\App armário preddita\preddita-entregas-retiradas\scripts\build-online-release.ps1" `
  -ServerUrl "https://locker.preddita.com" `
  -LockerId "ks1062-aurora"
```

O APK nao contem a chave. Depois de instalar, use `Provisionar conexao` no modo
diagnostico do equipamento e informe a chave correspondente em
`PREDDITA_DEVICE_KEYS`.
