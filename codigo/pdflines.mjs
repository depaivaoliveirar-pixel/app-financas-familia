// Extrai linhas de texto de um PDF usando pdf.js (mesma lógica será usada no navegador).
// Cada linha = itens com o mesmo Y; colunas separadas por "\t" quando há espaço grande entre itens.
export async function pdfLines(pdfjs, data, password) {
  const doc = await pdfjs.getDocument({ data, password, isEvalSupported: false }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items.filter(i => i.str && i.str.trim() !== '').map(i => ({
      s: i.str, x: i.transform[4], y: Math.round(i.transform[5] * 2) / 2, w: i.width
    }));
    items.sort((a, b) => b.y - a.y || a.x - b.x);
    const linhas = [];
    for (const it of items) {
      const l = linhas.find(l => Math.abs(l.y - it.y) <= 2.5);
      if (l) l.its.push(it); else linhas.push({ y: it.y, its: [it] });
    }
    linhas.sort((a, b) => b.y - a.y);
    for (const l of linhas) {
      l.its.sort((a, b) => a.x - b.x);
      let txt = '', fim = null;
      for (const it of l.its) {
        if (fim === null) txt = it.s;
        else txt += (it.x - fim > 8 ? '\t' : (it.x - fim > 0.5 ? ' ' : '')) + it.s;
        fim = it.x + it.w;
      }
      out.push({ page: p, y: l.y, text: txt.replace(/[  ]+/g, ' ').trim() });
    }
  }
  return out;
}
