import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Master list of fertilizer products.
 *
 * - System fertilizers: `plantationId = null`, seeded once at server boot,
 *   visible to all plantations (Urea, MOP, SSP, organic compost, etc.)
 * - Custom fertilizers: `plantationId = <id>`, user-added, scoped to that
 *   plantation only.
 *
 * @see Developer brief §4.3
 */
const fertilizerSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      default: null,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    /** 'nitrogen' | 'phosphorus' | 'potassium' | 'compound' | 'micronutrient' | 'organic' | 'soil-amendment' */
    nutrientType: { type: String, required: true, trim: true },
    /** 'granular' | 'powder' | 'liquid' */
    form: { type: String, default: 'granular' },
    /** Optional KAU-recommended dose per acre (kg/acre). Used to project schedule quantities. */
    defaultPerAcreKg: { type: Number, default: null },
    /** Short description shown on the row (e.g. "46% N, ammonia-based"). */
    description: { type: String, default: '' },
    /** Stable string key — used for upsert-by-key during seeding. */
    systemKey: { type: String, default: null, unique: true, sparse: true },
  },
  { timestamps: true },
);

fertilizerSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId?.toString() ?? null,
    name: this.name,
    nutrientType: this.nutrientType,
    form: this.form,
    defaultPerAcreKg: this.defaultPerAcreKg,
    description: this.description,
    isSystem: this.plantationId == null,
  };
};

export const Fertilizer = mongoose.model('Fertilizer', fertilizerSchema);
