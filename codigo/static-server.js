// Servidor estático simples, sem dependências, só para testar o app localmente
// (a File System Access API exige http://localhost, não funciona abrindo o arquivo direto).
// Uso: node static-server.js [porta]
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const raiz = path.dirname(fileURLToPath(import.meta.url));
const porta = Number(process.argv[2]) || 5173;

const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ofx': 'text/plain', '.csv': 'text/csv', '.pdf': 'application/pdf' };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/App Finanças da Família.html';
  const caminho = path.normalize(path.join(raiz, '..', p)); // raiz do projeto (um nível acima de codigo/)
  if (!caminho.startsWith(path.normalize(path.join(raiz, '..')))) { res.writeHead(403); res.end('Proibido'); return; }
  fs.readFile(caminho, (err, dados) => {
    if (err) { res.writeHead(404); res.end('Não encontrado: ' + p); return; }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(caminho)] || 'application/octet-stream' });
    res.end(dados);
  });
}).listen(porta, () => console.log('Servindo em http://localhost:' + porta));
