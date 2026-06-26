import { Schema, model, Document, Types } from 'mongoose';

export type TicketStatus = 'open' | 'pending_user' | 'in_progress' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TicketCategory =
  | 'ride_issue'
  | 'payment'
  | 'refund'
  | 'driver_behavior'
  | 'lost_item'
  | 'safety'
  | 'account'
  | 'app_bug'
  | 'other';

export type TicketSenderRole = 'customer' | 'driver' | 'admin' | 'system';

export interface ITicketMessage {
  _id?: Types.ObjectId;
  sender: Types.ObjectId;
  senderRole: TicketSenderRole;
  body: string;
  attachments?: string[];
  /** internal=true: visible to admins only, never to customer/driver */
  internal: boolean;
  createdAt: Date;
  readByAdmin?: boolean;
  readByUser?: boolean;
}

export interface ISupportTicket extends Document {
  _id: Types.ObjectId;
  ticketNumber: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  submittedBy: Types.ObjectId;
  submittedByRole: 'customer' | 'driver';
  assignedTo?: Types.ObjectId;
  relatedRide?: Types.ObjectId;
  relatedPayment?: Types.ObjectId;
  messages: Types.DocumentArray<ITicketMessage & Document>;
  tags?: string[];
  resolution?: string;
  slaDueAt?: Date;
  firstResponseAt?: Date;
  resolvedAt?: Date;
  closedAt?: Date;
  /**
   * Who moved the ticket into its current `closed` state. Admin-closed
   * tickets are terminal — they can't be reopened by a customer reply or by
   * an admin, so the customer has to open a new ticket. A ticket the customer
   * closed themselves stays reopenable. Cleared whenever a ticket reopens.
   */
  closedByRole?: TicketSenderRole;
  reopenCount: number;
  lastUpdatedBy?: Types.ObjectId;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

const messageSchema = new Schema<ITicketMessage>(
  {
    sender: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    senderRole: {
      type: String,
      enum: ['customer', 'driver', 'admin', 'system'],
      required: true,
    },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    attachments: [{ type: String }],
    internal: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
    readByAdmin: { type: Boolean, default: false },
    readByUser: { type: Boolean, default: false },
  },
  { _id: true }
);

const supportTicketSchema = new Schema<ISupportTicket>(
  {
    ticketNumber: { type: String, required: true, unique: true, index: true },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    description: { type: String, required: true, trim: true, maxlength: 5000 },
    category: {
      type: String,
      enum: [
        'ride_issue',
        'payment',
        'refund',
        'driver_behavior',
        'lost_item',
        'safety',
        'account',
        'app_bug',
        'other',
      ],
      default: 'other',
      index: true,
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high', 'urgent'],
      default: 'normal',
      index: true,
    },
    status: {
      type: String,
      enum: ['open', 'pending_user', 'in_progress', 'resolved', 'closed'],
      default: 'open',
      index: true,
    },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    submittedByRole: { type: String, enum: ['customer', 'driver'], required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', index: true },
    relatedRide: { type: Schema.Types.ObjectId, ref: 'Ride' },
    relatedPayment: { type: Schema.Types.ObjectId, ref: 'Payment' },
    messages: { type: [messageSchema], default: [] },
    tags: [{ type: String, trim: true }],
    resolution: { type: String, maxlength: 2000 },
    slaDueAt: { type: Date, index: true },
    firstResponseAt: { type: Date },
    resolvedAt: { type: Date },
    closedAt: { type: Date },
    closedByRole: { type: String, enum: ['customer', 'driver', 'admin', 'system'] },
    reopenCount: { type: Number, default: 0 },
    lastUpdatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    metadata: { type: Schema.Types.Mixed },
  },
  { timestamps: true }
);

supportTicketSchema.index({ status: 1, priority: -1, createdAt: -1 });
supportTicketSchema.index({ assignedTo: 1, status: 1 });
supportTicketSchema.index({ submittedBy: 1, createdAt: -1 });

export const SupportTicket = model<ISupportTicket>('SupportTicket', supportTicketSchema);
