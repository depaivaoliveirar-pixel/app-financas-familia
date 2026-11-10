// Teste do motor (regras, resumo do mês, sobreposição de período) com as amostras reais.
// Uso (na pasta codigo): node motorTeste.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfLines } from './pdflines.mjs';
import './leitores.js';
import './motor.js';
const L = globalThis.Leitores, M = globalThis.Motor;
const S = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'amostras');
const senhaXP = process.env.SENHA_PDF_XP;
const opcoes = { nomesTitular: ['Ricardo de Paiva Oliveira'], linhasPDF: (b, pw) => pdfLines(pdfjs, b.slice(), pw) };

let falhas = 0;
function check(desc, condicao) {
  console.log(`${condicao ? 'OK  ' : 'FALHA'} ${desc}`);
  if (!condicao) falhas++;
}

async function ler(nome, senha) {
  return L.lerArquivo(nome, new Uint8Array(fs.readFileSync(path.join(S, nome))), Object.assign({}, opcoes, { senha }));
}

const estado = M.estadoNovo('padrao', ['Ricardo de Paiva Oliveira']);

// 1) Primeira importação: extrato BB (OFX) de outubro/2026 — não deve haver aviso de sobreposição.
const bbOfx = await ler('Extrato conta corrente - 102026.ofx');
const r1 = M.importar(estado, bbOfx);
check('1ª importação (OFX) não avisa sobreposição', r1.aviso === null);
check('1ª importação trouxe lançamentos novos', r1.novos > 0 && r1.duplicados === 0);

// 2) Mesmo período, mesmo conteúdo, mas em CSV (formato diferente) — deve avisar sobreposição,
//    e como os IDs são diferentes do OFX, entram como "novos" (duplicando o período: limitação conhecida e avisada).
const bbCsv = await ler('Extrato conta corrente - 102026.csv');
const r2a = M.importar(estado, bbCsv);
check('importar o mesmo período em CSV avisa sobreposição com o OFX', typeof r2a.aviso === 'string' && /já estar importado/.test(r2a.aviso));
check('CSV duplicado não soma na mesma conta sem avisar', r2a.novos > 0);

// 3) Importar o mesmo arquivo OFX de novo: é duplicado real (mesmos IDs), não deve gerar lançamentos novos.
//    O aviso de sobreposição continua aparecendo porque o CSV (formato diferente, passo 2) ainda está lá.
const r1b = M.importar(estado, await ler('Extrato conta corrente - 102026.ofx'));
check('reimportar o mesmo arquivo OFX não aumenta lançamentos', r1b.novos === 0);
check('reimportar continua avisando por causa do CSV de formato diferente já importado', typeof r1b.aviso === 'string');

// 4) Fatura XP de outubro (PDF com senha) e Sicoob de novembro — períodos diferentes, sem sobreposição.
if (senhaXP) {
  const xpFatura = M.importar(estado, await ler('Fatura2026-10-20.pdf', senhaXP));
  check('fatura XP (PDF) importada sem aviso (conta/competência diferentes)', xpFatura.aviso === null);
} else {
  console.log('(pulado: defina SENHA_PDF_XP para testar a fatura XP em PDF)');
}
const xpFaturaSet = M.importar(estado, await ler('Fatura2026-09-20.csv'));
check('fatura XP de setembro importada sem aviso', xpFaturaSet.aviso === null);
const sicoob = M.importar(estado, await ler('sicoob_2026_11_09_20_52_20.pdf'));
check('extrato Sicoob importado sem aviso', sicoob.aviso === null);

// 5) "Novidades para classificar": todo estabelecimento novo deve aparecer agrupado por chave, sem repetir ignorados.
const antes = M.novidades(estado);
check('há novidades para classificar antes de ensinar regras', antes.length > 0);
check('nenhum ignorado aparece em novidades', antes.every(g => g.quantidade > 0));

