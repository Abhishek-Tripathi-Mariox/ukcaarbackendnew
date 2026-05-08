import PDFDocument from 'pdfkit';
import { Response } from 'express';
import type { ITaxInvoice } from '../models';

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/**
 * Stream a tax invoice PDF directly to an Express response.
 */
export function streamInvoicePdf(invoice: ITaxInvoice, res: Response) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${invoice.invoiceNumber.replace(/[\\/]/g, '_')}.pdf"`
  );

  doc.pipe(res);

  // Title
  doc
    .fontSize(18)
    .fillColor('#111')
    .text(
      invoice.type === 'tds_certificate'
        ? 'TDS Certificate'
        : invoice.type === 'driver_payout'
        ? 'Driver Payout Statement'
        : 'Tax Invoice',
      { align: 'center' }
    );
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#555').text(`Invoice No: ${invoice.invoiceNumber}`, { align: 'center' });
  if (invoice.issuedAt) {
    doc.text(`Issued: ${new Date(invoice.issuedAt).toLocaleString('en-IN')}`, { align: 'center' });
  }
  doc.moveDown();

  // Issuer / receiver block
  const top = doc.y;
  doc.fontSize(11).fillColor('#000').text('From', 40, top, { underline: true });
  doc.fontSize(10).text(invoice.issuerName, 40, top + 14);
  if (invoice.issuerAddress) doc.text(invoice.issuerAddress, 40);
  if (invoice.issuerGstin) doc.text(`GSTIN: ${invoice.issuerGstin}`, 40);
  if (invoice.issuerPan) doc.text(`PAN: ${invoice.issuerPan}`, 40);

  doc.fontSize(11).text('To', 320, top, { underline: true });
  doc.fontSize(10).text(invoice.receiverName || '—', 320, top + 14);
  if (invoice.receiverAddress) doc.text(invoice.receiverAddress, 320);
  if (invoice.receiverGstin) doc.text(`GSTIN: ${invoice.receiverGstin}`, 320);
  if (invoice.receiverPan) doc.text(`PAN: ${invoice.receiverPan}`, 320);
  if (invoice.placeOfSupply) doc.text(`Place of supply: ${invoice.placeOfSupply}`, 320);

  doc.moveDown(2);

  // Line items table
  const tableTop = doc.y + 10;
  doc.fontSize(10).fillColor('#000');
  doc.rect(40, tableTop, 515, 18).fill('#f3f4f6').stroke();
  doc.fillColor('#111');
  doc.text('Description', 45, tableTop + 5);
  doc.text('HSN', 250, tableTop + 5);
  doc.text('Qty', 290, tableTop + 5);
  doc.text('Rate', 320, tableTop + 5);
  doc.text('Taxable', 365, tableTop + 5);
  doc.text('CGST', 415, tableTop + 5);
  doc.text('SGST', 450, tableTop + 5);
  doc.text('IGST', 485, tableTop + 5);
  doc.text('Amount', 520, tableTop + 5);

  let rowY = tableTop + 22;
  invoice.lineItems.forEach((li) => {
    doc.fontSize(9);
    doc.text(li.description, 45, rowY, { width: 200 });
    doc.text(li.hsnSac || '', 250, rowY);
    doc.text(String(li.quantity), 290, rowY);
    doc.text(r2(li.unitPrice), 320, rowY);
    doc.text(r2(li.taxableAmount ?? li.amount), 365, rowY);
    doc.text(r2(li.cgst || 0), 415, rowY);
    doc.text(r2(li.sgst || 0), 450, rowY);
    doc.text(r2(li.igst || 0), 485, rowY);
    doc.text(r2(li.amount + (li.cgst || 0) + (li.sgst || 0) + (li.igst || 0)), 520, rowY);
    rowY += 18;
  });

  doc.moveTo(40, rowY).lineTo(555, rowY).stroke('#ddd');
  rowY += 8;
  doc.fontSize(10);
  const summary = [
    ['Subtotal', r2(invoice.subTotal)],
    ['CGST', r2(invoice.totalCgst)],
    ['SGST', r2(invoice.totalSgst)],
    ['IGST', r2(invoice.totalIgst)],
    ['Total Tax', r2(invoice.totalTax)],
    ['Total', r2(invoice.totalAmount)],
  ];
  summary.forEach(([label, val]) => {
    doc.text(label, 400, rowY);
    doc.text(`₹ ${val}`, 500, rowY, { width: 55, align: 'right' });
    rowY += 14;
  });

  if (invoice.tdsApplicable) {
    rowY += 10;
    doc.fontSize(10).fillColor('#a16207').text(
      `TDS u/s ${invoice.tdsSection || '194O'} @ ${(((invoice.tdsRate || 0) * 100) || 0).toFixed(2)}% : ₹ ${r2(
        invoice.tdsAmount || 0
      )}`,
      40,
      rowY
    );
    rowY += 14;
    doc.fontSize(11).fillColor('#000').text(`Net payable: ₹ ${r2(invoice.netPayable || 0)}`, 40, rowY);
  }

  if (invoice.notes) {
    doc.moveDown(2);
    doc.fontSize(9).fillColor('#555').text(`Note: ${invoice.notes}`);
  }

  doc.fontSize(8).fillColor('#888').text(
    'This is a system-generated invoice and does not require signature.',
    40,
    780,
    { align: 'center', width: 515 }
  );

  doc.end();
}
