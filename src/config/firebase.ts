import admin from 'firebase-admin';
import path from 'path';
import fs from 'fs';

const SERVICE_ACCOUNT_PATH =
  process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
  path.join(process.cwd(), 'firebase-service-account.json');

let initialized = false;

export function initFirebaseAdmin(): void {
  if (initialized) return;
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn(
      `[firebase] service account not found at ${SERVICE_ACCOUNT_PATH} — push notifications disabled`,
    );
    return;
  }
  const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  initialized = true;
  console.log('[firebase] admin SDK initialized');
}

export function isFirebaseReady(): boolean {
  return initialized;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
  /**
   * Per-message Android overrides. Use this to route ride alerts to a
   * dedicated high-priority channel with a custom sound.
   */
  android?: {
    channelId?: string;
    priority?: 'normal' | 'high';
  };
}

/**
 * Sends a push to one user's tokens. Returns the list of tokens that were rejected
 * by FCM as invalid (caller should remove these from the user record).
 *
 * Why data-only on Android:
 *   Aggressive OEM ROMs (MIUI/Xiaomi, FunTouch/Vivo, ColorOS/Oppo, Realme)
 *   silently drop notification-payload pushes when the app has been killed
 *   by their battery optimizer. Data-only pushes with priority:'high' wake
 *   the app's headless background handler reliably across OEMs, where the
 *   handler then displays via Notifee (which we control end-to-end). The
 *   title/body still reach the device — they just travel inside `data` so
 *   we, not the OS, render them.
 *
 * iOS keeps the notification block — APNS is consistent and Notifee's
 *   headless display path on iOS is more limited.
 */
export async function sendPushToTokens(
  tokens: string[],
  payload: PushPayload,
): Promise<{ successCount: number; invalidTokens: string[] }> {
  if (!initialized || tokens.length === 0) {
    return { successCount: 0, invalidTokens: [] };
  }

  const androidPriority = payload.android?.priority ?? 'high';
  // Pack title/body into data so the Android headless handler can render
  // them. Stringify everything — FCM requires data values to be strings.
  const dataPayload: Record<string, string> = {
    title: payload.title,
    body: payload.body,
    ...(payload.data || {}),
  };
  if (payload.android?.channelId) {
    dataPayload.channelId = payload.android.channelId;
  }

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    // No top-level `notification` — keeps Android in data-only mode so the
    // headless handler always fires (see comment above).
    data: dataPayload,
    android: {
      priority: androidPriority,
    },
    apns: {
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: 'default',
          contentAvailable: true,
        },
      },
    },
  });

  const invalidTokens: string[] = [];
  response.responses.forEach((r, idx) => {
    if (!r.success && r.error) {
      const code = r.error.code;
      // Surface every non-success error code so we can diagnose silent
      // failures like mismatched-credential / sender-id-mismatch (which
      // are not "invalid token" but still cause success=0).
      console.warn(
        `[fcm] send failed token=${tokens[idx].slice(-8)} code=${code} message=${r.error.message}`,
      );
      if (
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/registration-token-not-registered'
      ) {
        invalidTokens.push(tokens[idx]);
      }
    }
  });

  return { successCount: response.successCount, invalidTokens };
}

export default admin;
