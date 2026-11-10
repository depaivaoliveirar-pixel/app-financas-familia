/* Finanças da Família – leitores de extratos e faturas (BB, XP, Sicoob).
 * Roda no navegador (sem internet) e no Node (testes). Sem dependências, exceto pdf.js
 * para PDF, que é passado de fora em lerArquivo().
 *
 * Lançamento padrão:
 *   { id, banco, origem: 'conta'|'cartao', conta, data:'AAAA-MM-DD', competencia:'AAAA-MM',
 *     descricao, chave, valor (negativo = saída), portador, parcela, ignorar: null|motivo, formato }
 */
(function (g) {
  'use strict';

  // ---------- utilidades ----------
  const MESES = 'janeiro fevereiro março abril maio junho julho agosto setembro outubro novembro dezembro'.split(' ');

  function numBR(txt) {
    // "R$ -1.234,56" | "-R$ 10.000,00" | "1.234,56D" | "188,00 (-)" | "-0.35" (OFX) | "-45"
    if (txt == null) return NaN;
    let s = String(txt).trim();
    let neg = /^-|-\s*R\$|R\$\s*-|\(-\)\s*$|D\s*$|^\(.*\)$/.test(s);
    s = s.replace(/R\$|\(\+\)|\(-\)|[CD*]\s*$|\s/g, '').replace(/^\((.*)\)$/, '$1').replace(/^-+/, '');
    if (/,\d{1,2}$/.test(s) || (s.includes(',') && !s.includes('.'))) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    const v = parseFloat(s);
    return isNaN(v) ? NaN : (neg ? -v : v);
  }

  const pad = n => String(n).padStart(2, '0');
  const iso = (a, m, d) => `${a}-${pad(m)}-${pad(d)}`;
  function ano4(a) { a = Number(a); return a < 100 ? 2000 + a : a; }
  function dataBR(s) { // dd/mm/aa(aa)
    const m = /(\d{2})\/(\d{2})\/(\d{2,4})/.exec(s);
    return m ? iso(ano4(m[3]), Number(m[2]), Number(m[1])) : null;
  }
  // dd/mm sem ano: usa a data de referência (fim do período / vencimento); mês maior que o da referência = ano anterior
  function dataSemAno(ddmm, ref) {
    const [d, m] = ddmm.split('/').map(Number);
    const [ra, rm] = ref.split('-').map(Number);
    return iso(m > rm ? ra - 1 : ra, m, d);
  }

  function normalizar(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // Chave do estabelecimento para as regras: sem parcela, sem data/hora, sem números longos
  function chave(desc) {
    let s = normalizar(desc)
      .replace(/^\d{2}\/\d{2}( \d{2}:\d{2})?\s+/, '')
      .replace(/\s*[–-]?\s*PARC(ELA)?\.?\s*\d{1,2}\s*(\/|DE)\s*\d{1,2}.*$/, '').replace(/\s*[–-]\s*$/, '')
      .replace(/\b\d{6,}\b/g, ' ')
      .replace(/\s+/g, ' ').trim();
    if ((s.match(/[A-Z]/g) || []).length < 3) { // sobrou pouco (ex.: "*4606988108"): mantém os números
      s = normalizar(desc).replace(/\s*[–-]?\s*PARC(ELA)?\.?\s*\d{1,2}\s*(\/|DE)\s*\d{1,2}.*$/, '').trim();
    }
    return s || normalizar(desc);
  }

  function hash(str) { // FNV-1a 32 bits, suficiente para identificar linhas
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  // Monta lançamento e gera ID estável (linhas idênticas no mesmo arquivo recebem sufixo)
  function montar(lista, base, vistos) {
    const t = Object.assign({ portador: '', parcela: '', ignorar: null }, base);
    t.descricao = String(t.descricao || '').replace(/\s+/g, ' ').trim();
    t.chave = chave(t.descricao);
    if (!t.competencia) t.competencia = t.data.slice(0, 7);
    if (!t.id) {
      const k = [t.banco, t.origem, t.conta, t.data, t.competencia, t.descricao, t.valor.toFixed(2), t.portador, t.parcela].join('|');
      const n = (vistos[k] = (vistos[k] || 0) + 1);
      t.id = t.banco + ':' + hash(k + '#' + n);
    }
    lista.push(t);
  }

  // ---------- CSV ----------
  function csvLinhas(texto) {
    texto = texto.replace(/^﻿/, '');
    const primeira = texto.split(/\r?\n/)[0] || '';
    const sep = (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
    const linhas = []; let campo = '', linha = [], aspas = false;
    for (let i = 0; i < texto.length; i++) {
      const c = texto[i];
      if (aspas) {
        if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; }
        else if (c === '"') aspas = false;
        else campo += c;
      } else if (c === '"') aspas = true;
      else if (c === sep) { linha.push(campo); campo = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && texto[i + 1] === '\n') i++;
        linha.push(campo); campo = '';
        if (linha.some(x => x.trim() !== '')) linhas.push(linha.map(x => x.trim()));
        linha = [];
      } else campo += c;
    }
    linha.push(campo);
    if (linha.some(x => x.trim() !== '')) linhas.push(linha.map(x => x.trim()));
    return linhas;
  }

  // ---------- OFX (BB e XP) ----------
  function lerOFX(texto) {
    const tag = (bloco, nome) => { const m = new RegExp('<' + nome + '>([^<\\r\\n]*)', 'i').exec(bloco); return m ? m[1].trim() : ''; };
    const org = tag(texto, 'ORG');
    const bankid = tag(texto, 'BANKID');
    const banco = /XP/i.test(org) || bankid === '348' ? 'XP' : /BRASIL/i.test(org) || bankid === '001' || bankid === '1' ? 'BB' : /SICOOB|BANCOOB/i.test(org) || bankid === '756' ? 'Sicoob' : (org || 'Banco');
    const acct = tag(texto, 'ACCTID');
    const cartao = /<CCSTMTRS>/i.test(texto);
    const lista = [], vistos = {};
    const blocos = texto.split(/<STMTTRN>/i).slice(1);
    for (const b of blocos) {
      const dt = tag(b, 'DTPOSTED').slice(0, 8);
      const valor = numBR(tag(b, 'TRNAMT').replace(',', '.'));
      const nome = tag(b, 'NAME'), memo = tag(b, 'MEMO');
      let desc;
      if (banco === 'BB') {
        const det = memo.replace(/^\d{2}\/\d{2} \d{2}:\d{2}\s*/, '').replace(/^\d{11,14}\s*/, '');
        desc = det && !/Saldo Devedor|^Rende Facil$/i.test(det) ? (nome + ' – ' + det) : (nome || det);
      } else desc = memo || nome;
      if (/^saldo/i.test(nome) || /^saldo/i.test(desc)) continue;
      montar(lista, {
        id: banco + ':' + acct + ':' + tag(b, 'FITID'),
        banco, origem: cartao ? 'cartao' : 'conta', conta: banco + (cartao ? ' cartão' : ' conta') + (acct ? ' ' + acct.slice(-4) : ''),
        data: iso(dt.slice(0, 4), Number(dt.slice(4, 6)), Number(dt.slice(6, 8))), descricao: desc, valor, formato: 'OFX'
      }, vistos);
    }
    return { banco, tipo: cartao ? 'Fatura' : 'Conta', lancamentos: lista };
  }

  // ---------- CSVs ----------
  function lerCSV(texto, nomeArquivo) {
    const L = csvLinhas(texto);
    if (!L.length) throw erro('O arquivo CSV está vazio.');
    const cab = L[0].map(normalizar);
    const tem = (...n) => n.every(x => cab.includes(x));
    const lista = [], vistos = {};

    if (tem('DATA', 'HORA', 'DESCRICAO', 'VALOR')) { // XP conta
      const i = k => cab.indexOf(k);
      for (const r of L.slice(1)) {
        const data = dataBR(r[i('DATA')]); if (!data) continue;
        montar(lista, { banco: 'XP', origem: 'conta', conta: 'XP conta', data, descricao: r[i('DESCRICAO')], valor: numBR(r[i('VALOR')]), formato: 'CSV' }, vistos);
      }
      return { banco: 'XP', tipo: 'Conta', lancamentos: lista };
    }
    if (tem('DATA', 'ESTABELECIMENTO', 'PORTADOR', 'VALOR')) { // XP fatura
      const i = k => cab.indexOf(k);
      const m = /(\d{4})-(\d{2})-(\d{2})/.exec(nomeArquivo || '');
      let comp = m ? m[1] + '-' + m[2] : null;
      const linhas = L.slice(1).map(r => ({ r, data: dataBR(r[i('DATA')]) })).filter(x => x.data);
      if (!comp) comp = linhas.map(x => x.data).sort().pop().slice(0, 7);
      for (const { r, data } of linhas) {
        const parc = (r[i('PARCELA')] || '').replace(/^-$/, '');
        const v = numBR(r[i('VALOR')]);
        montar(lista, {
          banco: 'XP', origem: 'cartao', conta: 'XP cartão', data, competencia: comp,
          descricao: r[i('ESTABELECIMENTO')] + (parc ? ' – parcela ' + parc.replace(' de ', '/') : ''),
          valor: -v, portador: r[i('PORTADOR')], parcela: parc.replace(' de ', '/'), formato: 'CSV'
        }, vistos);
      }
      return { banco: 'XP', tipo: 'Fatura', lancamentos: lista, competencia: comp };
    }
    if (tem('DATA', 'LANCAMENTO', 'DETALHES', 'VALOR')) { // BB conta
      const i = k => cab.indexOf(k);
      for (const r of L.slice(1)) {
        const data = dataBR(r[i('DATA')]); const lanc = r[i('LANCAMENTO')] || '';
        if (!data || /^saldo|^s a l d o/i.test(lanc)) continue;
        const det = (r[i('DETALHES')] || '').replace(/^\d{2}\/\d{2} \d{2}:\d{2}\s*/, '').replace(/^\d{11,14}\s*/, '');
        montar(lista, { banco: 'BB', origem: 'conta', conta: 'BB conta', data, descricao: det && !/Saldo Devedor|^Rende Facil$/i.test(det) ? lanc + ' – ' + det : lanc, valor: numBR(r[i('VALOR')]), formato: 'CSV' }, vistos);
      }
      return { banco: 'BB', tipo: 'Conta', lancamentos: lista };
    }
    throw erro('Não reconheci este CSV. Ele não parece ser do Banco do Brasil, da XP ou do Sicoob. Tente baixar o extrato em OFX.');
  }

  // ---------- PDFs (recebem as linhas já extraídas: [{page, text}], colunas separadas por \t) ----------
  const reValor = /^-?R?\$?\s?-?[\d.]+,\d{2}\s?(\([+-]\)|[CD])?\*?$/;

  function lerPDF(linhas) {
    const tudo = linhas.map(l => l.text).join('\n');
    if (/Conta Digital XP/i.test(tudo)) return pdfXPConta(linhas);
    if (/fatura Cartão XP|Cartão XP Visa|XP Visa/i.test(tudo) && /Vencimento/.test(tudo)) return pdfXPFatura(linhas);
    if (/SICOOB/i.test(tudo) && /EXTRATO CONTA CORRENTE/i.test(tudo)) return pdfSicoob(linhas);
    if (/OUROCARD/i.test(tudo) || (/Cartão \d{4}\)/.test(tudo) && /Total da Fatura/i.test(tudo))) return pdfBBFatura(linhas);
    if (/Extrato de Conta Corrente/i.test(tudo) && /Lote/.test(tudo)) return pdfBBConta(linhas);
    throw erro('Não reconheci este PDF. Ele não parece ser um extrato ou uma fatura do Banco do Brasil, da XP ou do Sicoob.');
  }

  function pdfXPConta(linhas) {
    const lista = [], vistos = {};
    for (const l of linhas) {
      const c = l.text.split('\t');
      const m = /^(\d{2}\/\d{2}\/\d{2}) às/.exec(c[0]);
      if (!m || c.length < 3) continue;
      montar(lista, { banco: 'XP', origem: 'conta', conta: 'XP conta', data: dataBR(m[1]), descricao: c[1], valor: numBR(c[2]), formato: 'PDF' }, vistos);
    }
    return { banco: 'XP', tipo: 'Conta', lancamentos: lista };
  }

  function pdfXPFatura(linhas) {
    const lista = [], vistos = {};
    let venc = null, portador = '';
    for (let k = 0; k < linhas.length; k++) {
      const t = linhas[k].text;
      if (!venc && /^Vencimento\t/.test(t) && linhas[k + 1]) venc = dataBR(linhas[k + 1].text);
      const p = /^([A-ZÀ-Ú][A-ZÀ-Ú ]+) - \d{4}\*+\d{4}$/.exec(t);
      if (p) { portador = p[1].trim(); continue; }
      const c = t.split('\t');
      if (!/^\d{2}\/\d{2}\/\d{2}$/.test(c[0]) || c.length < 3) continue;
      const desc = c[1];
      const pm = /\s-\sParcela (\d+\/\d+)$/.exec(desc);
      montar(lista, {
        banco: 'XP', origem: 'cartao', conta: 'XP cartão', data: dataBR(c[0]), competencia: venc ? venc.slice(0, 7) : null,
        descricao: pm ? desc.replace(pm[0], ' – parcela ' + pm[1]) : desc, valor: -numBR(c[2]), portador, parcela: pm ? pm[1] : '', formato: 'PDF'
      }, vistos);
    }
    if (!venc) venc = lista.map(t => t.data).sort().pop();
    lista.forEach(t => { if (!t.competencia) t.competencia = venc.slice(0, 7); });
    return { banco: 'XP', tipo: 'Fatura', lancamentos: lista, competencia: venc && venc.slice(0, 7) };
  }

  function pdfSicoob(linhas) {
    const tudo = linhas.map(l => l.text).join('\n');
    const per = /PER[IÍ]ODO:\s*(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})/.exec(tudo);
    const ref = per ? dataBR(per[2]) : null;
    if (!ref) throw erro('Não encontrei o período no extrato do Sicoob.');
    const conta = (/CONTA:\s*([\d.\-]+)/.exec(tudo) || [])[1] || '';
    const lista = [], vistos = {};
    let atual = null;
    const fechar = () => { if (atual) { montar(lista, atual.t, vistos); atual = null; } };
    for (const l of linhas) {
      const c = l.text.split('\t');
      if (/^RESUMO$/.test(l.text.trim())) { fechar(); break; }
      if (/^\d{2}\/\d{2}$/.test(c[0])) {
        fechar();
        const hist = c[1] || '';
        const val = c[c.length - 1];
        if (/^SALDO/i.test(hist) || c.length < 3 || !reValor.test(val.replace(/\s/g, ''))) continue;
        atual = { t: { banco: 'Sicoob', origem: 'conta', conta: 'Sicoob conta ' + conta.slice(-5), data: dataSemAno(c[0], ref), descricao: hist, valor: numBR(val), formato: 'PDF' }, extra: 0 };
      } else if (atual) {
        const s = l.text.trim();
        if (/^(DOC\.?:|\*{3}|[\d.,]+[CD]?$|[CD]$)/.test(s)) continue;
        if (atual.extra < 1) { atual.t.descricao += ' – ' + s; atual.extra++; }
      }
    }
    fechar();
    return { banco: 'Sicoob', tipo: 'Conta', lancamentos: lista };
  }

  function pdfBBConta(linhas) {
    const tudo = linhas.map(l => l.text).join('\n');
    const conta = (/Conta:\s*([\d\-]+)/.exec(tudo) || [])[1] || '';
    // só a parte de lançamentos da 1ª seção
    const ini = linhas.findIndex(l => /^Dia\tLote/.test(l.text));
    let fim = linhas.findIndex((l, i) => i > ini && /^Informações Adicionais|^Lançamentos Futuros/.test(l.text));
    if (fim < 0) fim = linhas.length;
    const L = linhas.slice(ini + 1, fim).map(l => l.text);
    const ehData = s => /^\d{2}\/\d{2}\/\d{4}\t/.test(s);
    const idx = L.map((s, i) => ehData(s) ? i : -1).filter(i => i >= 0);
    const lista = [], vistos = {};
    for (let n = 0; n < idx.length; n++) {
      const i = idx[n];
      const c = L[i].split('\t');
      const valor = c[c.length - 1];
      const meio = c.slice(1, -1).filter(x => !/^\d+$/.test(x)); // tira lote e documento
      if (meio.some(x => /^saldo|^s a l d o/i.test(x))) continue;
      const anterior = n > 0 ? idx[n - 1] : -1;
      // histórico = última linha sem data antes desta (se houver linhas entre)
      const entre = L.slice(anterior + 1, i);
      const hist = entre.length ? entre[entre.length - 1] : '';
      // detalhe = texto no meio desta linha + linhas seguintes até antes do histórico do próximo
      const prox = idx[n + 1] !== undefined ? idx[n + 1] : L.length;
      const proxC = idx[n + 1] !== undefined ? L[prox].split('\t').slice(1, -1).filter(x => !/^\d+$/.test(x)) : [];
      const proxEhSaldo = proxC.some(x => /^saldo|^s a l d o/i.test(x));
      let seguintes = L.slice(i + 1, prox);
      if (!proxEhSaldo && idx[n + 1] !== undefined) seguintes = seguintes.slice(0, -1);
      let det = meio.concat(seguintes).join(' ').replace(/^\d{2}\/\d{2} \d{2}:\d{2}\s*/, '').replace(/^\d{11,14}\s*/, '').trim();
      if (/Saldo Devedor|^Rende Facil$/i.test(det)) det = '';
      montar(lista, { banco: 'BB', origem: 'conta', conta: 'BB conta ' + conta, data: dataBR(c[0]), descricao: det ? hist + ' – ' + det : hist, valor: numBR(valor), formato: 'PDF' }, vistos);
    }
    return { banco: 'BB', tipo: 'Conta', lancamentos: lista };
  }

  function pdfBBFatura(linhas) {
    let venc = null, portador = '', cartao = '';
    for (let k = 0; k < linhas.length && !venc; k++) {
      if (/^Vencimento$/.test(linhas[k].text.trim())) {
        for (let j = k + 1; j < Math.min(k + 6, linhas.length) && !venc; j++) { const d = dataBR(linhas[j].text); if (d) venc = d; }
      }
    }
    if (!venc) throw erro('Não encontrei a data de vencimento na fatura do Banco do Brasil.');
    const lista = [], vistos = {};
    let dentro = false;
    for (const l of linhas) {
      const t = l.text;
      const p = /^(.+) \(Cartão (\d{4})\)$/.exec(t);
      if (p) { portador = p[1].trim(); cartao = p[2]; dentro = true; continue; }
      if (/^Total da Fatura/i.test(t)) { dentro = false; continue; }
      if (!dentro) continue;
      const c = t.split('\t');
      if (!/^\d{2}\/\d{2}$/.test(c[0])) continue;
      const val = c[c.length - 1];
      if (!/R\$/.test(val)) continue;
      let desc = c.slice(1, -1).filter(x => x !== 'BR').join(' ');
      const pm = /\bPARC (\d{2})\/(\d{2})\b/.exec(desc);
      montar(lista, {
        banco: 'BB', origem: 'cartao', conta: 'BB cartão ' + cartao, data: dataSemAno(c[0], venc), competencia: venc.slice(0, 7),
        descricao: desc, valor: -numBR(val), portador, parcela: pm ? Number(pm[1]) + '/' + Number(pm[2]) : '', formato: 'PDF'
      }, vistos);
    }
    return { banco: 'BB', tipo: 'Fatura', lancamentos: lista, competencia: venc.slice(0, 7) };
  }

  // ---------- o que fica fora da conta ----------
  // nomesTitular: ex. ['RICARDO DE PAIVA OLIVEIRA'] — transferências para/de si mesmo
  function marcarIgnorados(lista, nomesTitular) {
    const nomes = (nomesTitular || []).map(normalizar).filter(Boolean);
    for (const t of lista) {
      const d = normalizar(t.descricao);
      if (t.origem === 'cartao' && (/^PGTO\b|PAGAMENTOS? VALIDOS|PAGAMENTO RECEBIDO|^PAGAMENTO\b/.test(d))) t.ignorar = 'Pagamento da fatura';
      else if (t.origem === 'conta' && /PAGTO CARTAO|PAGAMENTO (DE )?FATURA|PGTO\.? (CARTAO|FATURA)|PAGAMENTO CARTAO/.test(d)) t.ignorar = 'Pagamento de fatura do cartão';
      else if (/RENDE FACIL|CONTA INVESTIMENTO|APLICACAO AUTOMATICA|RESGATE AUTOMATICO/.test(d)) t.ignorar = 'Aplicação ou resgate automático';
      else if (nomes.some(n => n.length > 5 && d.includes(n))) t.ignorar = 'Transferência entre suas contas';
    }
    return lista;
  }

  // ---------- leitura de arquivo (navegador ou Node) ----------
  function erro(msg) { const e = new Error(msg); e.amigavel = true; return e; }

  function decodificar(bytes) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch (e) { return new TextDecoder('windows-1252').decode(bytes); }
  }

  // linhasPDF(bytes, senha) -> Promise<[{page,text}]> (fornecido pelo app/teste, usa pdf.js)
  async function lerArquivo(nome, bytes, opcoes) {
    opcoes = opcoes || {};
    const n = nome.toLowerCase();
    let r;
    if (/\.(png|jpe?g|gif|webp|heic)$/.test(n)) throw erro('Esta é uma imagem. O app não lê fotos: baixe o extrato em OFX, CSV ou PDF.');
    if (/\.(xlsx?|ods)$/.test(n)) throw erro('Planilha do Excel ainda não é aceita. Baixe o extrato em OFX ou CSV.');
    const cabeca = decodificar(bytes.slice(0, 400));
    if (n.endsWith('.pdf') || cabeca.startsWith('%PDF')) {
      let linhas;
      try { linhas = await opcoes.linhasPDF(bytes, opcoes.senha); }
      catch (e) {
        if (e && e.name === 'PasswordException') {
          const x = erro(opcoes.senha ? 'Senha incorreta. Confira e tente de novo.' : 'Este PDF tem senha. Digite a senha do arquivo (o app não guarda).');
          x.precisaSenha = true; throw x;
        }
        throw erro('Não consegui abrir este PDF. Tente baixar de novo ou use OFX/CSV.');
      }
      r = lerPDF(linhas);
    } else {
      const texto = decodificar(bytes);
      if (/OFXHEADER|<OFX>/i.test(texto.slice(0, 2000))) r = lerOFX(texto);
      else r = lerCSV(texto, nome);
    }
    marcarIgnorados(r.lancamentos, opcoes.nomesTitular);
    r.arquivo = nome;
    return r;
  }

  g.Leitores = { lerArquivo, lerOFX, lerCSV, lerPDF, marcarIgnorados, numBR, chave, normalizar, csvLinhas };
})(typeof window !== 'undefined' ? window : globalThis);
