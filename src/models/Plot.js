import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Sub-division of a plantation. Plots are used for plot-specific fertilizer
 * schedules and AI scan history (Phase 2). The sum of plot acreages must not
 * exceed the parent plantation's totalAcres — enforced at the controller.
 *
 * @see Developer brief §4.1
 */
const plotSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    acres: { type: Number, required: true, min: 0.01 },
    soilType: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

plotSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    name: this.name,
    acres: this.acres,
    soilType: this.soilType,
  };
};

export const Plot = mongoose.model('Plot', plotSchema);
