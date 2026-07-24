import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Non-fertilizer inventory items — pesticides, tools, PPE, seeds, containers,
 * etc. Fertilizers stay in the dedicated Inventory model (tied to the
 * Fertilizer master list); anything else lives here.
 *
 * Unlike fertilizer inventory (always grams), a Supply's unit is user-defined
 * so tools can be counted in pieces, oil in litres, seeds in kg, etc.
 * `quantity` is stored as an integer in the smallest unit the planter cares
 * about (e.g. 1 pair, 500 g of seeds — the user picks the unit at create-time).
 */
const supplySchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ['pesticide', 'tool', 'ppe', 'seed', 'container', 'other'],
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true }, // "pieces", "kg", "L", ...
    quantity: { type: Number, default: 0, min: 0 },
    lowStockThreshold: { type: Number, default: 0, min: 0 },
    /**
     * Rolling average unit cost, in paise per unit. Updated by supply purchases
     * (weighted by quantity). Null until the first purchase is logged.
     */
    avgUnitCostPaise: { type: Number, default: null, min: 0 },
    active: { type: Boolean, default: true, index: true },
    notes: { type: String, default: null, trim: true },
  },
  { timestamps: true },
);

supplySchema.index(
  { plantationId: 1, name: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

supplySchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    category: this.category,
    name: this.name,
    unit: this.unit,
    quantity: this.quantity,
    lowStockThreshold: this.lowStockThreshold,
    avgUnitCostPaise: this.avgUnitCostPaise,
    active: this.active,
    isLow:
      this.lowStockThreshold > 0 && this.quantity < this.lowStockThreshold,
    notes: this.notes,
  };
};

export const Supply = mongoose.model('Supply', supplySchema);
