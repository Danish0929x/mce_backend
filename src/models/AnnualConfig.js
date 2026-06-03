import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Annual benefit configuration. Single document — globally shared since CGA
 * settlements apply across Idukki/Wayanad. Planters can override at year end
 * if CGA changes the bonus rate (was 12.5% in 2024–25, 18% in 2025–26).
 *
 * Money fields are stored as **paise** (integers). Ratios as plain numbers.
 *
 * @see Developer brief §4.2 (annual_config), §7.4
 */
const annualConfigSchema = new Schema(
  {
    year: { type: Number, required: true, unique: true, index: true },
    /** Bonus = total wages × bonus_pct. Stored as a fraction (0.18 = 18%). */
    bonusPct: { type: Number, default: 0.18 },
    /** Up to N paid festival days per year (typically 13). */
    festivalDays: { type: Number, default: 13 },
    /** Annual sick allowance in days × avg daily wage. */
    sickDays: { type: Number, default: 6 },
    /** Leave with wages = (days worked ÷ leave_ratio) × avg daily wage. */
    leaveRatio: { type: Number, default: 20 },
    /** Blanket allowance in paise — currently ₹350. */
    blanketPaise: { type: Number, default: 35000 },
    /** Bonus per day spent on spraying — in paise. */
    sprayingAllowancePaise: { type: Number, default: 325 },
    /** Bonus per day spent on shade work — in paise. */
    shadeAllowancePaise: { type: Number, default: 325 },
  },
  { timestamps: true },
);

annualConfigSchema.methods.toPublicJSON = function () {
  return {
    year: this.year,
    bonusPct: this.bonusPct,
    festivalDays: this.festivalDays,
    sickDays: this.sickDays,
    leaveRatio: this.leaveRatio,
    blanketPaise: this.blanketPaise,
    sprayingAllowancePaise: this.sprayingAllowancePaise,
    shadeAllowancePaise: this.shadeAllowancePaise,
  };
};

export const AnnualConfig = mongoose.model('AnnualConfig', annualConfigSchema);