// 6) Ensinar uma regra e verificar que ela se aplica a todos os lançamentos daquele estabelecimento,
//    inclusive os que ainda não existiam quando a regra foi criada.
const grupo = antes[0];
M.classificar(estado, grupo.chave, 'Pessoal', 'Outros');
const depoisQtdMesma = Object.values(estado.lancamentos).filter(t => t.chave === grupo.chave);
check('classificar aplica tipo/categoria a todos os lançamentos da chave', depoisQtdMesma.every(t => t.tipo === 'Pessoal' && t.categoria === 'Outros'));
check('novidades diminuiu depois de classificar', M.novidades(estado).length === antes.length - 1);

// 7) Resumo do mês: conferir que entrou/saiu/sobrou batem com os lançamentos válidos daquele mês,
//    e que a soma por categoria fecha com o total "saiu".
const meses = M.mesesComLancamentos(estado);
check('há meses com lançamentos', meses.length > 0);
for (const comp of meses) {
  const res = M.resumoMes(estado, comp);
  const somaCategorias = Object.values(res.porCategoria).reduce((s, v) => s + v, 0);
  const somaTipos = Object.values(res.pessoalXcasa).reduce((s, v) => s + v, 0);
  const okCat = Math.abs(somaCategorias - res.saiu) < 0.01;
  const okTipo = Math.abs(somaTipos - res.saiu) < 0.01;
  check(`resumo de ${comp}: soma por categoria confere com "saiu" (${res.saiu.toFixed(2)})`, okCat);
  check(`resumo de ${comp}: soma Pessoal/Casa/Sem classificar confere com "saiu"`, okTipo);
  check(`resumo de ${comp}: sobrou = entrou - saiu`, Math.abs(res.sobrou - (res.entrou - res.saiu)) < 0.01);
}

// 8) Itens "Casa" devem respeitar o filtro de tipo e competência.
M.classificar(estado, grupo.chave, 'Casa', 'Casa e contas', 'Variável');
const casaTodas = M.itensCasa(estado);
check('itensCasa só traz lançamentos tipo Casa', casaTodas.every(t => t.tipo === 'Casa'));

// 9) Serialização: ida e volta deve preservar o estado (comparação por JSON).
const texto = M.serializar(estado);
const voltou = M.desserializar(texto);
check('serializar/desserializar preserva o estado', JSON.stringify(voltou) === JSON.stringify(estado));
check('desserializar rejeita lixo', (() => { try { M.desserializar('{"nada":1}'); return false; } catch (e) { return true; } })());

// 10) Categorias por perfil.
check('perfil padrão tem a lista curta de categorias', M.categoriasPadrao('padrao').includes('Tarifas e juros'));
check('perfil priscila usa as categorias da planilha da família', M.categoriasPadrao('priscila').includes('Aporte metas'));

// 11) Lançamento manual + conciliação com o extrato. Estado novo, independente do de cima.
const e2 = M.estadoNovo('padrao', ['Ricardo de Paiva Oliveira']);

// 11a) Validações básicas.
check('lançarManual exige os campos obrigatórios', (() => { try { M.lancarManual(e2, { data: '2026-11-05' }); return false; } catch (err) { return err.amigavel; } })());
check('lançarManual exige frequência quando tipo é Casa', (() => {
  try { M.lancarManual(e2, { data: '2026-11-05', descricao: 'Jantar', valor: -100, tipo: 'Casa', categoria: 'Lazer', banco: 'XP', origem: 'cartao', conta: 'XP cartão', competencia: '2026-12' }); return false; }
  catch (err) { return err.amigavel; }
})());
check('lançarManual exige competência quando origem é cartão', (() => {
  try { M.lancarManual(e2, { data: '2026-11-05', descricao: 'Jantar', valor: -100, tipo: 'Casa', frequencia: 'Esporádica', categoria: 'Lazer', banco: 'XP', origem: 'cartao', conta: 'XP cartão' }); return false; }
  catch (err) { return err.amigavel; }
})());

