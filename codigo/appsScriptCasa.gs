/**
 * Finanças da Família — importa os gastos "Casa" exportados pelo app para a aba Lançamentos
 * da planilha da família. Roda dentro do Google Sheets (Apps Script), não precisa de senha
 * nem de credencial nenhuma: é a sua própria conta Google acessando sua própria planilha e
 * pasta do Drive.
 *
 * ---------------------------------------------------------------------------
 * COMO INSTALAR (uma vez só, por quem administra a planilha):
 * 1. Abra a planilha da família no navegador.
 * 2. Menu "Extensões" > "Apps Script" (abre numa aba nova).
 * 3. Apague o que estiver escrito em "Código.gs" e cole todo o conteúdo deste arquivo no lugar.
 * 4. Clique no ícone de disquete (Salvar projeto). Pode dar o nome que quiser ao projeto,
 *    ex. "Importar Casa".
 * 5. Volte para a aba da planilha e recarregue a página (F5).
 * 6. Vai aparecer um menu novo chamado "Finanças da Família" com o item
 *    "Importar gastos da Casa". Clique nele uma vez.
 * 7. Na primeira vez, o Google vai pedir autorização ("Revisar permissões" > escolha sua
 *    conta > "Avançado" > "Acessar [nome da planilha] (não seguro)" — isso é normal para
 *    scripts feitos por você mesmo; o aviso aparece porque o script não foi publicado na
 *    loja do Google, não porque algo está errado).
 *
 * ---------------------------------------------------------------------------
 * COMO USAR, dia a dia:
 * Sempre que alguém da família mandar o arquivo da Casa (o app gera um CSV com nome
 * começando com "Casa_") para a pasta combinada do Google Drive, abra a planilha e use o
 * menu "Finanças da Família" > "Importar gastos da Casa". Pode clicar quantas vezes
 * quiser e a qualquer momento: o script nunca lança o mesmo item duas vezes (ele guarda
 * o ID de cada lançamento, escondido na coluna J, e pula quem já foi lançado antes).
 *
 * ---------------------------------------------------------------------------
 * O QUE PRECISA EXISTIR NA PLANILHA ANTES DE USAR:
 * - Uma aba com o nome exato definido em NOME_DA_ABA abaixo (hoje: "Lançamentos"), com
 *   cabeçalho na linha 1: A Data | B Mês | C Descrição | D Categoria | E Tipo | F Pago por |
 *   G Origem | H Valor | I Observação. A coluna J é só para controle do script (pode ficar
 *   oculta — não precisa cabeçalho nela, mas não apague o que tiver lá).
 * - Uma pasta no Google Drive com o nome exato definido em NOME_DA_PASTA abaixo (hoje:
 *   "Extratos e faturas - conta conjunta").
 * Se os nomes reais forem diferentes, ajuste as duas constantes abaixo e salve de novo.
 */

var NOME_DA_PASTA = 'Extratos e faturas - conta conjunta';
var NOME_DA_ABA = 'Lançamentos';

// Divide uma linha de CSV pelo separador ";" respeitando campos entre aspas (que podem conter
// ";" ou aspas duplicadas ""). Um split(';') simples quebraria sempre que a descrição ou o nome
// da pessoa tivessem um ";" dentro (ex.: "Mercado; Atacadão").
function dividirLinhaCSV(linha) {
  var campos = [], campo = '', aspas = false;
  for (var i = 0; i < linha.length; i++) {
    var c = linha.charAt(i);
    if (aspas) {
      if (c === '"' && linha.charAt(i + 1) === '"') { campo += '"'; i++; }
      else if (c === '"') aspas = false;
      else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ';') { campos.push(campo); campo = ''; }
    else campo += c;
  }
  campos.push(campo);
  return campos;
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Finanças da Família')
    .addItem('Importar gastos da Casa', 'importarCasa')
    .addToUi();
}

function importarCasa() {
  var ui = SpreadsheetApp.getUi();

  var pastas = DriveApp.getFoldersByName(NOME_DA_PASTA);
  if (!pastas.hasNext()) {
    ui.alert('Não encontrei a pasta "' + NOME_DA_PASTA + '" no Google Drive. Confira o nome exato da pasta (ou ajuste NOME_DA_PASTA no início do script).');
    return;
  }
  var pasta = pastas.next();

  var aba = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(NOME_DA_ABA);
  if (!aba) {
    ui.alert('Não encontrei a aba "' + NOME_DA_ABA + '" nesta planilha. Confira o nome exato da aba (ou ajuste NOME_DA_ABA no início do script).');
    return;
  }

  // IDs já lançados antes (coluna J), para nunca duplicar mesmo importando o mesmo arquivo de novo.
  var idsExistentes = {};
  var ultimaLinha = aba.getLastRow();
  if (ultimaLinha > 1) {
    aba.getRange(2, 10, ultimaLinha - 1, 1).getValues().forEach(function (r) { if (r[0]) idsExistentes[String(r[0])] = true; });
  }

  // Lê todos os arquivos "Casa_*.csv" da pasta (cada pessoa da família gera o seu, com nome próprio).
  var novos = [];
  var arquivos = pasta.getFilesByType(MimeType.CSV);
  while (arquivos.hasNext()) {
    var arquivo = arquivos.next();
    if (!/^Casa_/i.test(arquivo.getName())) continue;
    var linhas = arquivo.getBlob().getDataAsString('UTF-8').split(/\r?\n/).filter(function (l) { return l.trim() !== ''; });
    for (var i = 1; i < linhas.length; i++) { // linha 0 é o cabeçalho (Data;Descrição;Categoria;Tipo;Pago por;Origem;Valor;Observação;ID)
      var campos = dividirLinhaCSV(linhas[i]);
      if (campos.length < 9) continue;
      var id = campos[8];
      if (!id || idsExistentes[id]) continue; // já lançado antes, ou vindo de outro arquivo nesta mesma importação
      idsExistentes[id] = true;
      novos.push([campos[0], campos[1], campos[2], campos[3], campos[4], campos[5], Number(campos[6].replace(',', '.')) || 0, campos[7], id]);
    }
  }

  if (!novos.length) { ui.alert('Nenhum lançamento novo da Casa para importar (tudo que já existe nos arquivos já foi lançado antes).'); return; }

  novos.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); // por data

  var linhaInicial = aba.getLastRow() + 1;
  var linhasParaEscrever = novos.map(function (n) {
    return [new Date(n[0] + 'T00:00:00'), '', n[1], n[2], n[3], n[4], n[5], n[6], n[7], n[8]];
  });
  aba.getRange(linhaInicial, 1, linhasParaEscrever.length, 10).setValues(linhasParaEscrever);
  for (var l = 0; l < linhasParaEscrever.length; l++) {
    // IMPORTANTE: a coluna B precisa ser uma DATA real (1º dia do mês), não texto — o Painel e o
    // Orçamento comparam com DATE(ano;mês;1) em SUMIFS; texto nunca bateria e tudo somaria zero.
    aba.getRange(linhaInicial + l, 2).setFormula('=DATE(YEAR(A' + (linhaInicial + l) + ');MONTH(A' + (linhaInicial + l) + ');1)');
  }

  ui.alert(novos.length + ' lançamento(s) novo(s) da Casa importado(s) para "' + NOME_DA_ABA + '".');
}
