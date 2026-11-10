// Teste dos leitores com as amostras reais. Uso (na pasta codigo):
//   npm install        (uma vez)
//   set SENHA_PDF_XP=xxxxx   (Windows; senha do PDF da fatura XP — não gravar em arquivo)
//   set NOME_TITULAR=Nome Completo do Titular   (opcional; precisa bater com o nome usado nas amostras reais
//                                                 para o teste de "transferência entre contas" funcionar certo)
//   node teste.mjs [nome-do-arquivo-para-listar-tudo]
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfLines } from './pdflines.mjs';
import './leitores.js';
const L = globalThis.Leitores;
const S = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'amostras');
const senhaXP = process.env.SENHA_PDF_XP;
// [arquivo, senha, total esperado da soma válida (null = sem conferência)]
const arqs = [
  ['extrato_de_10-10-2026_ate_09-11-2026.ofx', null, -4999.98],
  ['extrato_de_10-10-2026_ate_09-11-2026.csv', null, -4999.98],
  ['extrato_de_10-10-2026_ate_09-11-2026.pdf', null, -4999.98],
  ['Fatura2026-09-20.csv', null, -1920.42],          // = "fatura anterior" informada na fatura de outubro
  ['Fatura2026-10-20.pdf', senhaXP, -8990.84],       // = total da fatura
  ['sicoob_2026_11_09_20_52_20.pdf', null, -115.00],
  ['sicoob_2026_11_09_20_52_20.png', null, 'ERRO'],
  ['Extrato conta corrente - 102026.ofx', null, 3825.15],
  ['Extrato conta corrente - 102026.csv', null, 3825.15], // CSV original do BB = OFX
  ['Extrato conta corrente - 112026.pdf', null, 1698.91],
  ['fatura (1).pdf', null, -3419.24],                // = total da fatura BB
];
const verbose = process.argv[2];
let falhas = 0;
for (const [nome, senha, esperado] of arqs) {
  try {
    const r = await L.lerArquivo(nome, new Uint8Array(fs.readFileSync(path.join(S, nome))), {
      senha, nomesTitular: [process.env.NOME_TITULAR || 'Nome Completo do Titular'], linhasPDF: (b, pw) => pdfLines(pdfjs, b.slice(), pw) });
    const ok = r.lancamentos.filter(t => !t.ignorar), ig = r.lancamentos.filter(t => t.ignorar);
    const soma = Math.round(ok.reduce((s, t) => s + t.valor, 0) * 100) / 100;
    const passou = esperado === null || soma === esperado;
    if (!passou) falhas++;
    console.log(`${passou ? 'OK  ' : 'FALHA'} ${nome} → ${r.banco} ${r.tipo} ${r.competencia || ''} | ${r.lancamentos.length} lanç. (${ig.length} ignorados) | soma ${soma.toFixed(2)}${esperado !== null ? ' (esperado ' + esperado + ')' : ''}`);
    if (verbose === nome) for (const t of r.lancamentos) console.log(`   ${t.data} ${t.competencia} ${t.valor.toFixed(2).padStart(10)} ${t.descricao.slice(0, 55).padEnd(55)} | ${t.chave} ${t.portador ? '| ' + t.portador : ''}${t.ignorar ? ' [' + t.ignorar + ']' : ''}`);
  } catch (e) {
    const passou = esperado === 'ERRO' || (e.precisaSenha && !senha);
    if (!passou) falhas++;
    console.log(`${passou ? 'OK  ' : 'FALHA'} ${nome} → ${e.precisaSenha && !senha ? 'pulado: defina SENHA_PDF_XP' : 'erro: ' + e.message}`);
  }
}
console.log(falhas ? `\n${falhas} falha(s).` : '\nTodos os testes passaram.');
process.exit(falhas ? 1 : 0);
