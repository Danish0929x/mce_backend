import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Every change to a Supply's quantity is recorded here. Purchases have
 * positive `delta` + a cost; usage/adjustments have signed `delta` + a
 * reason. This is the single source of truth for spending reports.
 */
const supplyLogSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    supplyId: {
      type: Schema.Types.ObjectId,
      ref: 'Supply',
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: ['purchase', 'use', 'adjust'],
      required: true,
      index: true,
    },
    delta: { type: Number, required: true }, // Signed; purchase>0, use<0, adjust either.
    unitCostPaise: { type: Number, default: null, min: 0 }, // Set only for purchase.
    totalCostPaise: { type: Number, default: 0, min: 0 },   // Purchase only.
    supplier: { type: String, default: null, trim: true },
    reason: { type: String, default: null, trim: true },
    at: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

supplyLogSchema.index({ plantationId: 1, at: -1 });

supplyLogSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    supplyId: this.supplyId.toString(),
    kind: this.kind,
    delta: this.delta,
    unitCostPaise: this.unitCostPaise,
    totalCostPaise: this.totalCostPaise,
    supplier: this.supplier,
    reason: this.reason,
    at: this.at,
  };
};

export const SupplyLog = mongoose.model('SupplyLog', supplyLogSchema);
