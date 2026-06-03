import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Scheduled fertilizer application.
 *
 * One row per planned application. Status transitions:
 *   `upcoming` → `due` (when scheduledDate <= today) → `completed` | `skipped`
 *
 * `plotId` is optional — null means "all plots". When the planter taps
 * "Mark as applied", an `application_log` row is created and inventory is
 * decremented atomically.
 *
 * @see Developer brief §4.3, §5.3.1, §5.3.2
 */
const fertilizerScheduleSchema = new Schema(
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
    /** null = applied across all plots */
    plotId: {
      type: Schema.Types.ObjectId,
      ref: 'Plot',
      default: null,
    },
    scheduledDate: { type: Date, required: true, index: true },
    perAcreKg: { type: Number, required: true, min: 0 },
    totalQuantityKg: { type: Number, required: true, min: 0 },
    /** 'soil-drench' | 'foliar-spray' | 'broadcasting' | 'fertigation' */
    applicationMethod: { type: String, default: 'broadcasting' },
    status: {
      type: String,
      enum: ['upcoming', 'due', 'completed', 'skipped'],
      default: 'upcoming',
      index: true,
    },
    notes: { type: String, default: '' },
  },
  { timestamps: true },
);

fertilizerScheduleSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    fertilizerId: this.fertilizerId.toString(),
    plotId: this.plotId?.toString() ?? null,
    scheduledDate: this.scheduledDate,
    perAcreKg: this.perAcreKg,
    totalQuantityKg: this.totalQuantityKg,
    applicationMethod: this.applicationMethod,
    status: this.status,
    notes: this.notes,
  };
};

export const FertilizerSchedule = mongoose.model(
  'FertilizerSchedule',
  fertilizerScheduleSchema,
);
