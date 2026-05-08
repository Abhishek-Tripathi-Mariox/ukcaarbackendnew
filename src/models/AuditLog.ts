import mongoose, { Document, Schema } from 'mongoose';

export type AuditOutcome = 'success' | 'failure';

export interface IAuditLog extends Document {
  actorId: mongoose.Types.ObjectId;
  actorEmail?: string;
  actorRole?: string;
  actorAdminRole?: string;
  action: string;                 // e.g. 'user.suspend', 'ride.cancel'
  resourceType?: string;          // e.g. 'User', 'Ride', 'Payment'
  resourceId?: string;
  method: string;                 // HTTP method
  path: string;                   // request path
  statusCode: number;
  outcome: AuditOutcome;
  ip?: string;
  userAgent?: string;
  /** Sanitised request body (sensitive fields redacted). */
  requestBody?: Record<string, unknown>;
  /** Optional structured details added by the route handler. */
  metadata?: Record<string, unknown>;
  errorMessage?: string;
  durationMs?: number;
  createdAt: Date;
}

const auditLogSchema = new Schema<IAuditLog>(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    actorEmail: String,
    actorRole: String,
    actorAdminRole: String,
    action: { type: String, required: true, index: true },
    resourceType: { type: String, index: true },
    resourceId: { type: String, index: true },
    method: { type: String, required: true },
    path: { type: String, required: true },
    statusCode: { type: Number, required: true },
    outcome: { type: String, enum: ['success', 'failure'], required: true, index: true },
    ip: String,
    userAgent: String,
    requestBody: { type: Schema.Types.Mixed },
    metadata: { type: Schema.Types.Mixed },
    errorMessage: String,
    durationMs: Number,
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Compound index for common filters
auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });

export const AuditLog = mongoose.model<IAuditLog>('AuditLog', auditLogSchema);
