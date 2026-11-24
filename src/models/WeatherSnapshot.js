import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Cached weather per district — Phase 2 spec, Module 01 ("weather context").
 *
 * One document per district, refreshed at most every
 * WEATHER_CACHE_TTL_MINUTES (default 6h). An estate's scans all share the
 * district's snapshot, so a 50-planter district costs 4 API calls a day.
 *
 * ## Why we accumulate samples
 * The spec asks for "recent weather (last 7 days rainfall)". OpenWeather's
 * free tier only reports rain in the last 1h/3h on the current-weather
 * endpoint; 7-day history needs the paid One Call plan. Rather than pay for
 * it, each refresh appends a sample and we keep a rolling 7-day window —
 * the history builds itself at zero extra cost. Until a district has a
 * week of samples, `rain7dMm` is reported as partial and the prompt says so.
 */
const sampleSchema = new Schema(
  {
    at: { type: Date, required: true },
    /** mm of rain reported for the 3h window ending at [at]. */
    rain3hMm: { type: Number, default: 0 },
    condition: { type: String, default: '' },
    tempC: { type: Number, default: null },
    humidity: { type: Number, default: null },
  },
  { _id: false },
);

const weatherSnapshotSchema = new Schema(
  {
    /** Lowercased district name — the cache key. */
    district: { type: String, required: true, unique: true, index: true },

    fetchedAt: { type: Date, required: true },

    /** Latest reading, flattened for cheap reads. */
    condition: { type: String, default: '' },
    description: { type: String, default: '' },
    tempC: { type: Number, default: null },
    humidity: { type: Number, default: null },
    rain3hMm: { type: Number, default: 0 },

    /** Rolling 7-day window, oldest first. */
    samples: { type: [sampleSchema], default: [] },

    /** Last failure, for debugging a district that stops refreshing. */
    lastError: { type: String, default: '' },
  },
  { timestamps: true },
);

/** Total mm across the retained window, plus how much of a week it covers. */
weatherSnapshotSchema.methods.rainfallWindow = function () {
  const samples = this.samples ?? [];
  if (samples.length === 0) return { totalMm: 0, coverageDays: 0, partial: true };
  const oldest = samples[0].at.getTime();
  const coverageDays = (Date.now() - oldest) / 86_400_000;
  return {
    totalMm: samples.reduce((sum, s) => sum + (s.rain3hMm ?? 0), 0),
    coverageDays,
    partial: coverageDays < 6.5,
  };
};

export const WeatherSnapshot = mongoose.model(
  'WeatherSnapshot',
  weatherSnapshotSchema,
);
