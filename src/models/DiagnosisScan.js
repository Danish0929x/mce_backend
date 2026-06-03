import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * AI crop diagnosis scan — brief §4.4, §6.1.
 *
 * Stores the leaf/stem/capsule photo the planter took, the model used,
 * raw model response (for audit), and the structured diagnosis we render
 * in the app.
 *
 * Image is stored as base64 inline to keep MVP simple. When pilot scales
 * we'll move to S3/Supabase Storage and replace `imageBase64` with `imageUrl`.
 */
const treatmentSchema = new Schema(
  {
    summary: { type: String, default: '' },
    products: { type: [String], default: [] },
    doseringPerAcre: { type: String, default: '' },
    schedule: { type: String, default: '' },
  },
  { _id: false },
);

const alternativeSchema = new Schema(
  {
    name: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1 },
  },
  { _id: false },
);

const diagnosisScanSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    plotId: {
      type: Schema.Types.ObjectId,
      ref: 'Plot',
      default: null,
    },
    scannedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** Base64-encoded JPEG/PNG of the leaf/stem/capsule. */
    imageBase64: { type: String, required: true },
    imageMime: { type: String, default: 'image/jpeg' },

    /** Provider used: 'mock' | 'claude' */
    provider: { type: String, required: true },
    /** Specific model id (e.g. 'claude-haiku-4-5-20251001'). */
    modelUsed: { type: String, default: '' },
    /** Raw structured response from the model — kept for audit + future re-render. */
    rawResponse: { type: Schema.Types.Mixed, default: null },

    /** Parsed structured fields the UI renders directly. */
    topDiagnosis: { type: String, required: true },
    confidence: { type: Number, min: 0, max: 1, default: 0 },
    severity: {
      type: String,
      enum: ['mild', 'moderate', 'severe', 'unknown'],
      default: 'unknown',
    },
    isHealthy: { type: Boolean, default: false },
    alternatives: { type: [alternativeSchema], default: [] },
    treatment: { type: treatmentSchema, default: () => ({}) },
    advice: { type: String, default: '' },

    /** Latency in ms — useful for monitoring. */
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

diagnosisScanSchema.index({ plantationId: 1, createdAt: -1 });

diagnosisScanSchema.methods.toPublicJSON = function ({
  includeImage = false,
} = {}) {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    plotId: this.plotId?.toString() ?? null,
    provider: this.provider,
    modelUsed: this.modelUsed,
    topDiagnosis: this.topDiagnosis,
    confidence: this.confidence,
    severity: this.severity,
    isHealthy: this.isHealthy,
    alternatives: this.alternatives.map((a) => ({
      name: a.name,
      confidence: a.confidence,
    })),
    treatment: {
      summary: this.treatment?.summary ?? '',
      products: this.treatment?.products ?? [],
      doseringPerAcre: this.treatment?.doseringPerAcre ?? '',
      schedule: this.treatment?.schedule ?? '',
    },
    advice: this.advice,
    latencyMs: this.latencyMs,
    createdAt: this.createdAt,
    // Image only sent on detail view to keep list payloads small.
    imageBase64: includeImage ? this.imageBase64 : null,
    imageMime: this.imageMime,
  };
};

export const DiagnosisScan = mongoose.model(
  'DiagnosisScan',
  diagnosisScanSchema,
);
