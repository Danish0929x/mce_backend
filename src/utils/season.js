/**
 * Kerala cardamom seasonal context — Phase 2 spec, Module 01.
 *
 * The spec requires the current month to be passed into the diagnosis prompt
 * as "seasonal context". Month alone is a weak signal to a model, so we
 * translate it into what it actually means agronomically in the Western
 * Ghats: which diseases are under pressure right now, and whether the crop
 * is in harvest.
 *
 * Pure functions, no I/O — safe to unit test and to call per request.
 */

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Kerala's agricultural calendar, by IST month index (0 = January).
 *
 * Two different things live here, and only one reaches the model.
 *
 * `conditions` is physical: rain, humidity, light, soil moisture, what the
 * plant is actually experiencing. That is legitimate evidence — a model can
 * reason from "prolonged leaf wetness" to a fungal risk the same way an
 * agronomist would.
 *
 * `pressure` names the diseases themselves. It is **deliberately not sent to
 * the model**. Measured behaviour: with the disease list in the prompt, the
 * same photograph came back as leaf blight in November and Chenthal disease
 * in February — the model was choosing from the list it had been handed
 * rather than reading the image. A list of disease names next to a photo is
 * an answer key, not context. It is kept here, and recorded on each scan,
 * because it is useful for analysing results after the fact.
 */
const SEASONS = [
  // Jan
  { season: 'dry season', rainfall: 'little to no rain',
  conditions: 'cool, dry air; low humidity; strong sun on exposed plants; soil drying out',
    pressure: 'thrips, shoot borer, sun scorch, visible nutrient deficiency',
    harvest: 'tail end of harvest' },
  // Feb
  { season: 'dry season', rainfall: 'little to no rain',
  conditions: 'dry and warming; low humidity; soil moisture falling; plants drawing on reserves after cropping',
    pressure: 'thrips, shoot borer, sun scorch, nutrient deficiency',
    harvest: 'harvest finishing' },
  // Mar
  { season: 'hot dry season', rainfall: 'dry, occasional thunder showers',
  conditions: 'hot days, dry air, high light intensity; water stress likely on thin shade',
    pressure: 'thrips, mites, sun scorch, water stress',
    harvest: 'off-season' },
  // Apr
  { season: 'hot dry season', rainfall: 'pre-monsoon showers begin',
  conditions: 'hot with occasional heavy showers; sharp swings between wet and dry; humidity rising',
    pressure: 'thrips, capsule borer, sun scorch; early fungal risk after showers',
    harvest: 'off-season, panicle initiation' },
  // May
  { season: 'pre-monsoon', rainfall: 'increasing pre-monsoon showers',
  conditions: 'humid and warming; first sustained wetting of foliage and soil',
    pressure: 'onset of fungal disease, thrips still active',
    harvest: 'flowering begins' },
  // Jun
  { season: 'south-west monsoon', rainfall: 'heavy, sustained rain',
  conditions: 'prolonged leaf wetness, saturated soil, high humidity, little drying between showers',
    pressure: 'azhukal (Phytophthora) capsule rot, rhizome rot — peak risk',
    harvest: 'flowering and early capsule set' },
  // Jul
  { season: 'south-west monsoon', rainfall: 'heavy, sustained rain',
  conditions: 'prolonged leaf wetness, waterlogged soil in low spots, very high humidity',
    pressure: 'azhukal (Phytophthora) capsule rot, rhizome rot — peak risk',
    harvest: 'capsule development' },
  // Aug
  { season: 'south-west monsoon', rainfall: 'heavy rain, short breaks',
  conditions: 'heavy rain with short bright breaks; soil still saturated; humid',
    pressure: 'azhukal, rhizome rot, leaf blight',
    harvest: 'early harvest begins' },
  // Sep
  { season: 'late monsoon', rainfall: 'reducing but frequent rain',
  conditions: 'frequent rain easing; foliage wet much of the day; warm and humid',
    pressure: 'leaf blight, late capsule rot, katte (mosaic) symptoms visible',
    harvest: 'peak harvest' },
  // Oct
  { season: 'north-east monsoon', rainfall: 'intermittent heavy showers',
  conditions: 'intermittent heavy showers; warm, humid; soil wet but draining',
    pressure: 'leaf blight, capsule rot, katte (mosaic)',
    harvest: 'peak harvest' },
  // Nov
  { season: 'north-east monsoon', rainfall: 'reducing showers',
  conditions: 'showers easing; humid days, cooler nights; soil moisture falling; plants depleted after heavy cropping',
    pressure: 'leaf blight, nutrient deficiency after heavy cropping',
    harvest: 'harvest continuing' },
  // Dec
  { season: 'post-monsoon dry', rainfall: 'drying out, cool nights',
  conditions: 'drying air, cool nights, cold at higher elevations; soil moisture falling',
    pressure: 'thrips returning, nutrient deficiency, cold injury at altitude',
    harvest: 'late harvest' },
];

/**
 * Seasonal context for an IST calendar day.
 * @param {Date} istDay UTC-midnight-of-IST-day, as produced by todayIST()
 */
export function seasonalContext(istDay) {
  const m = istDay.getUTCMonth();
  return { month: MONTHS[m], monthIndex: m, ...SEASONS[m] };
}

export { MONTHS };
