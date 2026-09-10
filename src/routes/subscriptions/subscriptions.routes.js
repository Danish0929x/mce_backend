import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  handleVerifySubscription,
  handleGetSubscriptionStatus,
  handleSyncSubscription,
} from '../../controllers/subscriptions/subscription.controller.js';

const router = express.Router();

/**
 * POST /api/v1/subscriptions/verify
 * Verify App Store purchase and activate subscription.
 * Body: { platform: 'ios'|'android', productId: string, purchaseToken: string }
 */
router.post('/verify', requireAuth, handleVerifySubscription);

/**
 * GET /api/v1/subscriptions/status
 * Get current subscription status.
 * Syncs with database and returns: { plan, isPaid, expiresAt, productId }
 */
router.get('/status', requireAuth, handleGetSubscriptionStatus);

/**
 * POST /api/v1/subscriptions/sync
 * Manually sync subscription status (check expiration, etc).
 * Useful on app launch to ensure subscription is current.
 */
router.post('/sync', requireAuth, handleSyncSubscription);

export default router;
