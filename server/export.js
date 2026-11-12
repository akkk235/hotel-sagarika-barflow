/**
 * Dependency-free report exporters: real .xlsx (SpreadsheetML in a ZIP) and
 * real .pdf (multi-page, monospace tables with "Page X of Y" footers).
 * No new npm dependencies, so the image stays small and the security scan clean.
 */
import { deflateRawSync } from 'node:zlib';

const XML = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => XML[c]);

function colRef(index) {
  let s = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ------------------------------------------------------------------ ZIP ---- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipArchive(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const nameBuf = Buffer.from(file.name, 'utf8');
    const raw = Buffer.from(file.data, 'utf8');
    const deflated = deflateRawSync(raw);
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(0, 12);
    dir.writeUInt16LE(0, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt16LE(0, 30);
    dir.writeUInt16LE(0, 32);
    dir.writeUInt16LE(0, 34);
    dir.writeUInt16LE(0, 36);
    dir.writeUInt32LE(0, 38);
    dir.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([dir, nameBuf]));

    offset += local.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ----------------------------------------------------------------- XLSX ---- */
/**
 * @param {{title:string, meta?:string[], columns:string[], rows:Array<Array<string|number>>, sheetName?:string}} spec
 */
export function buildXlsx({ title, meta = [], columns, rows, sheetName = 'Report' }) {
  const aoa = [[title], ...meta.map((m) => [m]), [], columns, ...rows];
  const sheetRows = aoa
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === null || value === undefined || value === '') return '';
          const ref = `${colRef(c)}${r + 1}`;
          if (typeof value === 'number' && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
        })
        .join('');
      const style = r === 0 || r === meta.length + 2 ? ' s="1"' : '';
      return `<row r="${r + 1}"${style}>${cells}</row>`;
    })
    .join('');

  const width = Math.max(columns.length, 2);
  const cols = Array.from({ length: width }, (_, i) => {
    const header = String(columns[i] ?? '');
    return `<col min="${i + 1}" max="${i + 1}" width="${Math.min(46, Math.max(12, header.length + 6))}" customWidth="1"/>`;
  }).join('');

  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><cols>${cols}</cols><sheetData>${sheetRows}</sheetData></worksheet>`;

  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  return zipArchive([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/worksheets/sheet1.xml', data: sheet },
  ]);
}

/* ------------------------------------------------------------------ PDF ---- */
const pdfEsc = (v) => String(v ?? '').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

/** Fixed-width text table renderer (Courier 7pt, A4 landscape). */
export function buildPdf({ title, meta = [], columns, rows, footerNote = '' }) {
  const pageWidth = 842;
  const pageHeight = 595;
  const marginX = 28;
  const fontSize = 7;
  const charWidth = fontSize * 0.6;
  const lineHeight = 11;
  const maxChars = Math.floor((pageWidth - marginX * 2) / charWidth);

  // Column widths: proportional to header length and widest value, then fitted.
  const widths = columns.map((h, i) => {
    const widest = rows.reduce((m, r) => Math.max(m, String(r[i] ?? '').length), String(h).length);
    return Math.max(6, Math.min(28, widest + 1));
  });
  let total = widths.reduce((a, b) => a + b, 0);
  if (total > maxChars) {
    const scale = maxChars / total;
    for (let i = 0; i < widths.length; i += 1) widths[i] = Math.max(5, Math.floor(widths[i] * scale));
    total = widths.reduce((a, b) => a + b, 0);
  }
  const numeric = columns.map((h) => /amount|₹|total|qty|bottles|ml|value|profit|cost|collected|cash|upi|refund|count|bills|price|rate/i.test(h));

  const fit = (value, width) => {
    const s = String(value ?? '');
    return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
  };
  const formatRow = (values, isHeader = false) =>
    values
      .map((v, i) => {
        const text = fit(v, widths[i]);
        return numeric[i] && !isHeader ? text.padStart(widths[i]) : text.padEnd(widths[i]);
      })
      .join(' ')
      .trimEnd();

  const headerLines = [
    'HOTEL SAGARIKA',
    title.toUpperCase(),
    ...meta,
  ];
  const tableHeader = formatRow(columns, true);
  const rule = '-'.repeat(Math.min(maxChars, Math.max(tableHeader.length, 40)));

  const bodyLines = rows.map((r) => formatRow(r));
  const firstPageCapacity = Math.floor((pageHeight - 120 - 40) / lineHeight);
  const otherPageCapacity = Math.floor((pageHeight - 80 - 40) / lineHeight);

  const pages = [];
  let cursor = 0;
  let capacity = firstPageCapacity;
  while (cursor < bodyLines.length || pages.length === 0) {
    const slice = bodyLines.slice(cursor, cursor + capacity);
    pages.push(slice);
    cursor += capacity;
    capacity = otherPageCapacity;
  }
  if (footerNote) pages[pages.length - 1].push('', footerNote);

  const objects = [];
  const pageObjNumbers = [];
  const contentObjNumbers = [];
  // 1 catalog, 2 pages, 3 font
  let next = 4;
  pages.forEach(() => {
    pageObjNumbers.push(next);
    contentObjNumbers.push(next + 1);
    next += 2;
  });

  const contentFor = (lines, pageIndex) => {
    const ops = [];
    let y = pageHeight - 40;
    const text = (str, size = fontSize, x = marginX) => {
      ops.push(`BT /F1 ${size} Tf ${x} ${y} Td (${pdfEsc(str)}) Tj ET`);
    };
    if (pageIndex === 0) {
      text('HOTEL SAGARIKA', 14);
      y -= 16;
      text(title.toUpperCase(), 10);
      y -= 14;
      for (const m of meta) {
        text(m, 8);
        y -= 11;
      }
      y -= 4;
      text(tableHeader, 7);
      y -= 10;
      text(rule, 7);
      y -= 10;
    } else {
      text(`${title.toUpperCase()} (continued)`, 8);
      y -= 14;
      text(tableHeader, 7);
      y -= 10;
      text(rule, 7);
      y -= 10;
    }
    for (const line of lines) {
      text(line, 7);
      y -= lineHeight;
    }
    ops.push('BT /F1 7 Tf 28 22 Td (Page ' + (pageIndex + 1) + ' of ' + pages.length + ') Tj ET');
    ops.push(`BT /F1 7 Tf ${pageWidth - 250} 22 Td (Generated by Hotel Sagarika BarFlow) Tj ET`);
    return ops.join('\n');
  };

  pages.forEach((lines, index) => {
    const pageObj = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentObjNumbers[index]} 0 R >>`;
    const content = contentFor(lines, index);
    objects.push({ num: pageObjNumbers[index], body: pageObj });
    objects.push({ num: contentObjNumbers[index], body: `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream` });
  });

  const kids = pageObjNumbers.map((n) => `${n} 0 R`).join(' ');
  const allObjects = [
    { num: 1, body: '<< /Type /Catalog /Pages 2 0 R >>' },
    { num: 2, body: `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>` },
    { num: 3, body: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>' },
    ...objects,
  ].sort((a, b) => a.num - b.num);

  const info = `<< /Title (${pdfEsc(title)}) /Author (Hotel Sagarika) /Producer (BarFlow Reports) >>`;
  const infoNum = allObjects[allObjects.length - 1].num + 1;
  allObjects.push({ num: infoNum, body: info });

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of allObjects) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${obj.num} 0 obj\n${obj.body}\nendobj\n`;
  }
  const xrefStart = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${allObjects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${allObjects.length + 1} /Root 1 0 R /Info ${infoNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/* ----------------------------------------------------------------- HTML ---- */
export function buildReportHtml({ title, meta = [], columns, rows, note = '' }) {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows
    .map((r) => `<tr>${r.map((v) => `<td>${esc(typeof v === 'number' ? v.toFixed(2) : v)}</td>`).join('')}</tr>`)
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)} — Hotel Sagarika</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: "Segoe UI", Arial, sans-serif; color: #111; margin: 0; padding: 8px; }
  h1 { font-size: 18px; margin: 0 0 2px; letter-spacing: .5px; }
  h2 { font-size: 13px; margin: 0 0 8px; font-weight: 600; color: #333; text-transform: uppercase; }
  .meta { font-size: 11px; color: #444; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; }
  th { background: #eee; }
  td:last-child { text-align: right; }
  tfoot { font-size: 10px; color: #555; }
  .note { margin-top: 8px; font-size: 11px; color: #444; }
  @media print { thead { display: table-header-group; } tr { page-break-inside: avoid; } }
</style></head><body>
<h1>Hotel Sagarika</h1><h2>${esc(title)}</h2>
<div class="meta">${meta.map((m) => esc(m)).join(' · ')}</div>
<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
${note ? `<div class="note">${esc(note)}</div>` : ''}
</body></html>`;
}
