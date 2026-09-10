import { User } from '../models/User.js';
import { Subscription } from '../models/Subscription.js';

/**
 * Subscription service for managing App Store purchases.
 * TODO: Integrate with App Store Server API for receipt verification
 * See: https://developer.apple.com/documentation/appstoreserverapi
 */

/**
 * Verify and activate subscription from iOS purchase.
 *
 * @param {string} userId - User ID
 * @param {string} platform - 'ios' or 'android'
 * @param {string} productId - Product ID (mce_pro_yearly or mce_pro_monthly)
 * @param {string} purchaseToken - Raw receipt/transaction ID
 * @returns {Promise<Object>} Subscription status
 */
export async function verifySubscription(userId, platform, productId, purchaseToken) {
  try {
    if (!['mce_pro_yearly', 'mce_pro_monthly'].includes(productId)) {
      throw new Error('Invalid product ID');
    }

    if (!['ios', 'android'].includes(platform)) {
      throw new Error('Invalid platform');
    }

    // Verify receipt with Apple
    const receiptData = await verifyAppleReceipt(purchaseToken);

    if (!receiptData || !receiptData.signedTransactionInfo) {
      throw new Error('Invalid receipt data from App Store');
    }

    // Calculate expiration date based on product
    const now = Date.now();
    const expiresDateMs = productId === 'mce_pro_yearly'
      ? now + (365 * 24 * 60 * 60 * 1000)  // 1 year
      : now + (30 * 24 * 60 * 60 * 1000);  // 30 days (for trial)

    // Create subscription record
    const subscription = new Subscription({
      userId,
      platform,
      productId,
      purchaseToken,
      originalTransactionId: receiptData.originalTransactionId || purchaseToken,
      purchaseDateMs: receiptData.transactionDateMilliseconds || now,
      expiresDateMs,
      isActive: true,
      isTrial: productId === 'mce_pro_monthly', // Monthly starts as trial
      verifiedAt: new Date(),
    });

    await subscription.save();

    // Update user plan to pro
    await User.findByIdAndUpdate(userId, {
      plan: 'pro',
      trialEndsAt: new Date(expiresDateMs),
    });

    return {
      success: true,
      plan: 'pro',
      expiresAt: new Date(expiresDateMs),
      subscription: subscription.toObject(),
    };
  } catch (error) {
    console.error('Subscription verification failed:', error);
    throw error;
  }
}

/**
 * Get user's active subscription status.
 *
 * @param {string} userId - User ID
 * @returns {Promise<Object>} Current subscription status
 */
export async function getSubscriptionStatus(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) {
      throw new Error('User not found');
    }

    // Check for active subscription
    const activeSubscription = await Subscription.findOne({
      userId,
      isActive: true,
      expiresDateMs: { $gt: Date.now() },
    }).sort({ createdAt: -1 });

    if (!activeSubscription) {
      return {
        plan: user.plan,
        isPaid: false,
        expiresAt: null,
      };
    }

    // Update user plan if subscription exists but user plan hasn't synced
    if (user.plan !== 'pro') {
      user.plan = 'pro';
      user.trialEndsAt = new Date(activeSubscription.expiresDateMs);
      await user.save();
    }

    return {
      plan: 'pro',
      isPaid: !activeSubscription.isTrial,
      expiresAt: new Date(activeSubscription.expiresDateMs),
      productId: activeSubscription.productId,
      isActive: true,
    };
  } catch (error) {
    console.error('Get subscription status failed:', error);
    throw error;
  }
}

/**
 * Check if subscription has expired and update user status.
 * (Call this periodically or on user login)
 *
 * @param {string} userId - User ID
 */
export async function syncSubscriptionStatus(userId) {
  try {
    const user = await User.findById(userId);
    if (!user) return;

    const activeSubscription = await Subscription.findOne({
      userId,
      isActive: true,
      expiresDateMs: { $gt: Date.now() },
    }).sort({ createdAt: -1 });

    if (!activeSubscription && user.plan === 'pro') {
      // Subscription expired, downgrade to free
      user.plan = 'free';
      user.trialEndsAt = null;
      await user.save();
    } else if (activeSubscription && user.plan !== 'pro') {
      // Subscription active but user plan not updated
      user.plan = 'pro';
      user.trialEndsAt = new Date(activeSubscription.expiresDateMs);
      await user.save();
    }
  } catch (error) {
    console.error('Sync subscription status failed:', error);
  }
}

/**
 * Verify receipt with Apple App Store Server API.
 * Validates that a purchase was legitimate before granting subscription access.
 */
async function verifyAppleReceipt(transactionId) {
  try {
    const token = _generateAppStoreToken();

    const response = await fetch(
      `https://api.storekit.itunes.apple.com/inApps/v1/transactions/decode/${transactionId}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        }
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error('App Store API error:', error);
      throw new Error(`App Store verification failed: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Receipt verification error:', error);
    throw new Error(`Failed to verify receipt: ${error.message}`);
  }
}

/**
 * Generate JWT token for App Store Server API authentication.
 */
function _generateAppStoreToken() {
  const jwt = require('jsonwebtoken');

  const privateKey = process.env.APP_STORE_PRIVATE_KEY;
  const keyId = process.env.APP_STORE_KEY_ID;
  const issuerId = process.env.APP_STORE_ISSUER_ID;

  if (!privateKey || !keyId || !issuerId) {
    throw new Error('Missing App Store Server API configuration in .env');
  }

  const payload = {
    iss: issuerId,
    aud: 'appstoreconnect-v1',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiry
  };

  const token = jwt.sign(payload, privateKey, {
    algorithm: 'ES256',
    header: {
      alg: 'ES256',
      kid: keyId,
      typ: 'JWT',
    }
  });

  return token;
}
