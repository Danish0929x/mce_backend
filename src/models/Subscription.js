import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Subscription purchase record.
 * Tracks App Store purchases for Pro plan subscriptions.
 *
 * plan_type: 'yearly' (₹4,200/year) or 'monthly' (₹399/month)
 */
const subscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    platform: {
      type: String,
      enum: ['ios', 'android'],
      required: true,
    },
    productId: {
      type: String,
      enum: ['mce_pro_yearly', 'mce_pro_monthly'],
      required: true,
    },
    purchaseToken: {
      type: String,
      required: true,
    },
    originalTransactionId: {
      type: String,
      index: true,
    },
    purchaseDateMs: {
      type: Number,
    },
    expiresDateMs: {
      type: Number,
      required: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isTrial: {
      type: Boolean,
      default: false,
    },
    cancelledDateMs: {
      type: Number,
      default: null,
    },
    verifiedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true },
);

subscriptionSchema.index({ userId: 1, isActive: 1 });
subscriptionSchema.index({ originalTransactionId: 1 });

export const Subscription = mongoose.model('Subscription', subscriptionSchema);
