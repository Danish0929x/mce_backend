import { Fertilizer } from '../models/Fertilizer.js';
import { FertilizerSchedule } from '../models/FertilizerSchedule.js';
import { WagePeriod } from '../models/WagePeriod.js';
import { AnnualConfig } from '../models/AnnualConfig.js';

/**
 * Cardamom-specific seed data.
 *
 * System fertilizers — the master list of products commonly used on Idukki
 * and Wayanad cardamom estates. Plantation-scoped fertilizers live in the
 * same collection but are user-added.
 *
 * Default schedule — 12 applications spread across the year based on
 * Kerala Agricultural University (KAU) recommendations. Real planters can
 * customize per-plot once the editing UI lands.
 */

/** @type {Array<Partial<import('mongoose').InferSchemaType<typeof Fertilizer.schema>>>} */
const SYSTEM_FERTILIZERS = [
  {
    systemKey: 'urea',
    name: 'Urea',
    nutrientType: 'nitrogen',
    form: 'granular',
    defaultPerAcreKg: 30,
    description: '46% N · primary nitrogen source for vegetative growth',
  },
  {
    systemKey: 'mop',
    name: 'Muriate of Potash (MOP)',
    nutrientType: 'potassium',
    form: 'granular',
    defaultPerAcreKg: 40,
    description: '60% K₂O · drives capsule yield and tiller strength',
  },
  {
    systemKey: 'ssp',
    name: 'Single Super Phosphate (SSP)',
    nutrientType: 'phosphorus',
    form: 'granular',
    defaultPerAcreKg: 50,
    description: '16% P₂O₅ + sulphur · root and rhizome development',
  },
  {
    systemKey: 'npk-201010',
    name: 'NPK 20:10:10 Compound',
    nutrientType: 'compound',
    form: 'granular',
    defaultPerAcreKg: 50,
    description: 'Balanced compound · pre-monsoon establishment dose',
  },
  {
    systemKey: 'fym',
    name: 'Farmyard Manure (FYM)',
    nutrientType: 'organic',
    form: 'powder',
    defaultPerAcreKg: 500,
    description: 'Cattle-based organic compost · annual soil conditioner',
  },
  {
    systemKey: 'neem-cake',
    name: 'Neem Cake',
    nutrientType: 'organic',
    form: 'powder',
    defaultPerAcreKg: 100,
    description: 'Organic N + natural pest repellent (rhizome borer)',
  },
  {
    systemKey: 'mgso4',
    name: 'Magnesium Sulphate (MgSO₄)',
    nutrientType: 'micronutrient',
    form: 'granular',
    defaultPerAcreKg: 15,
    description: 'Mg + S · corrects pale leaf and yellowing',
  },
  {
    systemKey: 'zinc-sulphate',
    name: 'Zinc Sulphate',
    nutrientType: 'micronutrient',
    form: 'powder',
    defaultPerAcreKg: 5,
    description: 'Zn · foliar spray for capsule sizing',
  },
  {
    systemKey: 'borax',
    name: 'Borax',
    nutrientType: 'micronutrient',
    form: 'powder',
    defaultPerAcreKg: 2,
    description: 'B · flowering and capsule set',
  },
  {
    systemKey: 'lime',
    name: 'Agricultural Lime',
    nutrientType: 'soil-amendment',
    form: 'powder',
    defaultPerAcreKg: 200,
    description: 'Calcium carbonate · annual pH correction',
  },
];

/**
 * Seed the system fertilizers once. Safe to call on every server boot —
 * uses `systemKey` as the upsert key.
 */
export async function seedSystemFertilizers() {
  const ops = SYSTEM_FERTILIZERS.map((f) => ({
    updateOne: {
      filter: { systemKey: f.systemKey },
      update: {
        $set: { ...f, plantationId: null },
      },
      upsert: true,
    },
  }));
  const result = await Fertilizer.bulkWrite(ops);
  return {
    upserted: result.upsertedCount ?? 0,
    modified: result.modifiedCount ?? 0,
    matched: result.matchedCount ?? 0,
    total: SYSTEM_FERTILIZERS.length,
  };
}

/**
 * Cardamom Growers Association quarterly circulars — the actual published
 * rates per brief §7.3. Values stored as paise (integers).
 *
 * basicPaise / daPaise / totalPaise:
 *  - Apr–Jun 2025: 378.21 / 141.75 / 519.96
 *  - Jul–Sep 2025: 378.21 / 142.17 / 520.38
 *  - Oct–Dec 2025: 378.21 / 144.97 / 523.18
 *  - Jan–Mar 2026: 378.21 / 151.55 / 529.76
 *  - Apr–Jun 2026: 421.21 / 151.55 / 572.76
 */
const CGA_CIRCULARS = [
  { seedKey: '2025-Q2', label: 'Apr–Jun 2025', from: '2025-04-01', to: '2025-06-30', basic: 37821, da: 14175 },
  { seedKey: '2025-Q3', label: 'Jul–Sep 2025', from: '2025-07-01', to: '2025-09-30', basic: 37821, da: 14217 },
  { seedKey: '2025-Q4', label: 'Oct–Dec 2025', from: '2025-10-01', to: '2025-12-31', basic: 37821, da: 14497 },
  { seedKey: '2026-Q1', label: 'Jan–Mar 2026', from: '2026-01-01', to: '2026-03-31', basic: 37821, da: 15155 },
  { seedKey: '2026-Q2', label: 'Apr–Jun 2026', from: '2026-04-01', to: '2026-06-30', basic: 42121, da: 15155 },
];