// 11b) Conta: concilia automaticamente com o extrato quando bate valor + conta + data próxima (até 2 dias).
const manualConta = M.lancarManual(e2, { data: '2026-11-05', descricao: 'Jantar aniversário sogra (Casa)', valor: -150, tipo: 'Casa', frequencia: 'Esporádica', categoria: 'Lazer', banco: 'BB', origem: 'conta', conta: 'BB conta' });
check('lançamento manual de conta entra no resumo antes de ser conferido', M.resumoMes(e2, '2026-11').saiu === 150);
const extratoConta = {
  banco: 'BB', tipo: 'Conta', arquivo: 'extrato-teste.ofx',
  lancamentos: [{ id: 'BB:teste:1', banco: 'BB', origem: 'conta', conta: 'BB conta 1234', data: '2026-11-06', competencia: '2026-11', descricao: 'PIX ENVIADO RESTAURANTE XYZ', chave: 'RESTAURANTE XYZ', valor: -150, portador: '', parcela: '', ignorar: null, formato: 'OFX' }]
};
const r11b = M.importar(e2, extratoConta);
check('conciliação automática (conta) marca o lançamento manual como conciliado', manualConta.conciliado === true);
check('conciliação automática ignora o lançamento do extrato (não conta em dobro)', e2.lancamentos['BB:teste:1'].ignorar !== null);
check('resumo do mês continua com só 1x a despesa depois de conferida', M.resumoMes(e2, '2026-11').saiu === 150);

// 11c) Cartão: concilia por competência (mês da fatura), não por data exata da compra.
const manualCartao = M.lancarManual(e2, { data: '2026-11-20', competencia: '2026-12', descricao: 'Presente de Natal (Pessoal)', valor: -200, tipo: 'Pessoal', categoria: 'Lazer', banco: 'XP', origem: 'cartao', conta: 'XP cartão' });
const faturaXP = {
  banco: 'XP', tipo: 'Fatura', arquivo: 'fatura-teste.csv', competencia: '2026-12',
  lancamentos: [{ id: 'XP:teste:1', banco: 'XP', origem: 'cartao', conta: 'XP cartão', data: '2026-11-18', competencia: '2026-12', descricao: 'LOJA DE PRESENTES', chave: 'LOJA DE PRESENTES', valor: -200, portador: 'RICARDO', parcela: '', ignorar: null, formato: 'CSV' }]
};
M.importar(e2, faturaXP);
check('conciliação automática (cartão) usa a competência, não a data da compra', manualCartao.conciliado === true);

// 11d) Empate (dois manuais com mesmo valor): não decide sozinho, fica pendente para a pessoa escolher.
const m1 = M.lancarManual(e2, { data: '2026-11-10', descricao: 'Mercado (Casa) 1', valor: -80, tipo: 'Casa', frequencia: 'Variável', categoria: 'Mercado', banco: 'Sicoob', origem: 'conta', conta: 'Sicoob conta' });
const m2 = M.lancarManual(e2, { data: '2026-11-11', descricao: 'Mercado (Casa) 2', valor: -80, tipo: 'Casa', frequencia: 'Variável', categoria: 'Mercado', banco: 'Sicoob', origem: 'conta', conta: 'Sicoob conta' });
const extratoEmpate = {
  banco: 'Sicoob', tipo: 'Conta', arquivo: 'sicoob-teste.pdf',
  lancamentos: [{ id: 'Sicoob:teste:1', banco: 'Sicoob', origem: 'conta', conta: 'Sicoob conta', data: '2026-11-11', competencia: '2026-11', descricao: 'DEB MERCADO', chave: 'DEB MERCADO', valor: -80, portador: '', parcela: '', ignorar: null, formato: 'PDF' }]
};
M.importar(e2, extratoEmpate);
const pendentes = M.conciliacoesPendentesDetalhadas(e2);
check('empate entre manuais gera conciliação pendente (não decide sozinho)', pendentes.length === 1 && pendentes[0].candidatos.length === 2);
check('nenhum dos dois manuais foi marcado sozinho enquanto está pendente', !m1.conciliado && !m2.conciliado);
M.confirmarConciliacao(e2, 'Sicoob:teste:1', m1.id);
check('depois de eu escolher, o manual escolhido fica conciliado', m1.conciliado === true && e2.lancamentos['Sicoob:teste:1'].ignorar !== null);
check('o outro manual (não escolhido) continua pendente, para eu conferir depois', m2.conciliado === false);
check('a lista de pendentes de conciliação esvazia depois de resolvida', M.conciliacoesPendentesDetalhadas(e2).length === 0);
check('pendentesManuais traz só quem ainda não foi conferido', M.pendentesManuais(e2).every(t => !t.conciliado) && M.pendentesManuais(e2).some(t => t.id === m2.id));

