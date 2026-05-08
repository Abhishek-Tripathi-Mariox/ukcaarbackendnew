import mongoose, { Document, Schema } from 'mongoose';

export type InvoiceType = 'customer' | 'driver_payout' | 'tds_certificate';
export type InvoiceStatus = 'draft' | 'issued' | 'cancelled' | 'sent';

export interface IInvoiceLineItem {
  description: string;
  hsnSac?: string;
  quantity: number;
  unitPrice: number; // in INR (rupees, 2-decimal)
  amount: number;
  taxableAmount?: number;
  cgst?: number;
  sgst?: number;
  igst?: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
}

export interface ITaxInvoice extends Document {
  invoiceNumber: string;
  type: InvoiceType;
  status: InvoiceStatus;

  // Parties
  customer?: mongoose.Types.ObjectId;
  driver?: mongoose.Types.ObjectId;
  ride?: mongoose.Types.ObjectId;
  payment?: mongoose.Types.ObjectId;

  // Issuer (UKCAAR)
  issuerName: string;
  issuerGstin?: string;
  issuerPan?: string;
  issuerAddress?: string;
  issuerState?: string;

  // Receiver
  receiverName?: string;
  receiverGstin?: string;
  receiverPan?: string;
  receiverAddress?: string;
  receiverState?: string;

  // Tax detail
  isInterState: boolean;
  placeOfSupply?: string;

  // Line items + totals
  lineItems: IInvoiceLineItem[];
  subTotal: number;
  totalCgst: number;
  totalSgst: number;
  totalIgst: number;
  totalTax: number;
  totalAmount: number;

  // TDS (for driver payout)
  tdsApplicable: boolean;
  tdsSection?: string; // e.g. "194O"
  tdsRate?: number;
  tdsAmount?: number;
  netPayable?: number;

  // Lifecycle
  issuedAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  pdfUrl?: string;

  notes?: string;
  metadata?: Record<string, any>;

  createdBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const lineItemSchema = new Schema<IInvoiceLineItem>(
  {
    description: { type: String, required: true },
    hsnSac: String,
    quantity: { type: Number, default: 1 },
    unitPrice: { type: Number, required: true },
    amount: { type: Number, required: true },
    taxableAmount: Number,
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    cgstRate: Number,
    sgstRate: Number,
    igstRate: Number,
  },
  { _id: false }
);

const taxInvoiceSchema = new Schema<ITaxInvoice>(
  {
    invoiceNumber: { type: String, required: true, unique: true, index: true },
    type: {
      type: String,
      enum: ['customer', 'driver_payout', 'tds_certificate'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ['draft', 'issued', 'cancelled', 'sent'],
      default: 'draft',
      index: true,
    },

    customer: { type: Schema.Types.ObjectId, ref: 'User' },
    driver: { type: Schema.Types.ObjectId, ref: 'User' },
    ride: { type: Schema.Types.ObjectId, ref: 'Ride' },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment' },

    issuerName: { type: String, required: true },
    issuerGstin: String,
    issuerPan: String,
    issuerAddress: String,
    issuerState: String,

    receiverName: String,
    receiverGstin: String,
    receiverPan: String,
    receiverAddress: String,
    receiverState: String,

    isInterState: { type: Boolean, default: false },
    placeOfSupply: String,

    lineItems: { type: [lineItemSchema], default: [] },
    subTotal: { type: Number, default: 0 },
    totalCgst: { type: Number, default: 0 },
    totalSgst: { type: Number, default: 0 },
    totalIgst: { type: Number, default: 0 },
    totalTax: { type: Number, default: 0 },
    totalAmount: { type: Number, default: 0 },

    tdsApplicable: { type: Boolean, default: false },
    tdsSection: String,
    tdsRate: Number,
    tdsAmount: Number,
    netPayable: Number,

    issuedAt: Date,
    cancelledAt: Date,
    cancellationReason: String,
    pdfUrl: String,

    notes: String,
    metadata: Schema.Types.Mixed,

    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

taxInvoiceSchema.index({ type: 1, createdAt: -1 });
taxInvoiceSchema.index({ ride: 1 });
taxInvoiceSchema.index({ driver: 1, createdAt: -1 });
taxInvoiceSchema.index({ customer: 1, createdAt: -1 });

export const TaxInvoice = mongoose.model<ITaxInvoice>('TaxInvoice', taxInvoiceSchema);
