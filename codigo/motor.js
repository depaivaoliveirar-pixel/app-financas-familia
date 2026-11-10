/* Finanças da Família – motor: regras de classificação, resumo do mês,
 * mesclagem de importações e aviso de sobreposição de período.
 * Roda no navegador e no Node. Não lê arquivos nem grava nada em disco:
 * recebe o resultado de Leitores.lerArquivo() e devolve/atualiza um objeto
 * "estado" simples (serializável em JSON), que é o que o app grava no
 * arquivo de dados escolhido pela pessoa.
 *
 * Lançamento guardado no estado = lançamento do leitor + { tipo: null|'Pessoal'|'Casa', categoria: null|string }
 */
(function (g) {
  'use strict';

  const VERSAO = 1;

  const CATEGORIAS_PADRAO = ['Mercado', 'Alimentação fora', 'Saúde', 'Transporte', 'Casa e contas', 'Educação', 'Lazer', 'Assinaturas', 'Tarifas e juros', 'Outros'];
  const CATEGORIAS_PRISCILA = ['Moradia (condomínio, contas)', 'Funcionários', 'Escola e educação', 'Saúde', 'Seguros', 'Mercado', 'Alimentação fora', 'Transporte', 'Assinaturas', 'Lazer e viagens curtas', 'Presentes', 'Filhos (diversos)', 'Casa e manutenção', 'Anuais (IPTU, IPVA, matrícula)', 'Outros', 'Consórcio', 'Aporte filhos', 'Aporte metas'];
  const FREQUENCIAS = ['Fixa', 'Variável', 'Esporádica']; // só se aplica a itens "Casa" (planilha da família pede essa coluna)

  function categoriasPadrao(perfil) {
    return perfil === 'priscila' ? CATEGORIAS_PRISCILA.slice() : CATEGORIAS_PADRAO.slice();
  }

  function estadoNovo(perfil, nomesTitular) {
    return {
      versao: VERSAO,
      perfil: perfil || 'padrao',
      nomesTitular: (nomesTitular || []).slice(),
      nomePessoa: '', // "Pago por" no envio à planilha da família; cadastrado 1x em Ajustes
      linkPlanilhaFamilia: '', // link do Google Sheets, pra abrir de dentro do app; ver Motor.definirLinkPlanilhaFamilia
      rotulosCasa: null, // null = usa os padrões (ROTULOS_CASA_PADRAO); ver Motor.definirRotulosCasa
      categorias: categoriasPadrao(perfil),
      limites: {}, // limite mensal opcional por categoria, ex.: {Mercado: 1500} — ver Motor.definirLimiteCategoria/orcamentoMes
      regras: {},
      lancamentos: {},
      importacoes: [],
      conciliacoesPendentes: []
    };
  }

  // Cadastro do nome da pessoa (tela de Ajustes) — usado como "Pago por" ao enviar itens Casa para a planilha da família.
  function definirNomePessoa(estado, nome) {
    nome = String(nome || '').trim();
    if (!nome) throw erro('Informe seu nome.');
    estado.nomePessoa = nome;
  }

  // Link da planilha da família (Google Sheets), pra abrir de dentro do app na tela "Enviar Despesa de Casa".
  // Opcional — vazio/null remove o link (a pessoa pode não ter uma planilha compartilhada configurada ainda).
  function definirLinkPlanilhaFamilia(estado, link) {
    link = String(link || '').trim();
    if (link && !/^https?:\/\//i.test(link)) throw erro('O link precisa começar com http:// ou https://.');
    estado.linkPlanilhaFamilia = link;
  }

  // Limite mensal opcional por categoria (ideia do Mobills/Monarch: "até R$ X em Mercado por mês").
  // valor <= 0 ou null remove o limite (categoria sem controle). Totalmente opcional, não obrigatório.
  function definirLimiteCategoria(estado, categoria, valor) {
    if (!categoria) throw erro('Categoria é obrigatória.');
    if (valor == null || valor <= 0) { delete estado.limites[categoria]; return; }
    if (typeof valor !== 'number' || isNaN(valor)) throw erro('Limite inválido.');
    estado.limites[categoria] = valor;
  }

  // Valida tipo/categoria/frequência de uma classificação. Frequência só é exigida (e só faz sentido) para "Casa":
  // itens "Pessoal" não vão para a planilha da família, então a frequência fica sempre null para eles.
  function validarClassificacao(tipo, categoria, frequencia) {
    if (!['Pessoal', 'Casa'].includes(tipo)) throw erro('Tipo precisa ser "Pessoal" ou "Casa".');
    if (!categoria) throw erro('Categoria é obrigatória.');
    if (tipo === 'Casa') {
      if (!FREQUENCIAS.includes(frequencia)) throw erro('Para itens "Casa", informe a frequência: Fixa, Variável ou Esporádica.');
      return frequencia;
    }
    return null;
  }

  const r2 = n => Math.round(n * 100) / 100;

  function erro(msg) { const e = new Error(msg); e.amigavel = true; return e; }

  function hash(str) { // FNV-1a 32 bits — só precisa ser estável e difícil de colidir, não criptográfico
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  function diasEntre(dataA, dataB) {
    return Math.round(Math.abs(Date.parse(dataA) - Date.parse(dataB)) / 86400000);
  }

  function normalizarSimples(s) {
    return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  // ---------- período coberto por uma importação (para avisar sobreposição) ----------
  function periodoImportacao(resultado) {
    const validos = resultado.lancamentos.filter(t => !t.ignorar);
    if (!validos.length) return null;
    const datas = validos.map(t => t.data).sort();
    return { inicio: datas[0], fim: datas[datas.length - 1] };
  }

  // Mesma conta, mesmo período, formato diferente do já importado = aviso
  // (o app não detecta duplicado entre OFX/CSV/PDF pelo ID, então avisa a pessoa em vez de duplicar silenciosamente).
  // Em fatura de cartão, "data" é a data da compra original (pode ser de meses atrás, por parcelamento),
  // então o período que importa é a competência (mês da fatura), não o intervalo de datas das compras.
  function verificarSobreposicao(estado, resultado) {
    const t0 = resultado.lancamentos.find(t => !t.ignorar);
    if (!t0) return null;
    const porCompetencia = t0.origem === 'cartao';
    const competencia = resultado.competencia || null;
    const periodo = porCompetencia ? null : periodoImportacao(resultado);
    if (porCompetencia ? !competencia : !periodo) return null;
    // Compara por banco+origem (não pela string "conta" inteira): o mesmo extrato pode vir com o número
    // da conta no nome em um formato (ex.: OFX) e sem ele em outro (ex.: CSV), e ainda assim ser a mesma conta.
    const chaveConta = t0.banco + ':' + t0.origem, conta = t0.conta, formato = t0.formato;
    const avisos = [];
    for (const imp of estado.importacoes) {
      if (imp.chaveConta !== chaveConta || imp.formato === formato) continue;
      const sobrepoe = porCompetencia ? imp.competencia === competencia : (periodo.inicio <= imp.fim && imp.inicio <= periodo.fim);
      if (!sobrepoe) continue;
      const faixa = porCompetencia ? `a fatura de ${competencia}` : `este período (${periodo.inicio} a ${periodo.fim})`;
      const particip = porCompetencia ? 'importada' : 'importado';
      avisos.push(`"${conta}": ${faixa} pode já estar ${particip} em ${imp.formato} ("${imp.arquivo}"). Confira para não contar os lançamentos duas vezes.`);
    }
    return avisos.length ? avisos.join(' ') : null;
  }

  // Integra os lançamentos de uma leitura no estado; aplica as regras já conhecidas e tenta
  // conciliar com lançamentos manuais pendentes (ver "lançamento manual" abaixo).
  // Não lança erro se já existir o mesmo id (duplicado real: mesmo arquivo importado de novo).
  function importar(estado, resultado) {
    const aviso = verificarSobreposicao(estado, resultado);
    let novos = 0, duplicados = 0;
    for (const t of resultado.lancamentos) {
      if (estado.lancamentos[t.id]) { duplicados++; continue; }
      const novo = Object.assign({}, t, { tipo: null, categoria: null });
      estado.lancamentos[novo.id] = novo;
      novos++;
      if (!novo.ignorar) conciliarComManual(estado, novo);
    }
    const periodo = periodoImportacao(resultado);
    const t0 = resultado.lancamentos.find(t => !t.ignorar);
    if (periodo && t0) {
      estado.importacoes.push({
        arquivo: resultado.arquivo, banco: resultado.banco, tipo: resultado.tipo,
        conta: t0.conta, chaveConta: t0.banco + ':' + t0.origem, formato: t0.formato, inicio: periodo.inicio, fim: periodo.fim,
        competencia: resultado.competencia || null, importadoEm: new Date().toISOString()
      });
    }
    aplicarRegras(estado);
    return { novos, duplicados, aviso };
  }

  // ---------- lançamento manual ----------
  // Para despesas que a pessoa já sabe classificar no momento (ex.: "esse jantar foi Casa, não Pessoal" —
  // o estabelecimento em si pode variar entre Pessoal e Casa dependendo do evento, então a regra automática
  // por estabelecimento não serve). A pessoa lança a despesa já com tipo/categoria; ela entra no resumo do mês
  // normalmente. O extrato/fatura importado depois serve só para conferência: se bater com este lançamento
  // manual, não conta em dobro.
  function lancarManual(estado, dados) {
    dados = dados || {};
    const obrigatorios = ['data', 'descricao', 'valor', 'tipo', 'categoria', 'banco', 'origem', 'conta'];
    for (const campo of obrigatorios) if (dados[campo] == null || dados[campo] === '') throw erro('Falta informar: ' + campo + '.');
    const frequencia = validarClassificacao(dados.tipo, dados.categoria, dados.frequencia);
    if (!['conta', 'cartao'].includes(dados.origem)) throw erro('Origem precisa ser "conta" ou "cartao".');
    if (typeof dados.valor !== 'number' || isNaN(dados.valor)) throw erro('Valor inválido.');
    if (dados.origem === 'cartao' && !dados.competencia) throw erro('Para despesa de cartão, informe em qual fatura (competência) ela deve aparecer.');
    const competencia = dados.competencia || dados.data.slice(0, 7);
    const t = {
      id: 'Manual:' + hash([dados.data, dados.descricao, dados.valor, dados.banco, dados.origem, Date.now(), Math.random()].join('|')),
      banco: dados.banco, origem: dados.origem, conta: dados.conta, data: dados.data, competencia,
      descricao: dados.descricao, chave: normalizarSimples(dados.descricao), valor: dados.valor,
      portador: dados.portador || '', parcela: dados.parcela || '', ignorar: null, formato: 'Manual',
      tipo: dados.tipo, categoria: dados.categoria, frequencia, manual: true, conciliado: false, conciliadoCom: null,
      criadoEm: new Date().toISOString()
    };
    estado.lancamentos[t.id] = t;
    return t;
  }

  // Lançamentos manuais ainda não confirmados por nenhum extrato/fatura (para a pessoa acompanhar).
  function pendentesManuais(estado) {
    return Object.values(estado.lancamentos).filter(t => t.manual && !t.conciliado).sort((a, b) => a.data < b.data ? -1 : 1);
  }

  // Lançamentos manuais pendentes que batem em valor e conta/cartão com o lançamento importado "t":
  // por competência (mês da fatura) se for cartão, por data próxima (até 2 dias) se for conta.
  function candidatosManuais(estado, t) {
    const chaveConta = t.banco + ':' + t.origem;
    return Object.values(estado.lancamentos).filter(m =>
      m.manual && !m.conciliado && (m.banco + ':' + m.origem) === chaveConta && m.valor === t.valor &&
      (t.origem === 'cartao' ? m.competencia === t.competencia : diasEntre(m.data, t.data) <= 2)
    );
  }

  // Tenta conciliar um lançamento recém-importado com um lançamento manual pendente.
  // Um candidato só: concilia direto (o manual continua valendo; o importado é marcado "ignorar" para não contar em dobro).
  // Mais de um candidato (empate): não decide sozinho — registra em conciliacoesPendentes para a pessoa escolher.
  function conciliarComManual(estado, t) {
    const candidatos = candidatosManuais(estado, t);
    if (candidatos.length === 1) {
      const m = candidatos[0];
      m.conciliado = true; m.conciliadoCom = t.id;
      t.ignorar = 'Já lançado manualmente (conferido pelo extrato)';
    } else if (candidatos.length > 1) {
      estado.conciliacoesPendentes.push({ idImportado: t.id, candidatosManual: candidatos.map(m => m.id) });
    }
  }

  // A pessoa escolhe, entre os candidatos, qual lançamento manual é este lançamento importado.
  function confirmarConciliacao(estado, idImportado, idManualEscolhido) {
    const t = estado.lancamentos[idImportado], m = estado.lancamentos[idManualEscolhido];
    if (!t || !m) throw erro('Lançamento não encontrado.');
    m.conciliado = true; m.conciliadoCom = t.id;
    t.ignorar = 'Já lançado manualmente (conferido pelo extrato)';
    estado.conciliacoesPendentes = estado.conciliacoesPendentes.filter(p => p.idImportado !== idImportado);
  }

  // A pessoa diz que nenhum dos candidatos é este lançamento: ele segue o fluxo normal (regras/novidades).
  function rejeitarConciliacao(estado, idImportado) {
    estado.conciliacoesPendentes = estado.conciliacoesPendentes.filter(p => p.idImportado !== idImportado);
  }

  // Detalha os pendentes de conciliação ambígua para a tela mostrar à pessoa.
  function conciliacoesPendentesDetalhadas(estado) {
    return estado.conciliacoesPendentes.map(p => ({
      importado: estado.lancamentos[p.idImportado],
      candidatos: p.candidatosManual.map(id => estado.lancamentos[id])
    })).filter(p => p.importado);
  }

  // ---------- regras de classificação ----------
  // Aplica as regras conhecidas (por chave) aos lançamentos ainda sem tipo. Não sobrescreve
  // classificação manual já feita (ex.: alguém reclassificou um lançamento específico).
  function aplicarRegras(estado) {
    for (const id in estado.lancamentos) {
      const t = estado.lancamentos[id];
      if (t.ignorar || t.tipo) continue;
      const regra = estado.regras[t.chave];
      if (regra) { t.tipo = regra.tipo; t.categoria = regra.categoria; t.frequencia = regra.frequencia; }
    }
  }

  // "Salvar e lembrar": grava a regra pela chave e classifica todos os lançamentos (passados e futuros) com ela.
  // Pix para pessoa física já funciona sozinho aqui: a chave inclui o nome da pessoa, então a regra vale só para ela.
  // frequencia (Fixa/Variável/Esporádica) é obrigatória quando tipo = 'Casa' (vai para a planilha da família); ignorada em 'Pessoal'.
  function classificar(estado, chave, tipo, categoria, frequencia) {
    frequencia = validarClassificacao(tipo, categoria, frequencia);
    estado.regras[chave] = { tipo, categoria, frequencia };
    for (const id in estado.lancamentos) {
      const t = estado.lancamentos[id];
      if (!t.ignorar && t.chave === chave) { t.tipo = tipo; t.categoria = categoria; t.frequencia = frequencia; }
    }
  }

  // Reclassifica só este lançamento (sem alterar a regra geral da chave) — para exceções
  // (ex.: esse mesmo restaurante foi Casa esta vez, mas a regra geral dele continua Pessoal).
  function classificarUm(estado, id, tipo, categoria, frequencia) {
    frequencia = validarClassificacao(tipo, categoria, frequencia);
    const t = estado.lancamentos[id];
    if (t) { t.tipo = tipo; t.categoria = categoria; t.frequencia = frequencia; }
  }

  // Receita (entrada de dinheiro: salário, Pix recebido, reembolso...) não é despesa: não tem categoria de
  // gasto nem frequência, e nunca entra no envio "Casa" para a planilha da família (Motor.itensCasa só pega
  // valor negativo). Classificar como Pessoal/Casa aqui é só um registro de controle pra quem usa o app —
  // por exemplo, separar "minha renda" de "dinheiro que entrou pro pote comum da família".
  function classificarReceita(estado, chave, tipo) {
    if (!['Pessoal', 'Casa'].includes(tipo)) throw erro('Tipo precisa ser "Pessoal" ou "Casa".');
    estado.regras[chave] = { tipo, categoria: null, frequencia: null };
    for (const id in estado.lancamentos) {
      const t = estado.lancamentos[id];
      if (!t.ignorar && t.chave === chave) { t.tipo = tipo; t.categoria = null; t.frequencia = null; }
    }
  }
  function classificarReceitaUm(estado, id, tipo) {
    if (!['Pessoal', 'Casa'].includes(tipo)) throw erro('Tipo precisa ser "Pessoal" ou "Casa".');
    const t = estado.lancamentos[id];
    if (t) { t.tipo = tipo; t.categoria = null; t.frequencia = null; }
  }

  // ---------- tela "Novidades para classificar" ----------
  // Agrupa por estabelecimento (chave) os lançamentos ainda sem tipo, para perguntar uma vez por grupo.
  // ehReceita (valor >= 0, dinheiro entrando) marca o grupo pra tela pedir só Pessoal/Casa, sem categoria de despesa.
  function novidades(estado) {
    const grupos = {};
    for (const id in estado.lancamentos) {
      const t = estado.lancamentos[id];
      if (t.ignorar || t.tipo) continue;
      const g = grupos[t.chave] || (grupos[t.chave] = { chave: t.chave, descricaoExemplo: t.descricao, quantidade: 0, total: 0, origens: new Set(), ids: [], ehReceita: t.valor >= 0 });
      g.quantidade++; g.total += Math.abs(t.valor); g.origens.add(t.conta); g.ids.push(id);
    }
    return Object.values(grupos)
      .map(g => ({ chave: g.chave, descricaoExemplo: g.descricaoExemplo, quantidade: g.quantidade, total: r2(g.total), origens: [...g.origens], ids: g.ids, ehReceita: g.ehReceita }))
      .sort((a, b) => b.total - a.total);
  }

  // ---------- resumo do mês ----------
  function resumoMes(estado, competencia) {
    const lista = Object.values(estado.lancamentos).filter(t => !t.ignorar && t.competencia === competencia);
    let entrou = 0, saiu = 0;
    const porCategoria = {}, pessoalXcasa = {};
    for (const t of lista) {
      if (t.valor >= 0) { entrou += t.valor; continue; }
      saiu += -t.valor;
      const cat = t.categoria || 'Sem categoria';
      porCategoria[cat] = (porCategoria[cat] || 0) + (-t.valor);
      const tipo = t.tipo || 'Sem classificar';
      pessoalXcasa[tipo] = (pessoalXcasa[tipo] || 0) + (-t.valor);
    }
    const arred = obj => Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, r2(v)]));
    return {
      competencia, entrou: r2(entrou), saiu: r2(saiu), sobrou: r2(entrou - saiu),
      porCategoria: arred(porCategoria), pessoalXcasa: arred(pessoalXcasa),
      lancamentos: lista.slice().sort((a, b) => a.data < b.data ? -1 : a.data > b.data ? 1 : a.descricao < b.descricao ? -1 : 1)
    };
  }

  // ---------- orçamento por categoria + "ritmo do mês" (ideia barata do Mobills/Monarch, opcional) ----------
  const pad2 = n => String(n).padStart(2, '0');

  // Quantos dias tem o mês da competencia (ex.: '2026-11' -> 30).
  function diasNoMes(competencia) {
    const [ano, mes] = competencia.split('-').map(Number);
    return new Date(ano, mes, 0).getDate();
  }

  // % do mês já passado, olhando a data de referência (hoje, por padrão). Mês já encerrado = 100%;
  // mês futuro = 0%; mês corrente = dia atual / total de dias do mês.
  function percentualMesPassado(competencia, dataReferencia) {
    const ref = dataReferencia || new Date();
    const mesAtual = ref.getFullYear() + '-' + pad2(ref.getMonth() + 1);
    if (competencia < mesAtual) return 100;
    if (competencia > mesAtual) return 0;
    return Math.round((ref.getDate() / diasNoMes(competencia)) * 100);
  }

  // Compara, por categoria com limite definido, o % já gasto com o % do mês já passado.
  // "estourou": já passou do limite. "atencao": está gastando mais rápido que o ritmo do mês
  // (mais de 15 pontos percentuais acima do esperado para o dia de hoje). "ok": dentro do esperado.
  // Totalmente opcional: categoria sem limite definido simplesmente não aparece aqui.
  function orcamentoMes(estado, competencia, dataReferencia) {
    const resumo = resumoMes(estado, competencia);
    const percentual = percentualMesPassado(competencia, dataReferencia);
    const categorias = [];
    for (const categoria in (estado.limites || {})) {
      const limite = estado.limites[categoria];
      if (!limite || limite <= 0) continue;
      const gasto = resumo.porCategoria[categoria] || 0;
      const percentualGasto = r2((gasto / limite) * 100);
      const ritmo = gasto > limite ? 'estourou' : (percentualGasto - percentual > 15 ? 'atencao' : 'ok');
      categorias.push({ categoria, limite, gasto: r2(gasto), percentualGasto, ritmo });
    }
    categorias.sort((a, b) => b.percentualGasto - a.percentualGasto);
    return { competencia, percentualMesPassado: percentual, categorias };
  }

  // Meses com algum lançamento válido, para a navegação de mês (mais recente primeiro).
  function mesesComLancamentos(estado) {
    const s = new Set();
    for (const id in estado.lancamentos) { const t = estado.lancamentos[id]; if (!t.ignorar) s.add(t.competencia); }
    return [...s].sort().reverse();
  }

  // ---------- itens "Casa" para enviar à planilha da família ----------
  function itensCasa(estado, competencia) {
    return Object.values(estado.lancamentos)
      .filter(t => !t.ignorar && t.tipo === 'Casa' && (!competencia || t.competencia === competencia) && t.valor < 0)
      .sort((a, b) => a.data < b.data ? -1 : 1);
  }

  // ---------- exportação em CSV (sem biblioteca: abre direto no Excel) ----------
  // Escapa um campo para CSV com separador ";": só usa aspas quando o texto precisa (contém ; " ou quebra de linha).
  function campoCSV(v) {
    const s = v == null ? '' : String(v);
    return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function linhaCSV(campos) { return campos.map(campoCSV).join(';'); }

  // "Exportar para Excel" na tela Resumo do mês: resumo + lista de lançamentos do mês, numa aba só.
  function exportarResumoCSV(estado, competencia) {
    const r = resumoMes(estado, competencia);
    const linhas = [
      linhaCSV(['Resumo de ' + competencia]),
      linhaCSV(['Receita', r.entrou.toFixed(2).replace('.', ',')]),
      linhaCSV(['Despesa', r.saiu.toFixed(2).replace('.', ',')]),
      linhaCSV(['Saldo', r.sobrou.toFixed(2).replace('.', ',')]),
      '',
      linhaCSV(['Data', 'Descrição', 'Categoria', 'Tipo', 'Valor', 'Conta', 'Banco'])
    ];
    for (const t of r.lancamentos) {
      linhas.push(linhaCSV([t.data, t.descricao, t.categoria || '', t.tipo || '', t.valor.toFixed(2).replace('.', ','), t.conta, t.banco]));
    }
    return linhas.join('\r\n');
  }

  // "Pago por" e "Origem", numa planilha de família compartilhada, costumam ser listas fechadas (não texto
  // livre): despesa comum sempre passa pela conta conjunta ou pelo cartão comum; alguém só paga despesa comum
  // fora disso em exceção (ex. boleto, lançado manualmente). Por isso: todo lançamento importado (extrato/
  // fatura) é, por definição, da conta conjunta/cartão comum; todo lançamento manual é a exceção, com o nome
  // de quem lançou.
  // Rótulos padrão: servem pra um casal com conta conjunta + cartão comum. Outra família
  // (estrutura diferente — pessoa sozinha, outro arranjo, etc.) pode usar outros nomes sem mudar o motor,
  // só ajustando Motor.definirRotulosCasa — o que importa pro Apps Script é que os rótulos usados aqui
  // sejam exatamente os mesmos cadastrados na lista "Pago por"/"Origem" da planilha de cada família.
  const ROTULOS_CASA_PADRAO = { contaComum: 'Conta conjunta', extratoContaComum: 'Extrato conjunta', cartaoComum: 'Cartão comum', faturaCartaoComum: 'Fatura cartão comum' };

  function definirRotulosCasa(estado, rotulos) {
    const r = Object.assign({}, ROTULOS_CASA_PADRAO, estado.rotulosCasa, rotulos || {});
    for (const campo of ['contaComum', 'extratoContaComum', 'cartaoComum', 'faturaCartaoComum']) {
      if (!r[campo]) throw erro('Falta informar o rótulo: ' + campo + '.');
    }
    estado.rotulosCasa = r;
  }

  function pagoPorCasa(estado, t) {
    const r = estado.rotulosCasa || ROTULOS_CASA_PADRAO;
    if (t.manual) return (estado.nomePessoa || '?') + ' (exceção)';
    return t.origem === 'cartao' ? r.cartaoComum : r.contaComum;
  }
  function origemCasa(estado, t) {
    const r = estado.rotulosCasa || ROTULOS_CASA_PADRAO;
    if (t.manual) return 'Lançamento manual';
    return t.origem === 'cartao' ? r.faturaCartaoComum : r.extratoContaComum;
  }

  // "Enviar Casa para a planilha da família": só itens Casa do mês, no formato que o Apps Script
  // (codigo/appsScriptCasa.gs) espera. A última coluna (ID) não aparece na planilha visível — o script usa
  // só para não lançar o mesmo item duas vezes, mesmo que a pessoa reenvie o arquivo depois.
  // Pede estado.nomePessoa já cadastrado (ver Motor.definirNomePessoa) — só é usado quando o item for
  // um lançamento manual (a exceção); itens vindos de extrato/fatura usam "Conta conjunta"/"Cartão comum".
  function exportarCasaCSV(estado, competencia) {
    if (!estado.nomePessoa) throw erro('Informe seu nome em Ajustes antes de enviar para a planilha da família.');
    const itens = itensCasa(estado, competencia);
    const linhas = [linhaCSV(['Data', 'Descrição', 'Categoria', 'Tipo', 'Pago por', 'Origem', 'Valor', 'Observação', 'ID'])];
    for (const t of itens) {
      const obs = t.parcela ? 'Parcela ' + t.parcela : '';
      linhas.push(linhaCSV([t.data, t.descricao, t.categoria || '', t.frequencia || '', pagoPorCasa(estado, t), origemCasa(estado, t), (-t.valor).toFixed(2), obs, t.id]));
    }
    return { texto: linhas.join('\r\n'), quantidade: itens.length, ids: itens.map(t => t.id) };
  }

  // Chamar depois que a pessoa confirmar que o arquivo foi salvo de fato (não só gerado), para marcar
  // na tela que esses itens já foram enviados (não impede reenvio; o Apps Script evita duplicar pelo ID).
  function marcarCasaEnviada(estado, ids) {
    const agora = new Date().toISOString();
    for (const id of ids) { const t = estado.lancamentos[id]; if (t) t.enviadoCasaEm = agora; }
  }

  // ---------- serialização (o app grava/lê o arquivo de dados) ----------
  function serializar(estado) { return JSON.stringify(estado, null, 2); }
  function desserializar(texto) {
    const e = JSON.parse(texto);
    if (!e || typeof e !== 'object' || !e.lancamentos || !e.regras) throw new Error('Arquivo de dados inválido ou corrompido.');
    return e;
  }

  g.Motor = {
    VERSAO, FREQUENCIAS, ROTULOS_CASA_PADRAO, categoriasPadrao, estadoNovo, definirNomePessoa, definirLinkPlanilhaFamilia, definirLimiteCategoria, definirRotulosCasa, importar, verificarSobreposicao, aplicarRegras,
    classificar, classificarUm, classificarReceita, classificarReceitaUm, novidades, resumoMes, orcamentoMes, mesesComLancamentos, itensCasa,
    serializar, desserializar, lancarManual, pendentesManuais, confirmarConciliacao,
    rejeitarConciliacao, conciliacoesPendentesDetalhadas, exportarResumoCSV, exportarCasaCSV, marcarCasaEnviada
  };
})(typeof window !== 'undefined' ? window : globalThis);
