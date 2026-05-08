import { TaxInvoice } from '../models';
import { config } from '../config';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Generate the next invoice number atomically (per type / FY). */
export async function generateInvoiceNumber(type: 'customer' | 'driver_payout' | 'tds_certificate'): Promise<string> {
  const prefix = config.tax.invoicePrefix || 'UKC';
  const now = new Date();
  // Indian fiscal year (Apr-Mar)
  const fyStart = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fyEnd = (fyStart + 1).toString().slice(-2);
  const fyTag = `${fyStart.toString().slice(-2)}${fyEnd}`;

  const typeTag =
    type === 'customer' ? 'C' : type === 'driver_payout' ? 'D' : 'T';

  // Count invoices of same type within FY
  const fyStartDate = new Date(fyStart, 3, 1, 0, 0, 0);
  const fyEndDate = new Date(fyStart + 1, 3, 1, 0, 0, 0);
  const count = await TaxInvoice.countDocuments({
    type,
    createdAt: { $gte: fyStartDate, $lt: fyEndDate },
  });

  const seq = (count + 1).toString().padStart(6, '0');
  return `${prefix}/${typeTag}/${fyTag}/${seq}`;
}

interface BuildCustomerInvoiceArgs {
  rideAmount: number;          // gross fare incl. service
  receiverName?: string;
  receiverState?: string;
  receiverGstin?: string;
  receiverAddress?: string;
  rideId?: string;
  customerId?: string;
  paymentId?: string;
  description?: string;
}

/**
 * Build a customer (B2C/B2B) GST invoice for a ride.
 * Uses 5% GST split (CGST 2.5 + SGST 2.5) for intra-state, IGST 5 for inter-state.
 */
export function buildCustomerInvoiceLines(args: BuildCustomerInvoiceArgs) {
  const isInterState = !!(args.receiverState && config.tax.issuerState && args.receiverState !== config.tax.issuerState);
  // Treat input rideAmount as the gross (tax-inclusive) fare. Back out the tax.
  const gstRate = config.tax.gstRate;
  const taxable = r2(args.rideAmount / (1 + gstRate));
  const totalTax = r2(args.rideAmount - taxable);

  const cgst = isInterState ? 0 : r2(totalTax / 2);
  const sgst = isInterState ? 0 : r2(totalTax - cgst);
  const igst = isInterState ? totalTax : 0;

  const lineItem = {
    description: args.description || 'Ride booking service',
    hsnSac: config.tax.rideHsn,
    quantity: 1,
    unitPrice: taxable,
    amount: taxable,
    taxableAmount: taxable,
    cgst,
    sgst,
    igst,
    cgstRate: isInterState ? 0 : config.tax.cgstRate,
    sgstRate: isInterState ? 0 : config.tax.sgstRate,
    igstRate: isInterState ? config.tax.igstRate : 0,
  };

  return {
    lineItems: [lineItem],
    subTotal: taxable,
    totalCgst: cgst,
    totalSgst: sgst,
    totalIgst: igst,
    totalTax,
    totalAmount: r2(args.rideAmount),
    isInterState,
  };
}

interface BuildDriverPayoutArgs {
  driverEarnings: number;       // gross paid to driver
  rideId?: string;
  driverId?: string;
  paymentId?: string;
}

/**
 * TDS u/s 194-O: 1% on gross payments to e-commerce participant (driver).
 */
export function buildDriverPayoutInvoice(args: BuildDriverPayoutArgs) {
  const gross = r2(args.driverEarnings);
  const tdsRate = config.tax.tdsRate;
  const tdsAmount = r2(gross * tdsRate);
  const netPayable = r2(gross - tdsAmount);

  return {
    lineItems: [
      {
        description: 'Driver-partner payout (gross)',
        hsnSac: '',
        quantity: 1,
        unitPrice: gross,
        amount: gross,
        taxableAmount: gross,
        cgst: 0,
        sgst: 0,
        igst: 0,
      },
    ],
    subTotal: gross,
    totalCgst: 0,
    totalSgst: 0,
    totalIgst: 0,
    totalTax: 0,
    totalAmount: gross,
    tdsApplicable: true,
    tdsSection: config.tax.tdsSection,
    tdsRate,
    tdsAmount,
    netPayable,
  };
}

export const invoicingDefaults = {
  issuerName: config.tax.issuerName,
  issuerGstin: config.tax.issuerGstin,
  issuerPan: config.tax.issuerPan,
  issuerAddress: config.tax.issuerAddress,
  issuerState: config.tax.issuerState,
};
