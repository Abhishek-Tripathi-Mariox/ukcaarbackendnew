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
}

/**
 * Sends a push to one user's tokens. Returns the list of tokens that were rejected
 * by FCM as invalid (caller should remove these from the user record).
 */
export async function sendPushToTokens(
  tokens: string[],
  payload: PushPayload,
): Promise<{ successCount: number; invalidTokens: string[] }> {
  if (!initialized || tokens.length === 0) {
    return { successCount: 0, invalidTokens: [] };
  }

  const response = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data || {},
    android: { priority: 'high' },
    apns: { payload: { aps: { sound: 'default', contentAvailable: true } } },
  });

  const invalidTokens: string[] = [];
  response.responses.forEach((r, idx) => {
    if (!r.success && r.error) {
      const code = r.error.code;
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
