import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One Cardamom Growers Association quarterly circular = one WagePeriod row.
 *
 * Stores Basic + DA + computed Total per day, in **paise** (integers, never
 * floats). Active period for any given date is found via:
 *   `effectiveFrom <= date <= effectiveTo`
 *
 * Past periods are immutable once any payroll has been calculated against
 * them. Currently global (all plantations share the same circulars) — this
 * matches reality since CGA sets them across Idukki/Wayanad.
 *
 * @see Developer brief §4.2, §7.3
 */
const wagePeriodSchema = new Schema(
  {
    label: { type: String, required: true, trim: true }, // e.g. "Apr–Jun 2026"
    effectiveFrom: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, required: true, index: true },
    basicPaise: { type: Number, required: true, min: 0 },
    daPaise: { type: Number, required: true, min: 0 },
    /** Always equal to basicPaise + daPaise. Stored for convenience. */
    totalPaise: { type: Number, required: true, min: 0 },
    /** Stable key for upsert-on-seed. Format: 'YYYY-Qx' (e.g. '2026-Q2'). */
    seedKey: { type: String, default: null, unique: true, sparse: true },
  },
  { timestamps: true },
);

wagePeriodSchema.index({ effectiveFrom: 1, effectiveTo: 1 });

wagePeriodSchema.statics.activeOn = function (date) {
  return this.findOne({
    effectiveFrom: { $lte: date },
    effectiveTo: { $gte: date },
  });
};

wagePeriodSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    label: this.label,
    effectiveFrom: this.effectiveFrom,
    effectiveTo: this.effectiveTo,
    basicPaise: this.basicPaise,
    daPaise: this.daPaise,
    totalPaise: this.totalPaise,
  };
};

export const WagePeriod = mongoose.model('WagePeriod', wagePeriodSchema);