// 12) Exportação CSV para o Excel (resumo do mês).
const csvResumo = M.exportarResumoCSV(e2, '2026-11');
check('CSV do resumo tem cabeçalho de lançamentos', csvResumo.includes('Data;Descrição;Categoria;Tipo;Valor;Conta;Banco'));
check('CSV do resumo traz o valor "Saiu" calculado', csvResumo.includes('Saiu;'));
check('CSV do resumo lista o lançamento manual não conciliado (m2)', csvResumo.includes('Mercado (Casa) 2'));

// 13) Exportação CSV para a planilha da família ("Casa"): exige nome cadastrado antes.
check('exportarCasaCSV exige nome cadastrado', (() => { try { M.exportarCasaCSV(e2, '2026-11'); return false; } catch (err) { return err.amigavel; } })());
check('definirNomePessoa rejeita nome vazio', (() => { try { M.definirNomePessoa(e2, '   '); return false; } catch (err) { return err.amigavel; } })());
M.definirNomePessoa(e2, 'Ricardo');
const casaNov = M.exportarCasaCSV(e2, '2026-11');
check('CSV da Casa tem cabeçalho com as colunas da planilha da família', casaNov.texto.startsWith('Data;Descrição;Categoria;Tipo;Pago por;Origem;Valor;Observação;ID'));
// Nesta altura, os únicos itens Casa do mês são lançamentos manuais (os importados foram conciliados e
// ficaram "ignorar"): "Pago por"/"Origem" devem vir como a exceção prevista na planilha real da família
// (aba Regras: despesa comum normal vem da conta conjunta/cartão comum; manual é sempre a exceção).
check('CSV da Casa marca lançamento manual como exceção com o nome cadastrado', casaNov.texto.includes(';Ricardo (exceção);Lançamento manual;'));
check('CSV da Casa só traz itens Casa do mês pedido', casaNov.quantidade === M.itensCasa(e2, '2026-11').length && casaNov.quantidade > 0);
check('CSV da Casa traz o valor positivo (despesa)', /;80\.00;/.test(casaNov.texto));
M.marcarCasaEnviada(e2, casaNov.ids);
check('marcarCasaEnviada grava a data de envio em cada item', casaNov.ids.every(id => !!e2.lancamentos[id].enviadoCasaEm));

// 14) "Pago por"/"Origem" no fluxo normal (extrato/fatura importado, Casa): deve usar "Conta conjunta" /
// "Cartão comum" (e não o nome de ninguém), conforme a regra já decidida na planilha real da família
// (Regras, 09/11/2026: despesa comum sempre pela conta conjunta BB ou pelo cartão comum).
const e3 = M.estadoNovo('padrao', ['Ricardo de Paiva Oliveira']);
M.definirNomePessoa(e3, 'Priscila');
const extratoConjunta = {
  banco: 'BB', tipo: 'Conta', arquivo: 'conjunta-teste.ofx',
  lancamentos: [{ id: 'BB:conjunta:1', banco: 'BB', origem: 'conta', conta: 'BB conta 1234', data: '2026-11-07', competencia: '2026-11', descricao: 'PADARIA DO BAIRRO', chave: 'PADARIA DO BAIRRO', valor: -45, portador: '', parcela: '', ignorar: null, formato: 'OFX' }]
};
const faturaCartaoComum = {
  banco: 'BB', tipo: 'Fatura', arquivo: 'cartaocomum-teste.pdf', competencia: '2026-11',
  lancamentos: [{ id: 'BB:cartaocomum:1', banco: 'BB', origem: 'cartao', conta: 'BB cartão', data: '2026-11-08', competencia: '2026-11', descricao: 'FARMACIA', chave: 'FARMACIA', valor: -60, portador: 'PRISCILA', parcela: '', ignorar: null, formato: 'PDF' }]
};
M.importar(e3, extratoConjunta);
M.importar(e3, faturaCartaoComum);
M.classificar(e3, 'PADARIA DO BAIRRO', 'Casa', 'Mercado', 'Variável');
M.classificar(e3, 'FARMACIA', 'Casa', 'Saúde', 'Variável');
const casaConjunta = M.exportarCasaCSV(e3, '2026-11');
check('item de extrato de conta vira "Conta conjunta" / "Extrato conjunta"', casaConjunta.texto.includes(';Conta conjunta;Extrato conjunta;'));
check('item de fatura de cartão vira "Cartão comum" / "Fatura cartão comum"', casaConjunta.texto.includes(';Cartão comum;Fatura cartão comum;'));
check('nenhum item do fluxo normal usa o nome da pessoa em "Pago por"', !casaConjunta.texto.includes('Priscila'));

