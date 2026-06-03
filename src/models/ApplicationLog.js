import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Records of completed fertilizer applications.
 *
 * Created when a planter taps "Mark as applied" on a scheduled item. Carries
 * the actual quantity used (may differ from scheduled total) and decrements
 * the matching Inventory row atomically.
 *
 * @see Developer brief §4.3, §5.3.2, §5.3.4
 */
const applicationLogSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    fertilizerId: {
      type: Schema.Types.ObjectId,
      ref: 'Fertilizer',
      required: true,
    },
    plotId: {
      type: Schema.Types.ObjectId,
      ref: 'Plot',
      default: null,
    },
    /** Originating fertilizer_schedule row, if any. Custom ad-hoc apps are null. */
    scheduleId: {
      type: Schema.Types.ObjectId,
      ref: 'FertilizerSchedule',
      default: null,
    },
    quantityUsedGrams: { type: Number, required: true, min: 0 },
    applicationMethod: { type: String, default: 'broadcasting' },
    appliedAt: { type: Date, default: () => new Date(), index: true },
    /** Optional user reference for the row's "Applied by" pill. */
    appliedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

applicationLogSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    fertilizerId: this.fertilizerId.toString(),
    plotId: this.plotId?.toString() ?? null,
    scheduleId: this.scheduleId?.toString() ?? null,
    quantityUsedKg: this.quantityUsedGrams / 1000,
    applicationMethod: this.applicationMethod,
    appliedAt: this.appliedAt,
    appliedBy: this.appliedBy?.toString() ?? null,
    notes: this.notes,
  };
};

export const ApplicationLog = mongoose.model(
  'ApplicationLog',
  applicationLogSchema,
);
