import {
  verifySubscription,
  getSubscriptionStatus,
  syncSubscriptionStatus,
} from '../../services/subscription.service.js';

/**
 * POST /api/v1/subscriptions/verify
 * Verify and activate a purchase from App Store.
 */
export async function handleVerifySubscription(req, res) {
  try {
    const { platform, productId, purchaseToken } = req.body;
    const userId = req.user.id; // From auth middleware

    if (!platform || !productId || !purchaseToken) {
      return res.status(400).json({
        error: 'Missing required fields: platform, productId, purchaseToken',
      });
    }

    if (!['ios', 'android'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform' });
    }

    const result = await verifySubscription(userId, platform, productId, purchaseToken);

    res.status(200).json({
      success: true,
      data: {
        plan: result.plan,
        expiresAt: result.expiresAt,
      },
    });
  } catch (error) {
    console.error('Verify subscription error:', error);
    res.status(500).json({
      error: error.message || 'Failed to verify subscription',
    });
  }
}

/**
 * GET /api/v1/subscriptions/status
 * Get current subscription status for the authenticated user.
 */
export async function handleGetSubscriptionStatus(req, res) {
  try {
    const userId = req.user.id;

    // Sync subscription status before returning
    await syncSubscriptionStatus(userId);

    const status = await getSubscriptionStatus(userId);

    res.status(200).json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Get subscription status error:', error);
    res.status(500).json({
      error: error.message || 'Failed to get subscription status',
    });
  }
}

/**
 * POST /api/v1/subscriptions/sync
 * Manually sync subscription status (check for expiration, etc).
 */
export async function handleSyncSubscription(req, res) {
  try {
    const userId = req.user.id;

    await syncSubscriptionStatus(userId);

    const status = await getSubscriptionStatus(userId);

    res.status(200).json({
      success: true,
      data: status,
    });
  } catch (error) {
    console.error('Sync subscription error:', error);
    res.status(500).json({
      error: error.message || 'Failed to sync subscription',
    });
  }
}
