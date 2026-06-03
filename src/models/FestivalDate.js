import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * One paid festival day per plantation. Up to 13 per calendar year per the
 * CGA rules (brief §4.2, §5.4.6).
 *
 * When a marked festival date falls within a union worker's payroll week,
 * the daily wage is auto-added regardless of whether they attended.
 */
const festivalDateSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    date: { type: Date, required: true, index: true },
    label: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);

festivalDateSchema.index({ plantationId: 1, date: 1 }, { unique: true });

festivalDateSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    date: this.date,
    label: this.label,
  };
};

export const FestivalDate = mongoose.model('FestivalDate', festivalDateSchema);
