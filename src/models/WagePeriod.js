import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One Cardamom Growers Association quarterly circular = one WagePeriod row.
 *
 * Stores Basic + DA + computed Total per day, in **paise** (integers, never
 * floats). Active period for any given date is found via:
 *   `effectiveFrom <= date <= effectiveTo`
 *
 * Scoped per plantation: each planter enters the circulars for their own
 * estate (brief §5.4.5, §7.3), and like every other table a planter can only
 * touch rows for the plantation they own (§3.2). New plantations are seeded
 * with the published circulars from brief §7.3.
 *
 * Edits to a started period need the planter's confirmation; edits to a
 * period with paid payroll need an admin override (§7.6 rule 103).
 *
 * @see Developer brief §4.2, §7.3
 */
const wagePeriodSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    label: { type: String, required: true, trim: true }, // e.g. "Apr–Jun 2026"
    effectiveFrom: { type: Date, required: true, index: true },
    effectiveTo: { type: Date, required: true, index: true },
    basicPaise: { type: Number, required: true, min: 0 },
    daPaise: { type: Number, required: true, min: 0 },
    /** Always equal to basicPaise + daPaise. Stored for convenience. */
    totalPaise: { type: Number, required: true, min: 0 },
    /** Set on seeded circulars. Format: 'YYYY-Qx' (e.g. '2026-Q2'). */
    seedKey: { type: String, default: null },
  },
  { timestamps: true },
);

wagePeriodSchema.index({ plantationId: 1, effectiveFrom: 1, effectiveTo: 1 });
// Each seeded circular at most once per plantation.
wagePeriodSchema.index(
  { plantationId: 1, seedKey: 1 },
  { unique: true, partialFilterExpression: { seedKey: { $type: 'string' } } },
);

wagePeriodSchema.statics.activeOn = function (plantationId, date) {
  return this.findOne({
    plantationId,
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
