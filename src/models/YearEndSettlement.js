import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Finalised (locked) year-end settlement of one union worker — brief §5.4.7
 * "Generated once per year and locked".
 *
 * Until a year is finalised the settlement screen shows a live preview from
 * settlement.service. Finalising stores each worker's computeSettlement
 * output here, and from then on these frozen figures are returned instead,
 * so later edits (wage periods, attendance) never change a settled year.
 * Money in **paise**.
 */
const componentsSchema = new Schema(
  {
    bonusPaise: { type: Number, required: true },
    festivalPayPaise: { type: Number, required: true },
    sickPaise: { type: Number, required: true },
    leavePaise: { type: Number, required: true },
    blanketPaise: { type: Number, required: true },
    oneOffBonusPaise: { type: Number, default: 0 },
  },
  { _id: false },
);

const yearEndSettlementSchema = new Schema(
  {
    plantationId: {
      type: Schema.Types.ObjectId,
      ref: 'Plantation',
      required: true,
      index: true,
    },
    workerId: {
      type: Schema.Types.ObjectId,
      ref: 'Worker',
      required: true,
    },
    year: { type: Number, required: true },
    /** Worker's public JSON when finalised (name, tenure as of then). */
    worker: { type: Schema.Types.Mixed, required: true },
    daysWorked: { type: Number, required: true },
    avgDailyWagePaise: { type: Number, required: true },
    wagesPaidPaise: { type: Number, required: true },
    festivalDaysPaidWeekly: { type: Number, default: 0 },
    festivalDaysDue: { type: Number, default: 0 },
    components: { type: componentsSchema, required: true },
    settlementTotalPaise: { type: Number, required: true },
    grandTotalPaise: { type: Number, required: true },
    finalizedAt: { type: Date, required: true },
    finalizedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

yearEndSettlementSchema.index(
  { plantationId: 1, workerId: 1, year: 1 },
  { unique: true },
);

/** Same shape as a live settlement breakdown row. */
yearEndSettlementSchema.methods.toPublicJSON = function () {
  return {
    worker: this.worker,
    workerId: this.workerId.toString(),
    year: this.year,
    daysWorked: this.daysWorked,
    avgDailyWagePaise: this.avgDailyWagePaise,
    wagesPaidPaise: this.wagesPaidPaise,
    festivalDaysPaidWeekly: this.festivalDaysPaidWeekly,
    festivalDaysDue: this.festivalDaysDue,
    components: {
      bonusPaise: this.components.bonusPaise,
      festivalPayPaise: this.components.festivalPayPaise,
      sickPaise: this.components.sickPaise,
      leavePaise: this.components.leavePaise,
      blanketPaise: this.components.blanketPaise,
      oneOffBonusPaise: this.components.oneOffBonusPaise ?? 0,
    },
    settlementTotalPaise: this.settlementTotalPaise,
    grandTotalPaise: this.grandTotalPaise,
  };
};

export const YearEndSettlement = mongoose.model(
  'YearEndSettlement',
  yearEndSettlementSchema,
);
