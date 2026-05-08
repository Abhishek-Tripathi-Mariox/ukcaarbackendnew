import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { AuditLog } from '../models';

const SENSITIVE_KEYS = new Set([
  'password',
  'newPassword',
  'currentPassword',
  'otp',
  'token',
  'refreshToken',
  'authorization',
  'cardNumber',
  'cvv',
  'pin',
]);

function redact(input: unknown, depth = 0): unknown {
  if (input == null || depth > 4) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input !== 'object') return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

export interface AuditOptions {
  /** Action identifier, e.g. 'user.suspend'. */
  action: string;
  /** Resource type, e.g. 'User'. */
  resourceType?: string;
  /** Function to derive the resource id from the request (defaults to req.params.id). */
  resourceId?: (req: AuthRequest) => string | undefined;
  /** Skip recording when this returns true (e.g. read endpoints). */
  skip?: (req: AuthRequest, res: Response) => boolean;
  /** Add extra structured metadata to the log entry. */
  metadata?: (req: AuthRequest, res: Response) => Record<string, unknown> | undefined;
}

/**
 * Express middleware that records an audit log entry once the response is sent.
 *
 * Designed for write/sensitive admin endpoints. Place AFTER `authenticate` and
 * any permission gate so `req.user` is populated.
 */
export function auditLog(options: AuditOptions) {
  return function auditMiddleware(
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): void {
    const start = Date.now();

    res.on('finish', () => {
      try {
        if (options.skip?.(req, res)) return;
        const user = req.user;
        if (!user) return; // unauthenticated requests aren't audited here

        const status = res.statusCode;
        const outcome = status >= 200 && status < 400 ? 'success' : 'failure';
        const resourceId =
          options.resourceId?.(req) ??
          (typeof req.params?.id === 'string' ? req.params.id : undefined);

        // Fire and forget — never block the response on logging failure.
        AuditLog.create({
          actorId: user._id,
          actorEmail: user.email,
          actorRole: user.role,
          actorAdminRole: user.adminRole,
          action: options.action,
          resourceType: options.resourceType,
          resourceId,
          method: req.method,
          path: req.originalUrl ?? req.url,
          statusCode: status,
          outcome,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestBody:
            req.method === 'GET' ? undefined : (redact(req.body) as Record<string, unknown>),
          metadata: options.metadata?.(req, res),
          durationMs: Date.now() - start,
        }).catch((err) => {
          // eslint-disable-next-line no-console
          console.error('[audit] failed to write log:', err?.message ?? err);
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[audit] middleware error:', err);
      }
    });

    next();
  };
}
