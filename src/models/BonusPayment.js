import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Discrete bonus payment to a specific worker. Either:
 *  - A one-off ("ruleId" null) — planter logs a custom ₹500 bonus today
 *  - A scheduled rule firing ("ruleId" set + a BonusRule reference)
 *
 * Captured here so the planter can see history per-worker and year-end
 * settlement can include them in the total.
 */
const bonusPaymentSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'Worker',
      required: true,
      index: true,
    },
    ruleId: {
      type: Schema.Types.ObjectId,
      ref: 'BonusRule',
      default: null,
    },
    amountPaise: { type: Number, required: true, min: 0 },
    reason: { type: String, default: '' },
    paidAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

bonusPaymentSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    workerId: this.workerId.toString(),
    ruleId: this.ruleId?.toString() ?? null,
    amountPaise: this.amountPaise,
    reason: this.reason,
    paidAt: this.paidAt,
  };
};

export const BonusPayment = mongoose.model('BonusPayment', bonusPaymentSchema);
