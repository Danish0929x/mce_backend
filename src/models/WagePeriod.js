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
    /**
     * Set on seeded circulars ('YYYY-Qx', e.g. '2026-Q2') and on quarters
     * created automatically ('auto-YYYY-MM-DD', the start date). Unique per
     * plantation, so a quarter is never created twice.
     */
    seedKey: { type: String, default: null },
    /**
     * Label of the circular whose Basic + DA were copied into this
     * automatically created quarter. Cleared once the planter edits it.
     */
    carriedForwardFrom: { type: String, default: null },
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

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Make sure a circular covers [today]. If the latest circular ended before
 * today, create every missing quarter up to and including today's quarter,
 * carrying forward the latest Basic + DA — so union pay never drops to ₹0
 * just because a new circular hasn't been typed in. Each such quarter is
 * flagged (carriedForwardFrom) until the planter checks and edits it.
 *
 * Does nothing when today is covered, when there are no circulars at all,
 * or when today falls in a gap the planter left before a later circular.
 */
wagePeriodSchema.statics.ensureCoversToday = async function (plantationId, today) {
  if (await this.activeOn(plantationId, today)) return;
  const latest = await this.findOne({ plantationId }).sort({ effectiveTo: -1 });
  if (!latest || latest.effectiveTo >= today) return;

  const end = latest.effectiveTo;
  let from = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1));
  while (from <= today) {
    const qEndMonth = Math.floor(from.getUTCMonth() / 3) * 3 + 2;
    const to = new Date(Date.UTC(from.getUTCFullYear(), qEndMonth + 1, 0));
    const a = MONTHS[from.getUTCMonth()];
    const b = MONTHS[to.getUTCMonth()];
    try {
      await this.create({
        plantationId,
        label: a === b ? `${a} ${to.getUTCFullYear()}` : `${a}–${b} ${to.getUTCFullYear()}`,
        effectiveFrom: from,
        effectiveTo: new Date(to.getTime() + 86_400_000 - 1), // end of day
        basicPaise: latest.basicPaise,
        daPaise: latest.daPaise,
        totalPaise: latest.basicPaise + latest.daPaise,
        seedKey: `auto-${from.toISOString().slice(0, 10)}`,
        carriedForwardFrom: latest.label,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err; // another request created it first
    }
    from = new Date(to.getTime() + 86_400_000);
  }
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
    carriedForwardFrom: this.carriedForwardFrom ?? null,
  };
};

export const WagePeriod = mongoose.model('WagePeriod', wagePeriodSchema);
