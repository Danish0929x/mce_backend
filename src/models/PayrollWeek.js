import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Immutable record of one week of payroll for one worker once it has been
 * marked paid. Snapshot of the wage engine output at the moment of payment —
 * we never recompute from raw values after `paidAt` is set (brief §4.2).
 *
 * One row per (workerId, weekStart) — unique compound index enforces this.
 *
 * Money in **paise**, integers only.
 */
const dayBreakdownSchema = new Schema(
  {
    workDate: { type: Date, required: true },
    isPresent: { type: Boolean, default: false },
    hoursWorked: { type: Number, default: 0 },
    sprayingFlag: { type: Boolean, default: false },
    shadeFlag: { type: Boolean, default: false },
    isFestival: { type: Boolean, default: false },
    festivalLabel: { type: String, default: null },
    dailyPaise: { type: Number, default: 0 },
    parts: { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const payrollWeekSchema = new Schema(
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
    weekStart: { type: Date, required: true, index: true },
    weekEnd: { type: Date, required: true },
    daysPresent: { type: Number, default: 0 },
    festivalDays: { type: Number, default: 0 },
    totalHours: { type: Number, default: 0 },
    basePayPaise: { type: Number, default: 0 },
    bonusPaise: { type: Number, default: 0 },
    /** Total paid out = basePayPaise + bonusPaise. */
    totalPaise: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Frozen snapshot of the wage engine's per-day breakdown. */
    days: { type: [dayBreakdownSchema], default: [] },
  },
  { timestamps: true },
);

payrollWeekSchema.index({ workerId: 1, weekStart: 1 }, { unique: true });

payrollWeekSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    workerId: this.workerId.toString(),
    weekStart: this.weekStart,
    weekEnd: this.weekEnd,
    daysPresent: this.daysPresent,
    festivalDays: this.festivalDays,
    totalHours: this.totalHours,
    basePayPaise: this.basePayPaise,
    bonusPaise: this.bonusPaise,
    totalPaise: this.totalPaise,
    paidAt: this.paidAt,
    paidBy: this.paidBy?.toString() ?? null,
  };
};

export const PayrollWeek = mongoose.model('PayrollWeek', payrollWeekSchema);
