import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Log of every fertilizer top-up the planter buys. Adds to Inventory
 * atomically when written.
 *
 * `pricePerKgPaise` × `quantityGrams / 1000` = `totalCostPaise`, computed
 * server-side at insert time (never trust client math on money). Money
 * stored as integer paise per brief §7.6.
 *
 * @see Developer brief §4.3, §5.3.3
 */
const stockPurchaseSchema = new Schema(
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
    quantityGrams: { type: Number, required: true, min: 1 },
    pricePerKgPaise: { type: Number, required: true, min: 0 },
    totalCostPaise: { type: Number, required: true, min: 0 },
    supplier: { type: String, default: null, trim: true },
    purchasedAt: { type: Date, default: () => new Date(), index: true },
  },
  { timestamps: true },
);

stockPurchaseSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    fertilizerId: this.fertilizerId.toString(),
    quantityKg: this.quantityGrams / 1000,
    pricePerKgPaise: this.pricePerKgPaise,
    totalCostPaise: this.totalCostPaise,
    supplier: this.supplier,
    purchasedAt: this.purchasedAt,
  };
};

export const StockPurchase = mongoose.model(
  'StockPurchase',
  stockPurchaseSchema,
);
