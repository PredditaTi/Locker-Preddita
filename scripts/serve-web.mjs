import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packagedSiteDir = join(__dirname, 'site');
const projectSiteDir = join(__dirname, '..', 'android', 'app', 'src', 'main', 'assets', 'www');
const rootDir = existsSync(packagedSiteDir) ? packagedSiteDir : projectSiteDir;
const port = Number(process.env.PORT || 4173);
const host = '0.0.0.0';

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function getLanUrls(serverPort) {
  const nets = networkInterfaces();
  const urls = [];

  for (const net of Object.values(nets)) {
    for (const address of net || []) {
      if (address.family === 'IPv4' && !address.internal) {
        urls.push(`http://${address.address}:${serverPort}`);
      }
    }
  }

  return urls;
}

function resolveFile(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const candidate = safePath === '/' ? '/index.html' : safePath;
  const fullPath = join(rootDir, candidate);

  if (existsSync(fullPath) && statSync(fullPath).isFile()) {
    return fullPath;
  }

  return join(rootDir, 'index.html');
}

const server = http.createServer((req, res) => {
  try {
    const requestUrl = req.url || '/';
    const remote = req.socket.remoteAddress || 'unknown';
    console.log(`[REQ] ${remote} ${requestUrl}`);

    if (requestUrl === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    const filePath = resolveFile(requestUrl);
    const ext = extname(filePath).toLowerCase();
    const contentType = contentTypes[ext] || 'application/octet-stream';

    res.writeHead(200, { 'Content-Type': contentType });
    createReadStream(filePath).pipe(res);
  } catch (error) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Erro ao servir a versao web: ${error.message}`);
  }
});

server.listen(port, host, () => {
  console.log('PREDDITA Entregas - Servidor web pronto');
  console.log(`Arquivos: ${rootDir}`);
  console.log(`Local: http://localhost:${port}`);

  for (const url of getLanUrls(port)) {
    console.log(`Rede:  ${url}`);
  }

  console.log('');
  console.log('Abra um dos enderecos acima no navegador do dispositivo.');
});
