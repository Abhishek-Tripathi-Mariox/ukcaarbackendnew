import { NotificationTemplate, Notification, User } from '../models';
import { sendPushToTokens } from '../config/firebase';
import { emitToUser } from '../socket';

export interface RenderedTemplate {
  title: string;
  body: string;
  type: 'ride' | 'payment' | 'promo' | 'safety' | 'system';
  channel: 'push' | 'inapp' | 'both';
  data: Record<string, any>;
  templateKey: string;
  locale: string;
}

/**
 * Substitute {{var}} placeholders. Missing variables are replaced with an
 * empty string. Supports nested paths via dot syntax: {{ride.id}}.
 */
export function renderString(template: string, vars: Record<string, any>): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const segments = path.split('.');
    let cur: any = vars;
    for (const seg of segments) {
      if (cur == null) return '';
      cur = cur[seg];
    }
    return cur == null ? '' : String(cur);
  });
}

/**
 * Look up a template by key (with locale fallback to "en") and render it
 * with the given variables. Returns `null` if the template is missing or
 * inactive — callers should fall back to a hardcoded message.
 */
export async function renderTemplate(
  key: string,
  vars: Record<string, any> = {},
  locale: string = 'en',
): Promise<RenderedTemplate | null> {
  let tpl = await NotificationTemplate.findOne({ key, locale, isActive: true });
  if (!tpl && locale !== 'en') {
    tpl = await NotificationTemplate.findOne({ key, locale: 'en', isActive: true });
  }
  if (!tpl) return null;

  const merged = { ...(tpl.defaultData || {}), ...vars };
  return {
    title: renderString(tpl.titleTemplate, merged),
    body: renderString(tpl.bodyTemplate, merged),
    type: tpl.type,
    channel: tpl.channel,
    data: merged,
    templateKey: tpl.key,
    locale: tpl.locale,
  };
}

/**
 * Copy-only template hook for EXISTING notification sites. Returns the
 * rendered title/body when an active template exists for `key`, else the
 * supplied fallback (today's hardcoded copy) — so wiring a site changes
 * nothing until an admin actually creates the template. Delivery stays with
 * the call site: data payloads like kind:'ride:new-request' drive app
 * routing and must not be altered by templating.
 */
export async function templatedCopy(
  key: string,
  vars: Record<string, any>,
  fallback: { title: string; body: string },
  locale: string = 'en',
): Promise<{ title: string; body: string; usedTemplate: boolean }> {
  try {
    const rendered = await renderTemplate(key, vars, locale);
    if (rendered) return { title: rendered.title, body: rendered.body, usedTemplate: true };
  } catch {
    // Template lookup must never break a production notification.
  }
  return { ...fallback, usedTemplate: false };
}

/**
 * Every template key the backend consults, with the variables each exposes.
 * Served to the admin panel (GET /admin/notification-templates/registry) so
 * admins create templates against real keys instead of guessing.
 */
export const TEMPLATE_REGISTRY: {
  key: string;
  audience: 'customer' | 'driver';
  description: string;
  variables: string[];
}[] = [
  { key: 'ride.new_request', audience: 'driver', description: 'New ride request offered to nearby drivers', variables: ['tier', 'customerName', 'pickup', 'dropoff'] },
  { key: 'ride.driver_assigned', audience: 'customer', description: 'A driver accepted / was assigned to the ride', variables: ['driverName', 'assignedBy'] },
  { key: 'ride.admin_assigned', audience: 'driver', description: 'Admin assigned a ride directly to the driver', variables: ['pickup'] },
  { key: 'ride.driver_arrived', audience: 'customer', description: 'Driver reached the pickup point', variables: [] },
  { key: 'ride.started', audience: 'customer', description: 'Trip started (admin OTP verify)', variables: [] },
  { key: 'ride.started_driver', audience: 'driver', description: 'Trip started (admin OTP verify), driver copy', variables: [] },
  { key: 'ride.completed', audience: 'customer', description: 'Ride completed (admin path)', variables: ['fare'] },
  { key: 'ride.completed_driver', audience: 'driver', description: 'Ride completed, earnings credited (admin path)', variables: ['earnings'] },
  { key: 'application.approved', audience: 'driver', description: 'Driver application approved', variables: [] },
  { key: 'application.rejected', audience: 'driver', description: 'Driver application rejected', variables: ['reason'] },
  { key: 'document.rejected', audience: 'driver', description: 'A driver document was rejected for re-upload', variables: ['documentType', 'note'] },
  { key: 'scheduled.early_drop_request', audience: 'driver', description: 'Customer asked to leave the shuttle early', variables: ['customerName', 'seats'] },
  { key: 'scheduled.early_drop_approved', audience: 'customer', description: 'Driver approved the early drop', variables: ['refund'] },
  { key: 'scheduled.early_drop_declined', audience: 'customer', description: 'Driver declined the early drop', variables: ['reason'] },
];

/**
 * Render a template and dispatch it to a user across the configured channels:
 *   - "inapp": persist a Notification doc + emit a socket event
 *   - "push": fan out FCM
 *   - "both": both of the above
 *
 * If the template is missing, falls back to the supplied `fallback` payload
 * so existing call sites keep working during migration.
 */
export async function sendTemplated(
  userId: string,
  key: string,
  vars: Record<string, any> = {},
  fallback?: { title: string; body: string; type?: 'ride' | 'payment' | 'promo' | 'safety' | 'system' },
): Promise<{ delivered: boolean; usedFallback: boolean }> {
  const user = await User.findById(userId).select('fcmTokens language');
  if (!user) return { delivered: false, usedFallback: false };

  const locale = (user as any).language || 'en';
  const rendered = await renderTemplate(key, vars, locale);
  let payload: { title: string; body: string; type: 'ride' | 'payment' | 'promo' | 'safety' | 'system'; channel: 'push' | 'inapp' | 'both'; data: Record<string, any> };
  let usedFallback = false;

  if (rendered) {
    payload = {
      title: rendered.title,
      body: rendered.body,
      type: rendered.type,
      channel: rendered.channel,
      data: { ...rendered.data, templateKey: key },
    };
  } else if (fallback) {
    usedFallback = true;
    payload = {
      title: fallback.title,
      body: fallback.body,
      type: fallback.type ?? 'system',
      channel: 'both',
      data: { ...vars, templateKey: key, fallback: true },
    };
  } else {
    return { delivered: false, usedFallback: false };
  }

  // 1) In-app feed.
  if (payload.channel === 'inapp' || payload.channel === 'both') {
    await Notification.create({
      user: user._id,
      title: payload.title,
      body: payload.body,
      type: payload.type,
      data: payload.data,
    }).catch(() => undefined);

    emitToUser(user._id.toString(), 'notification:new', {
      title: payload.title,
      body: payload.body,
      type: payload.type,
      data: payload.data,
      timestamp: new Date(),
    });
  }

  // 2) Push.
  if (payload.channel === 'push' || payload.channel === 'both') {
    const tokens = (user.fcmTokens ?? []).map((t) => t.token).filter(Boolean);
    if (tokens.length > 0) {
      const result = await sendPushToTokens(tokens, {
        title: payload.title,
        body: payload.body,
        data: Object.fromEntries(
          Object.entries(payload.data).map(([k, v]) => [k, v == null ? '' : String(v)]),
        ),
      });
      if (result.invalidTokens.length > 0) {
        await User.updateOne(
          { _id: user._id },
          { $pull: { fcmTokens: { token: { $in: result.invalidTokens } } } },
        );
      }
    }
  }

  return { delivered: true, usedFallback };
}
