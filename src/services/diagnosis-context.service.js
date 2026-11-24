/**
 * Assembles the contextual preamble for a diagnosis prompt —
 * Phase 2 spec, Module 01: "Model prompt includes: plant part photographed,
 * plantation district, current month (seasonal context), recent weather."
 *
 * Separated from diagnosis.service.js so the two concerns stay apart: this
 * module decides *what the model is told*, that one decides *how it's asked*.
 * It is also the only place that reaches for weather, so a scan's blast
 * radius when OpenWeather is down is exactly one function.
 */

import { todayIST } from '../utils/dates.js';
import { seasonalContext } from '../utils/season.js';
import { getDistrictWeather, describeWeather } from './weather.service.js';
import { formatAcres } from './diagnosis.service.js';

/** Plant parts the planter can tag a photo with. */
export const PLANT_PARTS = ['leaf', 'stem', 'capsule', 'rhizome', 'whole plant'];

/**
 * Where to look on each part, **once the subject is confirmed to be
 * cardamom**. Knowing the part removes a whole class of error — rhizome rot
 * and capsule rot present similarly in close-up, and the part is the
 * discriminator.
 *
 * These describe what to examine, never which diseases to expect. An earlier
 * version listed candidate diseases per part ("Leaf symptoms point to blight,
 * katte, thrips..."), which is the same answer-key problem as the seasonal
 * disease list: it tells the model what to pick instead of what to look at.
 *
 * These are phrased as conditionals on purpose. An earlier version stated the
 * part as fact ("Plant part photographed: stem"), and the model accepted the
 * label over its own eyes: a photograph of a lichen-covered tree trunk came
 * back as a healthy cardamom stem at 85% confidence. A tag the planter chose
 * before taking the photo is a hint, never evidence.
 */
const PART_HINTS = {
  leaf: 'On a leaf, read where the damage starts and how it spreads: margins and tips inward, or discrete spots in the blade that later merge; whether lesions have defined edges; whether yellowing follows the veins or lies between them.',
  stem: 'On a pseudostem, read the base and the sheaths: softness or water-soaking at ground level, discolouration moving upward, splitting, holes or frass.',
  capsule: 'On a capsule, read the surface and the stalk attachment: water-soaked or sunken lesions, splitting, surface scarring, boreholes, and whether the stalk end is affected first.',
  rhizome: 'On a rhizome, read firmness and colour at the root zone: softening, dark or water-soaked tissue, smell, insect tunnelling, and whether the soil around it is waterlogged.',
  'whole plant': 'On a whole-plant view, read the distribution: scattered individual plants suggests something soil-borne or systemic, while uniform symptoms across the block suggests nutrition, water or weather.',
};


/**
 * @typedef {object} DiagnosisContext
 * @property {string} promptBlock  Ready to append to the user message.
 * @property {object} snapshot     What we told the model, stored on the scan
 *   for audit and as future fine-tuning data (spec: raw_response + KB).
 */

/**
 * Build the context block for one scan.
 *
 * @param {object} args
 * @param {string}  args.district
 * @param {string|null} [args.plantPart]
 * @param {number|null} [args.areaAcres]
 * @param {string|null} [args.areaLabel]
 * @param {Date} [args.now]
 * @returns {Promise<DiagnosisContext>}
 */
export async function buildDiagnosisContext({
  district,
  plantPart = null,
  areaAcres = null,
  areaLabel = null,
  now = new Date(),
}) {
  const istDay = todayIST(now);
  const season = seasonalContext(istDay);

  // Never lets a weather problem reach the caller.
  const snapshotDoc = await getDistrictWeather(district).catch(() => null);
  const weatherLine = describeWeather(snapshotDoc);

  const part = PLANT_PARTS.includes(plantPart) ? plantPart : null;

  // Conditions, never disease names. Handing the model a list of diseases
  // that are "likely this month" turned out to be an answer key: the same
  // photograph came back as leaf blight in November and Chenthal in
  // February. Physical conditions let it reason; a name list lets it guess.
  const lines = [
    `Location: ${district} district, Kerala (Western Ghats cardamom belt).`,
    `Date: ${season.month} — ${season.season}, typically ${season.rainfall}.`,
    `Growing conditions now: ${season.conditions}.`,
    `Crop stage: ${season.harvest}.`,
  ];

  if (weatherLine) {
    lines.push(`Recent weather: ${weatherLine}.`);
  } else {
    lines.push('Recent weather: unavailable — rely on the seasonal norm above.');
  }

  if (part) {
    lines.push(
      `The planter tagged this photo as: ${part}. That is their label, chosen ` +
        'before taking the picture — check it against the image rather than ' +
        `assuming it. If it does hold: ${PART_HINTS[part]}`,
    );
  } else {
    lines.push(
      'The planter did not tag a plant part — work out what you are looking ' +
        'at from the image itself.',
    );
  }

  lines.push(
    areaAcres > 0
      ? `Area to size doses for: ${areaLabel ?? 'the estate'} — ${formatAcres(areaAcres)}.`
      : 'Area unknown — leave doseForArea empty.',
  );

  return {
    promptBlock: lines.join('\n'),
    snapshot: {
      district,
      plantPart: part,
      month: season.month,
      season: season.season,
      // Recorded for analysis only — deliberately not sent to the model.
      seasonalPressureNotSent: season.pressure,
      conditions: season.conditions,
      weather: weatherLine,
      weatherFetchedAt: snapshotDoc?.fetchedAt ?? null,
      areaAcres: areaAcres > 0 ? areaAcres : null,
    },
  };
}
