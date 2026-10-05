import { formatCell } from '@vnpay/ui';

/** Neutralise spreadsheet formula injection (=,+,-,@,TAB,CR at cell start) and quote per RFC 4180. */
export function csvCell(v: unknown): string {
  let s = formatCell(v).isNull ? '' : formatCell(v).text;
  if (/^[=+\-@\t\r]/.test(s) && !(typeof v === 'number' || /^-?\d+(\.\d+)?$/.test(s))) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv(columns: string[], rows: unknown[][]): string {
  return [columns.map(csvCell).join(','), ...rows.map((r) => columns.map((_, i) => csvCell(r[i])).join(','))].join('\r\n');
}
export function downloadCsv(name: string, csv: string) { downloadText(name, csv, 'text/csv;charset=utf-8', true); }
export function downloadText(name: string, text: string, mime: string, bom = false) {
  const blob = new Blob(bom ? ['﻿', text] : [text], { type: mime }); // CSV gets a BOM so Excel reads UTF-8
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** RFC 4180 parser (quoted fields, escaped quotes, CRLF/LF, newlines inside quotes). A leading BOM is ignored. */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', quoted = false;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else quoted = false; } else cur += ch;
    } else if (ch === '"' && cur === '') quoted = true;
    else if (ch === delimiter) { row.push(cur); cur = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else cur += ch;
  }
  if (cur !== '' || row.length > 0) { row.push(cur); rows.push(row); }
  return rows;
}
/** Comma, semicolon or tab: whichever is most frequent in the header line. */
export function detectDelimiter(text: string): string {
  const head = text.replace(/^\ufeff/, '').split(/\r?\n/, 1)[0] ?? '';
  return [',', ';', '\t'].map((d) => [d, head.split(d).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
}
export function downloadBytes(name: string, data: Uint8Array | Blob, mime: string) {
  const blob = data instanceof Blob ? data : new Blob([data as Uint8Array<ArrayBuffer>], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
