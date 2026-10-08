import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { Plantation } from '../models/Plantation.js';
import { Subscription } from '../models/Subscription.js';
// Load every plantation-scoped model so mongoose.models is complete.
import '../models/ApplicationLog.js';
import '../models/Attendance.js';
import '../models/BonusPayment.js';
import '../models/BonusRule.js';
import '../models/DiagnosisScan.js';
import '../models/Fertilizer.js';
import '../models/FertilizerSchedule.js';
import '../models/FestivalDate.js';
import '../models/Inventory.js';
import '../models/PayrollWeek.js';
import '../models/Plot.js';
import '../models/StockPurchase.js';
import '../models/Supply.js';
import '../models/SupplyLog.js';
import '../models/WagePeriod.js';
import '../models/Worker.js';
import '../models/YearEndSettlement.js';

/**
 * Account deletion — brief §10.4 (DPDP Act): 30-day soft delete, then a
 * hard delete of the user and everything their estate owns.
 *
 * Signing in again within the 30 days cancels the deletion (auth verify).
 */

export const DELETION_GRACE_DAYS = 30;

/**
 * Every model that stores estate data, found by its `plantationId` path,
 * so a model added later is purged without touching this file. System
 * fertilizers have plantationId null and are never matched.
 */
export function plantationScopedModels() {
  return Object.values(mongoose.models).filter((m) =>
    m.schema.path('plantationId'),
  );
}

/** Mark [user] for deletion in DELETION_GRACE_DAYS days. */
export async function scheduleDeletion(user, now = new Date()) {
  user.deletedAt = now;
  user.deleteAfter = new Date(
    now.getTime() + DELETION_GRACE_DAYS * 86_400_000,
  );
  await user.save();
  return user.deleteAfter;
}

/** Cancel a pending deletion (the user signed in again in time). */
export async function restoreAccount(user) {
  user.deletedAt = null;
  user.deleteAfter = null;
  await user.save();
}

/** Permanently delete one user and all their estate data. */
export async function hardDeleteUser(userId) {
  const plantationIds = await Plantation.find({ ownerId: userId }).distinct('_id');
  if (plantationIds.length) {
    for (const model of plantationScopedModels()) {
      await model.deleteMany({ plantationId: { $in: plantationIds } });
    }
    await Plantation.deleteMany({ _id: { $in: plantationIds } });
  }
  await Subscription.deleteMany({ userId });
  await User.deleteOne({ _id: userId });
}

/** Hard-delete every account whose grace period has ended. */
export async function purgeDueAccounts(now = new Date()) {
  const due = await User.find({ deleteAfter: { $ne: null, $lte: now } }).select('_id');
  for (const u of due) {
    await hardDeleteUser(u._id);
  }
  return due.length;
}

/** Run the purge now and then once a day while the server is up. */
export function startDeletionPurgeJob() {
  const run = () =>
    purgeDueAccounts()
      .then((n) => n && console.log(`[account-deletion] purged ${n} account(s)`))
      .catch((err) => console.error('[account-deletion] purge failed', err));
  run();
  setInterval(run, 24 * 60 * 60 * 1000).unref();
}
