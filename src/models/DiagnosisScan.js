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
    /** Total quantity for areaAcres. Absent on scans made before it existed. */
    doseForArea: { type: String, default: '' },
    schedule: { type: String, default: '' },
    /**
     * PPE and handling. Absent on scans made before Phase B — the UI hides
     * the block rather than showing an empty safety panel, which would read
     * as "no precautions needed".
     */
    safetyPrecautions: { type: String, default: '' },
    /** Re-entry + pre-harvest interval. Legally significant; see above. */
    reEntryInterval: { type: String, default: '' },
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

/**
 * Did the recommended treatment actually work? — Phase 2 spec, Module 01,
 * "community diagnosis feedback loop".
 *
 * This is the only signal that tells us whether the model is any good. The
 * accuracy rollup reads it, and it is the labelled dataset a future
 * fine-tune would train on, so it is collected from day one even though
 * nothing user-facing depends on it yet.
 */
const feedbackSchema = new Schema(
  {
    outcome: {
      type: String,
      enum: ['worked', 'partial', 'failed'],
      required: true,
    },
    note: { type: String, default: '', maxlength: 1000 },
    at: { type: Date, required: true },
  },
  { _id: false },
);

/** One extra photo on a multi-photo scan (Pro). */
const extraImageSchema = new Schema(
  {
    data: { type: String, required: true },
    mime: { type: String, default: 'image/jpeg' },
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

    /**
     * Photos 2 and 3 of a multi-photo scan (Pro only). The first photo stays
     * in `imageBase64` so every existing reader — history thumbnails, the
     * detail screen, exports — keeps working untouched.
     */
    extraImages: { type: [extraImageSchema], default: [] },

    /** Which plant part the planter tagged the photo with; null if skipped. */
    plantPart: {
      type: String,
      enum: ['leaf', 'stem', 'capsule', 'rhizome', 'whole plant', null],
      default: null,
    },

    /**
     * Exactly what context the model was given (district, month, season,
     * weather, acreage). Stored per scan because the same photo scanned in
     * June and in February should produce different answers — without this
     * snapshot a past diagnosis can't be explained or replayed. Also the
     * training set for any future fine-tune (Phase 2 spec, agronomy KB).
     */
    contextSnapshot: { type: Schema.Types.Mixed, default: null },

    /** Provider used: 'mock' | 'claude' */
    provider: { type: String, required: true },
    /** Specific model id (e.g. 'claude-haiku-4-5-20251001'). */
    modelUsed: { type: String, default: '' },
    /** Raw structured response from the model — kept for audit + future re-render. */
    rawResponse: { type: Schema.Types.Mixed, default: null },

    /** Parsed structured fields the UI renders directly. */
    topDiagnosis: { type: String, required: true },
    /** Visual evidence the model says it saw. Empty on pre-Phase-B scans. */
    symptoms: { type: String, default: '' },
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
    /** Acreage doseForArea was sized for (plot if picked, else whole estate). */
    areaAcres: { type: Number, default: null },

    /** Did the planter actually act on the recommendation? */
    treatmentTaken: { type: Boolean, default: false },
    treatmentTakenAt: { type: Date, default: null },

    /** Outcome reported by the planter, once they report one. */
    feedback: { type: feedbackSchema, default: null },

    /**
     * When to ask "did it work?" — scan date + 7 days. The phone schedules a
     * local notification for this instant; the server stores it so the app
     * can rebuild its reminders after a reinstall or device change.
     * Cleared once feedback arrives.
     */
    followUpAt: { type: Date, default: null },

    /**
     * False when the model declined to diagnose ("Not a cardamom plant",
     * "Image unclear"). Those do not count against the monthly quota — the
     * planter got no advice — but the record is kept, because a planter
     * whose photos keep coming back unclear is a signal worth seeing.
     */
    isDiagnostic: { type: Boolean, default: true, index: true },

    /** Latency in ms — useful for monitoring. */
    latencyMs: { type: Number, default: 0 },
  },
  { timestamps: true },
);

diagnosisScanSchema.index({ plantationId: 1, createdAt: -1 });

// Repeat-diagnosis detection: "same disease, same plot, last 30 days".
diagnosisScanSchema.index({ plantationId: 1, plotId: 1, topDiagnosis: 1, createdAt: -1 });

// Accuracy rollup scans by outcome over a date range, across all estates.
diagnosisScanSchema.index({ 'feedback.outcome': 1, createdAt: -1 });

// Pending follow-ups the app needs to re-schedule after a reinstall.
diagnosisScanSchema.index({ plantationId: 1, followUpAt: 1 });

diagnosisScanSchema.methods.toPublicJSON = function ({
  includeImage = false,
} = {}) {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    plotId: this.plotId?.toString() ?? null,
    provider: this.provider,
    modelUsed: this.modelUsed,
    plantPart: this.plantPart ?? null,
    topDiagnosis: this.topDiagnosis,
    symptoms: this.symptoms ?? '',
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
      doseForArea: this.treatment?.doseForArea ?? '',
      schedule: this.treatment?.schedule ?? '',
      safetyPrecautions: this.treatment?.safetyPrecautions ?? '',
      reEntryInterval: this.treatment?.reEntryInterval ?? '',
    },
    advice: this.advice,
    areaAcres: this.areaAcres ?? null,
    isDiagnostic: this.isDiagnostic ?? true,
    treatmentTaken: this.treatmentTaken ?? false,
    treatmentTakenAt: this.treatmentTakenAt ?? null,
    feedback: this.feedback
      ? {
          outcome: this.feedback.outcome,
          note: this.feedback.note ?? '',
          at: this.feedback.at,
        }
      : null,
    followUpAt: this.followUpAt ?? null,
    photoCount: 1 + (this.extraImages?.length ?? 0),
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
