import jwt from 'jsonwebtoken';

/**
 * Server-side purchase verification against the App Store and Google Play.
 *
 * Both functions ask the store for the subscription's CURRENT state, so the
 * same call serves the first purchase and later renewal checks. They return
 * a normalized entitlement:
 *   { productId, originalTransactionId, purchaseDateMs, expiresDateMs, active }
 *
 * Required env (see .env.example):
 *   iOS:     APP_STORE_ISSUER_ID, APP_STORE_KEY_ID, APP_STORE_PRIVATE_KEY,
 *            APP_STORE_BUNDLE_ID
 *   Android: GOOGLE_PLAY_PACKAGE_NAME, GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL,
 *            GOOGLE_PLAY_SERVICE_ACCOUNT_KEY
 */

const APPLE_HOSTS = [
  'https://api.storekit.itunes.apple.com', // production
  'https://api.storekit-sandbox.itunes.apple.com', // TestFlight / sandbox
];

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    const e = new Error(`Store verification is not configured: ${missing.join(', ')}`);
    e.status = 503;
    e.code = 'store_not_configured';
    throw e;
  }
  return names.map((n) => process.env[n].replace(/\\n/g, '\n'));
}

function storeError(message) {
  const e = new Error(message);
  e.status = 400;
  e.code = 'invalid_purchase';
  return e;
}

/** Payload of a JWS from Apple. Trusted because it came straight from Apple over TLS. */
function decodeJwsPayload(jws) {
  const part = jws.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
}

// ---------- App Store ----------

function appStoreToken() {
  const [issuerId, keyId, privateKey, bundleId] = requireEnv(
    'APP_STORE_ISSUER_ID',
    'APP_STORE_KEY_ID',
    'APP_STORE_PRIVATE_KEY',
    'APP_STORE_BUNDLE_ID',
  );
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iss: issuerId, iat: now, exp: now + 20 * 60, aud: 'appstoreconnect-v1', bid: bundleId },
    privateKey,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: keyId, typ: 'JWT' } },
  );
}

/**
 * Latest state of the subscription that [transactionId] belongs to, via
 * App Store Server API "Get All Subscription Statuses". Tries production
 * first, then sandbox, as Apple recommends.
 */
export async function verifyAppStore({ transactionId, productId }) {
  if (!/^\d+$/.test(String(transactionId ?? ''))) {
    throw storeError('Missing or invalid App Store transaction ID.');
  }
  const token = appStoreToken();
  const bundleId = process.env.APP_STORE_BUNDLE_ID;

  let body = null;
  for (const host of APPLE_HOSTS) {
    const res = await fetch(`${host}/inApps/v1/subscriptions/${transactionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) continue; // not in this environment
    if (!res.ok) {
      throw new Error(`App Store verification failed (${res.status}).`);
    }
    body = await res.json();
    break;
  }
  if (!body) throw storeError('App Store has no record of this purchase.');
  if (body.bundleId && body.bundleId !== bundleId) {
    throw storeError('Purchase belongs to a different app.');
  }

  // Newest transaction of the requested product across subscription groups.
  const latest = (body.data ?? [])
    .flatMap((g) => g.lastTransactions ?? [])
    .map((t) => ({
      status: t.status,
      tx: decodeJwsPayload(t.signedTransactionInfo),
    }))
    .filter(({ tx }) => tx.productId === productId)
    .sort((a, b) => (b.tx.expiresDate ?? 0) - (a.tx.expiresDate ?? 0))[0];
  if (!latest) throw storeError('Purchase does not include this product.');

  const { tx, status } = latest;
  return {
    productId: tx.productId,
    originalTransactionId: String(tx.originalTransactionId),
    purchaseDateMs: tx.purchaseDate ?? null,
    expiresDateMs: tx.expiresDate,
    // 1 = active, 4 = billing grace period. Refunds carry revocationDate.
    active: (status === 1 || status === 4) && !tx.revocationDate,
  };
}

// ---------- Google Play ----------

let googleTokenCache = { token: null, expiresAt: 0 };

async function googleAccessToken() {
  if (googleTokenCache.token && Date.now() < googleTokenCache.expiresAt - 60_000) {
    return googleTokenCache.token;
  }
  const [email, privateKey] = requireEnv(
    'GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL',
    'GOOGLE_PLAY_SERVICE_ACCOUNT_KEY',
  );
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: email,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    },
    privateKey,
    { algorithm: 'RS256' },
  );
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Google auth failed (${res.status}).`);
  const data = await res.json();
  googleTokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

/** Latest state of a Play subscription purchase token (subscriptionsv2). */
export async function verifyGooglePlay({ purchaseToken, productId }) {
  if (!purchaseToken) throw storeError('Missing Google Play purchase token.');
  const [packageName] = requireEnv('GOOGLE_PLAY_PACKAGE_NAME');
  const token = await googleAccessToken();

  const res = await fetch(
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/` +
      encodeURIComponent(purchaseToken),
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404 || res.status === 410) {
    throw storeError('Google Play has no record of this purchase.');
  }
  if (!res.ok) throw new Error(`Google Play verification failed (${res.status}).`);
  const sub = await res.json();

  const item = (sub.lineItems ?? []).find((l) => l.productId === productId);
  if (!item) throw storeError('Purchase does not include this product.');

  return {
    productId,
    // Renewals keep the same token unless the user re-subscribes, in which
    // case linkedPurchaseToken points to the original.
    originalTransactionId: sub.linkedPurchaseToken ?? purchaseToken,
    purchaseDateMs: sub.startTime ? Date.parse(sub.startTime) : null,
    expiresDateMs: Date.parse(item.expiryTime),
    active: [
      'SUBSCRIPTION_STATE_ACTIVE',
      'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
      'SUBSCRIPTION_STATE_CANCELED', // cancelled = no renewal; paid time still counts
    ].includes(sub.subscriptionState),
  };
}
