import mongoose from 'mongoose';
import { tenureYearsAt } from '../services/wage-engine.service.js';
import { todayIST } from '../utils/dates.js';

const { Schema } = mongoose;

/**
 * Plantation worker.
 *
 * `type` is the most important field — `union` means the daily rate is
 * computed from the active CGA wage_period + weightage band (the wage
 * engine). `temp` means a fixed custom rate stored on the row.
 *
 * `tempRatePaise` is stored as integer paise (never rupees, never float)
 * to match the wage engine's money convention. See brief §7.6.
 *
 * @see Developer brief §4.1
 */
const workerSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    fullName: { type: String, required: true, trim: true },
    phone: {
      type: String,
      default: null,
      // Optional, but if provided must be Indian E.164.
      match: /^\+91\d{10}$/,
    },
    type: {
      type: String,
      enum: ['union', 'temp'],
      required: true,
      index: true,
    },
    joinedAt: { type: Date, required: true },
    active: { type: Boolean, default: true, index: true },

    // Temp workers only — union workers use the active wage_period instead.
    tempPayType: { type: String, enum: ['daily', 'hourly'], default: null },
    tempRatePaise: { type: Number, default: null, min: 0 },
    /**
     * Temp rate over time, oldest first. A rate change applies from its
     * effectiveFrom date only, so unpaid past weeks keep the old rate.
     * `tempRatePaise` mirrors the latest entry for display.
     */
    tempRateHistory: {
      type: [
        {
          effectiveFrom: { type: Date, required: true },
          ratePaise: { type: Number, required: true, min: 0 },
          _id: false,
        },
      ],
      default: [],
    },
  },
  { timestamps: true },
);

// Every creation path (onboarding, add, CSV import) starts the history at
// the joining date.
workerSchema.pre('validate', function (next) {
  if (
    this.type === 'temp' &&
    this.tempRatePaise != null &&
    !this.tempRateHistory?.length
  ) {
    this.tempRateHistory = [
      { effectiveFrom: this.joinedAt, ratePaise: this.tempRatePaise },
    ];
  }
  next();
});

/** Years of full service from joinedAt to today (IST). */
workerSchema.methods.tenureYears = function () {
  return tenureYearsAt(this.joinedAt, todayIST());
};

workerSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    plantationId: this.plantationId.toString(),
    fullName: this.fullName,
    phone: this.phone,
    type: this.type,
    joinedAt: this.joinedAt,
    tenureYears: this.tenureYears(),
    active: this.active,
    tempPayType: this.tempPayType,
    tempRatePaise: this.tempRatePaise,
  };
};

export const Worker = mongoose.model('Worker', workerSchema);
