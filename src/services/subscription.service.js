import { User } from '../models/User.js';
import { Plantation } from '../models/Plantation.js';
import { Subscription } from '../models/Subscription.js';
import { DiagnosisScan } from '../models/DiagnosisScan.js';
import { istInstantRange, todayIST } from '../utils/dates.js';
import { verifyAppStore, verifyGooglePlay } from './store-verification.service.js';

/**
 * Plans and entitlements — brief §5.5.3.
 *
 *   pro       — store-verified subscription that has not expired
 *   pro_trial — 30-day trial from signup (User.trialEndsAt)
 *   free      — everything else: max 5 active workers, 10 AI scans a
 *               month, no PDF exports, no bulk CSV import
 *
 * The plan is always derived from dates at request time, so a trial or a
 * lapsed subscription downgrades without any background job.
 */

export const FREE_WORKER_LIMIT = 5;
/** AI crop scans per calendar month (IST) on the free plan. */
export const FREE_AI_SCANS_PER_MONTH = 10;
/** Pro is a single yearly plan — ₹4,200/year (brief §5.5.3). */
export const PRODUCT_IDS = ['mce_pro_yearly'];

/** Effective plan from the user's trial and their latest subscription. */
export function effectivePlan(user, subscription, now = Date.now()) {
  if (subscription?.isActive && subscription.expiresDateMs > now) return 'pro';
  if (user?.trialEndsAt && new Date(user.trialEndsAt).getTime() > now) {
    return 'pro_trial';
  }
  return 'free';
}

export function entitlementsFor(plan) {
  const pro = plan !== 'free';
  return {
    isPro: pro,
    workerLimit: pro ? null : FREE_WORKER_LIMIT,
    aiScansPerMonth: pro ? null : FREE_AI_SCANS_PER_MONTH,
    canExportPdf: pro,
    canBulkImport: pro,
  };
}

function verifyWithStore(platform, { productId, purchaseToken, transactionId }) {
  return platform === 'ios'
    ? verifyAppStore({ transactionId, productId })
    : verifyGooglePlay({ purchaseToken, productId });
}

/**
 * The user's newest subscription. If its paid period has ended, ask the
 * store once whether it renewed and update the record (best effort — a
 * store outage leaves the stored state as is).
 */
async function latestSubscription(userId) {
  const sub = await Subscription.findOne({ userId }).sort({ expiresDateMs: -1 });
  if (!sub || !sub.isActive || sub.expiresDateMs > Date.now()) return sub;
  try {
    const ent = await verifyWithStore(sub.platform, {
      productId: sub.productId,
      purchaseToken: sub.purchaseToken,
      transactionId: sub.purchaseToken,
    });
    sub.expiresDateMs = ent.expiresDateMs;
    sub.isActive = ent.active;
    sub.verifiedAt = new Date();
    await sub.save();
  } catch (err) {
    console.error('Subscription renewal check failed:', err.message);
  }
  return sub;
}

/** Plan + entitlements for [userId], keeping User.plan in sync for display. */
export async function getEntitlements(userId) {
  const user = await User.findById(userId);
  if (!user) {
    const e = new Error('User not found');
    e.status = 404;
    throw e;
  }
  const sub = await latestSubscription(userId);
  const plan = effectivePlan(user, sub);
  if (user.plan !== plan) {
    user.plan = plan;
    await user.save();
  }
  return { user, sub, plan, entitlements: entitlementsFor(plan) };
}

/** AI scans this estate has run since the 1st of the current IST month. */
export async function aiScansThisMonth(plantationId) {
  const today = todayIST();
  const monthStart = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
  );
  return DiagnosisScan.countDocuments({
    plantationId,
    createdAt: istInstantRange(monthStart, today),
  });
}

/** Response shape for GET /subscriptions/status. */
export async function getSubscriptionStatus(userId) {
  const { user, sub, plan, entitlements } = await getEntitlements(userId);
  const plantation = await Plantation.findOne({ ownerId: userId }).select('_id');
  const aiScansUsedThisMonth = plantation
    ? await aiScansThisMonth(plantation._id)
    : 0;
  const expiresAt =
    plan === 'pro'
      ? new Date(sub.expiresDateMs)
      : plan === 'pro_trial'
        ? user.trialEndsAt
        : null;
  return {
    plan,
    isPaid: plan === 'pro',
    expiresAt,
    trialEndsAt: user.trialEndsAt ?? null,
    productId: plan === 'pro' ? sub.productId : null,
    entitlements,
    aiScansUsedThisMonth,
  };
}

/**
 * Verify a purchase with the store and attach it to [userId].
 *
 * iOS sends the StoreKit transaction ID; Android sends the purchase token.
 * A purchase already linked to another account is refused, so one
 * subscription cannot unlock several estates.
 */
export async function verifySubscription(
  userId,
  { platform, productId, purchaseToken, transactionId },
) {
  if (!PRODUCT_IDS.includes(productId)) {
    const e = new Error('Invalid product ID');
    e.status = 400;
    throw e;
  }

  const ent = await verifyWithStore(platform, {
    productId,
    purchaseToken,
    transactionId,
  });
  if (!ent.active || ent.expiresDateMs <= Date.now()) {
    const e = new Error('This subscription is not active.');
    e.status = 400;
    e.code = 'subscription_inactive';
    throw e;
  }

  const existing = await Subscription.findOne({
    originalTransactionId: ent.originalTransactionId,
  });
  if (existing && existing.userId.toString() !== userId.toString()) {
    const e = new Error('This purchase is already linked to another account.');
    e.status = 409;
    e.code = 'purchase_already_linked';
    throw e;
  }

  await Subscription.findOneAndUpdate(
    { originalTransactionId: ent.originalTransactionId },
    {
      $set: {
        userId,
        platform,
        productId,
        // What the store needs for later renewal checks.
        purchaseToken: platform === 'ios' ? String(transactionId) : purchaseToken,
        originalTransactionId: ent.originalTransactionId,
        purchaseDateMs: ent.purchaseDateMs,
        expiresDateMs: ent.expiresDateMs,
        isActive: true,
        isTrial: false,
        verifiedAt: new Date(),
      },
    },
    { upsert: true, new: true },
  );

  return getSubscriptionStatus(userId);
}
