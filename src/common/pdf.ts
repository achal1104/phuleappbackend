/** Dependency-free minimal PDF writer (A4, Courier, paginated plain-text table). Good enough for operational reports. */
const clean = (s: any) => String(s ?? '').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function tablePdf(title: string, rows: any[], subtitle = ''): Buffer {
  const W = 595, H = 842, M = 36, FS = 8, LH = 11, CH = FS * 0.6;
  const maxChars = Math.floor((W - 2 * M) / CH);
  const lines: string[] = [];
  if (!rows.length) lines.push('(no data)');
  else {
    const keys = Object.keys(rows[0]);
    const cells = rows.map((r) => keys.map((k) => String(r[k] instanceof Date ? r[k].toISOString().slice(0, 16).replace('T', ' ') : r[k] ?? '')));
    let w = keys.map((k, i) => Math.min(30, Math.max(k.length, ...cells.map((c) => c[i].length))));
    while (w.reduce((a, b) => a + b + 2, 0) > maxChars && Math.max(...w) > 6) { const i = w.indexOf(Math.max(...w)); w[i]--; }
    const fmt = (c: string[]) => c.map((v, i) => (v.length > w[i] ? v.slice(0, Math.max(1, w[i] - 1)) + '~' : v).padEnd(w[i])).join('  ');
    lines.push(fmt(keys.map((k) => k.toUpperCase())), '-'.repeat(Math.min(maxChars, w.reduce((a, b) => a + b + 2, 0))));
    cells.forEach((c) => lines.push(fmt(c)));
  }
  const perPage = Math.floor((H - 2 * M - 60) / LH);
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (!pages.length) pages.push([]);

  const objs: string[] = [];
  const add = (s: string) => { objs.push(s); return objs.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');           // 1
  add('');                                              // 2 (filled later)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>'); // 3
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold >>'); // 4
  const kids: number[] = [];
  pages.forEach((p, n) => {
    let s = `BT /F2 14 Tf ${M} ${H - M - 8} Td (${clean(title)}) Tj ET\n`;
    s += `BT /F1 8 Tf ${M} ${H - M - 22} Td (${clean(subtitle || 'Phule Festival 2026 - Command  |  generated ' + new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC')}) Tj ET\n`;
    s += `BT /F1 ${FS} Tf ${LH} TL ${M} ${H - M - 50} Td\n`;
    p.forEach((l) => { s += `(${clean(l)}) Tj T*\n`; });
    s += 'ET\n';
    s += `BT /F1 7 Tf ${W - M - 60} ${M - 14} Td (Page ${n + 1} of ${pages.length}) Tj ET\n`;
    const c = add(`<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}endstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents ${c} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> >>`));
  });
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => k + ' 0 R').join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n'; const off: number[] = [];
  objs.forEach((o, i) => { off.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + off.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out, 'latin1');
}