/** Idempotent — upserts by seedKey. Run at every server boot. */
export async function seedWagePeriods() {
  const ops = CGA_CIRCULARS.map((c) => ({
    updateOne: {
      filter: { seedKey: c.seedKey },
      update: {
        $set: {
          label: c.label,
          effectiveFrom: new Date(c.from + 'T00:00:00.000Z'),
          effectiveTo: new Date(c.to + 'T23:59:59.999Z'),
          basicPaise: c.basic,
          daPaise: c.da,
          totalPaise: c.basic + c.da,
          seedKey: c.seedKey,
        },
      },
      upsert: true,
    },
  }));
  const result = await WagePeriod.bulkWrite(ops);
  return {
    upserted: result.upsertedCount ?? 0,
    modified: result.modifiedCount ?? 0,
    total: CGA_CIRCULARS.length,
  };
}

/** Default annual config per brief §4.2 — only seeded if missing. */
export async function seedAnnualConfig() {
  const year = new Date().getUTCFullYear();
  const existing = await AnnualConfig.findOne({ year });
  if (existing) return { upserted: 0, year };
  await AnnualConfig.create({
    year,
    bonusPct: 0.18,           // 18% in 2025–26 per brief
    festivalDays: 13,
    sickDays: 6,
    leaveRatio: 20,
    blanketPaise: 35000,      // ₹350
    sprayingAllowancePaise: 325, // ₹3.25
    shadeAllowancePaise: 325,    // ₹3.25
  });
  return { upserted: 1, year };
}

/**
 * Cardamom default 12-application calendar. Dates are computed relative to
 * the plantation creation date — first application 2 weeks out, then ~30
 * days apart. The Flutter UI lets the planter shift or skip any of them.
 *
 * Quantities are per acre; total = perAcreKg × plantationAcres.
 */
const SCHEDULE_TEMPLATE = [
  { systemKey: 'fym', perAcreKg: 500, method: 'broadcasting', dayOffset: 14 },
  { systemKey: 'lime', perAcreKg: 200, method: 'broadcasting', dayOffset: 28 },
  { systemKey: 'npk-201010', perAcreKg: 50, method: 'soil-drench', dayOffset: 45 },
  { systemKey: 'urea', perAcreKg: 30, method: 'broadcasting', dayOffset: 75 },
  { systemKey: 'mop', perAcreKg: 40, method: 'broadcasting', dayOffset: 105 },
  { systemKey: 'mgso4', perAcreKg: 15, method: 'foliar-spray', dayOffset: 135 },
  { systemKey: 'ssp', perAcreKg: 50, method: 'broadcasting', dayOffset: 165 },
  { systemKey: 'neem-cake', perAcreKg: 100, method: 'broadcasting', dayOffset: 195 },
  { systemKey: 'zinc-sulphate', perAcreKg: 5, method: 'foliar-spray', dayOffset: 225 },
  { systemKey: 'borax', perAcreKg: 2, method: 'foliar-spray', dayOffset: 255 },
  { systemKey: 'urea', perAcreKg: 30, method: 'broadcasting', dayOffset: 285 },
  { systemKey: 'mop', perAcreKg: 40, method: 'broadcasting', dayOffset: 315 },
];

/**
 * Seed the default 12-app cardamom schedule for a freshly-created plantation.
 * Run inside the same Mongo session as the plantation/plots/workers inserts.
 *
 * @param {{ plantationId: any, totalAcres: number, startDate?: Date, session?: any }} args
 */
export async function seedDefaultSchedule({
  plantationId,
  totalAcres,
  startDate = new Date(),
  session,
}) {
  // Look up the system fertilizers by key (one round trip).
  const keys = [...new Set(SCHEDULE_TEMPLATE.map((s) => s.systemKey))];
  const ferts = await Fertilizer.find(
    { systemKey: { $in: keys }, plantationId: null },
    null,
    session ? { session } : undefined,
  );
  const byKey = new Map(ferts.map((f) => [f.systemKey, f._id]));

  const docs = SCHEDULE_TEMPLATE.map((s) => {
    const date = new Date(startDate);
    date.setUTCDate(date.getUTCDate() + s.dayOffset);
    return {
      plantationId,
      fertilizerId: byKey.get(s.systemKey),
      plotId: null,
      scheduledDate: date,
      perAcreKg: s.perAcreKg,
      totalQuantityKg: Math.round(s.perAcreKg * totalAcres * 100) / 100,
      applicationMethod: s.method,
      status: 'upcoming',
    };
  }).filter((d) => d.fertilizerId); // drop any missing fertilizer

  if (!docs.length) return [];
  return FertilizerSchedule.create(
    docs,
    session ? { session, ordered: true } : undefined,
  );
}
