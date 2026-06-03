import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Recurring bonus rule. Two flavours per brief §5.4.9:
 *  - `festive`  — date-triggered. e.g. "Onam bonus, every Sept 5, ₹2,000/worker"
 *  - `tenure_milestone` — years-of-service triggered. e.g. "10-year bonus, ₹5,000"
 *
 * The rule lives on the plantation; it applies to all active workers that
 * match its filter (defaults to union-only, since temp workers don't usually
 * receive these). Money in **paise**.
 */
const bonusRuleSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    type: {
      type: String,
      enum: ['festive', 'tenure_milestone'],
      required: true,
    },
    amountPaise: { type: Number, required: true, min: 0 },
    /** For 'festive' rules — month (1–12) and day (1–31). Year-agnostic. */
    triggerMonth: { type: Number, default: null, min: 1, max: 12 },
    triggerDay: { type: Number, default: null, min: 1, max: 31 },
    /** For 'tenure_milestone' rules — the year at which it triggers. */
    triggerYears: { type: Number, default: null, min: 1 },
    /** 'union' | 'temp' | 'all' */
    appliesTo: { type: String, default: 'union', enum: ['union', 'temp', 'all'] },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

bonusRuleSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    name: this.name,
    type: this.type,
    amountPaise: this.amountPaise,
    triggerMonth: this.triggerMonth,
    triggerDay: this.triggerDay,
    triggerYears: this.triggerYears,
    appliesTo: this.appliesTo,
    active: this.active,
  };
};

export const BonusRule = mongoose.model('BonusRule', bonusRuleSchema);
