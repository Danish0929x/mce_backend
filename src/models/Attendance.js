import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Daily attendance record per worker.
 *
 * Unique constraint on (workerId, workDate) — one row per worker per day.
 * Upserted by the daily attendance screen as the planter ticks present /
 * adjusts hours / toggles spraying or shade flags.
 *
 * Spraying and shade are CGA-defined specialist tasks that add an
 * allowance to the daily wage for union workers only.
 *
 * @see Developer brief §4.1 (attendance), §5.4.3
 */
const attendanceSchema = new Schema(
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
    /** Midnight UTC of the work date (we store dates without time-of-day). */
    workDate: { type: Date, required: true, index: true },
    isPresent: { type: Boolean, default: false },
    hoursWorked: { type: Number, default: 0, min: 0, max: 24 },
    sprayingFlag: { type: Boolean, default: false },
    shadeFlag: { type: Boolean, default: false },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

attendanceSchema.index({ workerId: 1, workDate: 1 }, { unique: true });

attendanceSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    workerId: this.workerId.toString(),
    workDate: this.workDate,
    isPresent: this.isPresent,
    hoursWorked: this.hoursWorked,
    sprayingFlag: this.sprayingFlag,
    shadeFlag: this.shadeFlag,
    notes: this.notes,
  };
};

export const Attendance = mongoose.model('Attendance', attendanceSchema);
