import { z } from 'zod';
import {
  getSubscriptionStatus,
  verifySubscription,
} from '../../services/subscription.service.js';

const verifySchema = z
  .object({
    platform: z.enum(['ios', 'android']),
    productId: z.string().min(1),
    // Android: Play purchase token. iOS: optional (receipt), unused.
    purchaseToken: z.string().min(1).optional(),
    // iOS: StoreKit transaction ID (PurchaseDetails.purchaseID).
    transactionId: z.string().min(1).optional(),
  })
  .refine((v) => (v.platform === 'ios' ? !!v.transactionId : !!v.purchaseToken), {
    message: 'iOS needs transactionId; Android needs purchaseToken.',
  });

/**
 * POST /api/v1/subscriptions/verify
 * Verify a store purchase server-side and activate Pro.
 */
export async function handleVerifySubscription(req, res, next) {
  try {
    const body = verifySchema.parse(req.body);
    const status = await verifySubscription(req.user.sub, body);
    res.json({ success: true, data: status });
  } catch (err) {
    if (err?.name === 'ZodError') {
      err.status = 400;
      err.code = 'validation_error';
    }
    next(err);
  }
}

/**
 * GET /api/v1/subscriptions/status — effective plan + entitlements.
 * POST /api/v1/subscriptions/sync — same; kept for older app builds.
 */
export async function handleGetSubscriptionStatus(req, res, next) {
  try {
    const status = await getSubscriptionStatus(req.user.sub);
    res.json({ success: true, data: status });
  } catch (err) {
    next(err);
  }
}

export const handleSyncSubscription = handleGetSubscriptionStatus;
