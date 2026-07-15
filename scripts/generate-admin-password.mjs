#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { hashAdminPassword } from '../admin-online/adminAuth.mjs';

function parseArgs(argv) {
  const args = {
    username: '',
    name: '',
    role: 'sindico',
    tenantId: 'residencial-aurora',
    lockerIds: ['ks1062-aurora'],
    hashOnly: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--username') { args.username = next || ''; index += 1; }
    else if (arg === '--name') { args.name = next || ''; index += 1; }
    else if (arg === '--role') { args.role = next || ''; index += 1; }
    else if (arg === '--tenant-id') { args.tenantId = next || ''; index += 1; }
    else if (arg === '--locker-id') { args.lockerIds = String(next || '').split(',').map((item) => item.trim()).filter(Boolean); index += 1; }
    else if (arg === '--hash-only') args.hashOnly = true;
    else if (arg === '--help' || arg === '-h') {
      console.log('Uso: printf %s "$SENHA" | node scripts/generate-admin-password.mjs --username USER --name NOME --role PAPEL --locker-id LOCKER');
      process.exit(0);
    } else {
      throw new Error(`Argumento desconhecido: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
const password = readFileSync(0, 'utf8').replace(/[\r\n]+$/, '');
const passwordHash = hashAdminPassword(password);

if (args.hashOnly) {
  console.log(passwordHash);
} else {
  if (!args.username) throw new Error('--username e obrigatorio.');
  console.log(JSON.stringify({
    username: args.username,
    name: args.name || args.username,
    role: args.role,
    passwordHash,
    tenantId: args.tenantId,
    lockerIds: args.lockerIds,
  }, null, 2));
}