// 14b) Rótulos de "Pago por"/"Origem" são configuráveis — outra família (ex.: pai, irmão, com outra
// estrutura) pode usar outros nomes sem mudar o motor, só cadastrando os próprios rótulos.
M.definirRotulosCasa(e3, { contaComum: 'Conta principal', extratoContaComum: 'Extrato da conta', cartaoComum: 'Cartão principal', faturaCartaoComum: 'Fatura do cartão' });
const casaRotuloCustom = M.exportarCasaCSV(e3, '2026-11');
check('com rótulos customizados, o CSV usa o nome configurado (não o padrão)', casaRotuloCustom.texto.includes(';Conta principal;Extrato da conta;') && casaRotuloCustom.texto.includes(';Cartão principal;Fatura do cartão;'));
check('definirRotulosCasa exige todos os campos preenchidos', (() => { try { M.definirRotulosCasa(e3, { contaComum: '' }); return false; } catch (err) { return err.amigavel; } })());

// 15) Orçamento por categoria + "ritmo do mês" (opcional — ideia adotada do Mobills/Monarch).
// Em e3, novembro/2026 (30 dias) tem: Mercado -45 (PADARIA DO BAIRRO), Saúde -60 (FARMACIA).
check('definirLimiteCategoria exige categoria', (() => { try { M.definirLimiteCategoria(e3, '', 100); return false; } catch (err) { return err.amigavel; } })());
check('categoria sem limite não aparece no orçamento', M.orcamentoMes(e3, '2026-11', new Date(2026, 10, 15)).categorias.length === 0);

M.definirLimiteCategoria(e3, 'Mercado', 100); // 45/100 = 45% gasto
const meio = M.orcamentoMes(e3, '2026-11', new Date(2026, 10, 15)); // dia 15 de 30 = 50% do mês
check('"ritmo do mês" calcula o % do mês certo (dia 15 de 30 = 50%)', meio.percentualMesPassado === 50);
check('categoria dentro do ritmo esperado fica "ok"', meio.categorias.find(c => c.categoria === 'Mercado').ritmo === 'ok');

M.definirLimiteCategoria(e3, 'Mercado', 40); // gasto (45) > limite (40)
const estourou = M.orcamentoMes(e3, '2026-11', new Date(2026, 10, 15));
check('categoria que passou do limite fica "estourou"', estourou.categorias.find(c => c.categoria === 'Mercado').ritmo === 'estourou');

M.definirLimiteCategoria(e3, 'Saúde', 70); // gasto 60/70 = 85,7% com só 17% do mês passado
const inicioMes = M.orcamentoMes(e3, '2026-11', new Date(2026, 10, 5)); // dia 5 de 30 ≈ 17%
check('gastar bem mais rápido que o ritmo do mês fica "atencao" (sem estourar)', inicioMes.categorias.find(c => c.categoria === 'Saúde').ritmo === 'atencao');

M.definirLimiteCategoria(e3, 'Mercado', 0); // remove o limite
check('limite 0 remove o controle da categoria', M.orcamentoMes(e3, '2026-11', new Date(2026, 10, 15)).categorias.every(c => c.categoria !== 'Mercado'));

check('mês já encerrado conta como 100% do mês passado', M.orcamentoMes(e3, '2026-09', new Date(2026, 10, 15)).percentualMesPassado === 100);
check('mês futuro conta como 0% do mês passado', M.orcamentoMes(e3, '2027-01', new Date(2026, 10, 15)).percentualMesPassado === 0);

console.log(falhas ? `\n${falhas} falha(s).` : '\nTodos os testes do motor passaram.');
process.exit(falhas ? 1 : 0);
