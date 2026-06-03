import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Current stock level per fertilizer per plantation.
 *
 * Incremented by stock_purchases, decremented by application_log entries.
 * Compound unique index on (plantationId, fertilizerId) — one row per pair.
 *
 * Quantity stored in **grams** (integer) to avoid floating-point drift on
 * fractional kg values. Convert to kg for display only.
 *
 * @see Developer brief §4.3
 */
const inventorySchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
    },
    fertilizerId: {
      type: Schema.Types.ObjectId,
      ref: 'Fertilizer',
      required: true,
    },
    quantityGrams: { type: Number, default: 0, min: 0 },
    /** Triggers low-stock alert if quantityGrams falls below this. */
    lowStockThresholdGrams: { type: Number, default: 5000 },
  },
  { timestamps: true },
);

inventorySchema.index(
  { plantationId: 1, fertilizerId: 1 },
  { unique: true },
);

inventorySchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    fertilizerId: this.fertilizerId.toString(),
    quantityKg: this.quantityGrams / 1000,
    lowStockThresholdKg: this.lowStockThresholdGrams / 1000,
    isLow: this.quantityGrams < this.lowStockThresholdGrams,
  };
};

export const Inventory = mongoose.model('Inventory', inventorySchema);
