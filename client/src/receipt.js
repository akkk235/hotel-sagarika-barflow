/**
 * 58 mm thermal receipt rendering and printing.
 *
 * Kept framework-free (no React, no DOM at import time) so the layout can be
 * unit-tested in Node and reused by the billing screen and the Reports reprint.
 *
 * There is no GST, tax, discount or service charge on a BarFlow bill: the guest
 * pays exactly the sum of the selling prices, so the receipt has no such lines.
 */

export const RECEIPT_WIDTH_MM = 58;

const money = (n) => `₹${(Number(n) || 0).toFixed(2)}`;

const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function stamp(iso) {
  const raw = iso ? new Date(iso) : new Date();
  const when = Number.isNaN(raw.getTime()) ? new Date() : raw;
  return {
    date: when.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' }),
    time: when.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }),
  };
}

/** Normalise bill items into printable rows (works for saved bills and offline receipts). */
export function receiptRows(bill) {
  return (bill?.items || []).map((item) => {
    const qty = Number(item.qty) || 0;
    const total = Number(item.line_total) || 0;
    return {
      name: item.product_name || item.name || 'Item',
      variant: item.variant_label || (item.ml ? `${item.ml} ml` : ''),
      qty,
      price: Number(item.unit_price ?? (qty ? total / qty : total)) || 0,
      total,
    };
  });
}

/**
 * Build a complete, self-contained 58 mm receipt document.
 * @param {object} bill  saved bill (or offline receipt) with items
 * @param {object} settings  hotel settings (hotel_name, address, phone, invoice_footer)
 * @param {{duplicate?: boolean}} opts  duplicate adds the DUPLICATE reprint label
 */
export function buildReceiptHtml(bill, settings = {}, opts = {}) {
  const duplicate = Boolean(opts.duplicate);
  const { date, time } = stamp(bill?.created_at);
  const rows = receiptRows(bill);
  const hotel = settings.hotel_name || 'HOTEL SAGARIKA';

  const itemHtml = rows
    .map(
      (row) => `
      <tr class="item"><td colspan="2">${esc(row.name)}</td></tr>
      <tr>
        <td>${row.qty} x ${money(row.price)}${row.variant ? ` <span class="small">(${esc(row.variant)})</span>` : ''}</td>
        <td class="num">${money(row.total)}</td>
      </tr>`,
    )
    .join('');

  const change = Number(bill?.change_returned) || 0;
  const upiRef = bill?.upi_ref || bill?.payment_ref;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt ${esc(bill?.bill_no || '')}</title>
<style>
  @page { size: 58mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body {
    width: 58mm;
    padding: 2.5mm 2mm;
    font-family: "Courier New", ui-monospace, monospace;
    font-size: 10.5px;
    line-height: 1.32;
  }
  h1 { font-size: 13px; margin: 0 0 1mm; text-align: center; letter-spacing: .4px; }
  .c { text-align: center; }
  .small { font-size: 9.5px; }
  .dup { border: 1px dashed #000; text-align: center; font-weight: 700; letter-spacing: 1.5px; margin: 1.5mm 0; padding: 1mm 0; }
  hr { border: 0; border-top: 1px dashed #000; margin: 1.5mm 0; }
  table { width: 100%; border-collapse: collapse; }
  td { vertical-align: top; padding: .3mm 0; }
  tr.item td { padding-top: 1mm; font-weight: 700; }
  .num { text-align: right; white-space: nowrap; }
  .tot { font-size: 12px; font-weight: 700; }
  .foot { text-align: center; margin-top: 2mm; }
</style>
</head>
<body>
  <h1>${esc(hotel)}</h1>
  ${settings.address ? `<div class="c small">${esc(settings.address)}</div>` : ''}
  ${settings.phone ? `<div class="c small">Ph ${esc(settings.phone)}</div>` : ''}
  ${duplicate ? '<div class="dup">DUPLICATE</div>' : ''}
  <hr>
  <table>
    <tr><td>Bill no</td><td class="num">${esc(bill?.bill_no || '-')}</td></tr>
    <tr><td>Date</td><td class="num">${esc(date)}</td></tr>
    <tr><td>Time</td><td class="num">${esc(time)}</td></tr>
    <tr><td>Table</td><td class="num">${esc(bill?.table_label || 'Counter')}</td></tr>
    <tr><td>Billed by</td><td class="num">${esc(bill?.cashier_name || '')}</td></tr>
  </table>
  <hr>
  <table>${itemHtml || '<tr><td colspan="2">No items</td></tr>'}</table>
  <hr>
  <table>
    <tr class="tot"><td>TOTAL</td><td class="num">${money(bill?.total)}</td></tr>
    <tr><td>Payment</td><td class="num">${esc(String(bill?.payment_mode || '').toUpperCase())}</td></tr>
    ${change > 0 ? `<tr><td>Change</td><td class="num">${money(change)}</td></tr>` : ''}
    ${upiRef ? `<tr><td>UPI ref</td><td class="num">${esc(upiRef)}</td></tr>` : ''}
  </table>
  <hr>
  <div class="foot">${esc(settings.invoice_footer || 'Thank you, visit again!')}</div>
  ${duplicate ? '<div class="c small">Reprint of original bill</div>' : ''}
</body>
</html>`;
}

/**
 * Send a receipt document to the browser print dialog.
 *
 * A hidden 58 mm iframe keeps the till screen untouched, which works with any
 * installed printer driver (thermal, USB or network). If the iframe path is
 * blocked, fall back to a small pop-up window so the user can still print.
 *
 * @returns {boolean} true when a print dialog was invoked
 */
export function printReceiptHtml(html) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;

  try {
    const frame = document.createElement('iframe');
    frame.setAttribute('title', 'Receipt print frame');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${RECEIPT_WIDTH_MM}mm;height:180mm;border:0;`;
    document.body.appendChild(frame);
    const frameWindow = frame.contentWindow;
    const doc = frameWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    frameWindow.focus();
    frameWindow.print();
    setTimeout(() => {
      try {
        frame.remove();
      } catch {
        /* already gone */
      }
    }, 2000);
    return true;
  } catch {
    try {
      const win = window.open('', '_blank', 'width=340,height=700');
      if (!win) return false;
      win.document.open();
      win.document.write(html);
      win.document.close();
      win.focus();
      win.print();
      return true;
    } catch {
      return false;
    }
  }
}
