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
