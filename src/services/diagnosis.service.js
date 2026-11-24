/**
 * AI crop diagnosis service — brief §6.1.
 *
 * Two providers behind one interface so the rest of the app never knows
 * whether the diagnosis came from Claude vision or a canned mock response.
 *
 * Switch via env: DIAGNOSIS_PROVIDER=mock | claude
 *
 * The Claude provider uses the Anthropic Messages API with **forced tool
 * use** to guarantee structured JSON output — no flaky string parsing.
 * Model defaults to Haiku 4.5 (cheap + good enough for cardamom disease
 * patterns); override with ANTHROPIC_DIAGNOSIS_MODEL.
 */

import Anthropic from '@anthropic-ai/sdk';
import { env } from '../config/env.js';

// ---------- shared types ----------

/**
 * @typedef {object} DiagnosisResult
 * @property {string} topDiagnosis
 * @property {string} symptoms              visual evidence seen in the photo
 * @property {number} confidence            0..1
 * @property {'mild'|'moderate'|'severe'|'unknown'} severity
 * @property {boolean} isHealthy
 * @property {Array<{name: string, confidence: number}>} alternatives
 * @property {{summary: string, products: string[], doseringPerAcre: string, doseForArea: string, schedule: string, safetyPrecautions: string, reEntryInterval: string}} treatment
 *   doseForArea — total quantity for the scanned area (whole estate, or the
 *   plot when one was picked). '' when there's nothing to apply.
 * @property {number|null} areaAcres        acreage doseForArea was sized for
 * @property {boolean|null} doseAgreed      did the model's own total match ours
 * @property {string} advice               planter-friendly paragraph
 * @property {string} provider
 * @property {string} modelUsed
 * @property {object|null} rawResponse
 * @property {number} latencyMs
 */

// ---------- mock provider ----------

/** @type {DiagnosisResult[]} */
const MOCK_RESPONSES = [
  {
    topDiagnosis: 'Azhukal / capsule rot (Phytophthora meadii)',
    symptoms:
      'Water-soaked brown lesions on the capsule surface spreading from the ' +
      'stalk end, with the skin split in two places and a faint white fungal ' +
      'bloom along the crack.',
    confidence: 0.82,
    severity: 'moderate',
    isHealthy: false,
    alternatives: [
      { name: 'Rhizome rot (Pythium)', confidence: 0.11 },
      { name: 'Healthy with sun scorch', confidence: 0.07 },
    ],
    treatment: {
      summary:
        'Apply copper-based fungicide as a soil drench within 3 days. Improve drainage around affected plants.',
      products: ['Copper oxychloride 50% WP', 'Bordeaux mixture 1%'],
      doseringPerAcre: '1.5 kg copper oxychloride in 400 L water',
      schedule: 'Spray now, repeat in 10–14 days through monsoon.',
      safetyPrecautions:
        'Wear gloves, a mask and full sleeves while mixing and spraying. Do ' +
        'not spray into wind. Wash hands and clothes afterwards. Keep the ' +
        'leftover mix away from streams and bury empty containers — do not ' +
        'reuse them.',
      reEntryInterval:
        'Re-entry after 24 hours once the foliage is dry. Do not harvest ' +
        'capsules for 15 days after spraying.',
    },
    advice:
      'The capsules show typical Phytophthora rot — water-soaked lesions turning brown. Common in your area during early monsoon. Acting now prevents spread to neighbouring plants. Make sure water doesn\'t pool around the rhizomes.',
  },
  {
    topDiagnosis: 'Healthy',
    symptoms:
      'Even deep-green leaf blade with no spots, streaks or marginal ' +
      'browning. Veins clear, tip intact, no insect scarring on the surface.',
    confidence: 0.94,
    severity: 'unknown',
    isHealthy: true,
    alternatives: [
      { name: 'Mild nitrogen deficiency', confidence: 0.04 },
      { name: 'Early thrips damage', confidence: 0.02 },
    ],
    treatment: {
      summary: 'No treatment needed.',
      products: [],
      doseringPerAcre: '',
      schedule: '',
      safetyPrecautions: '',
      reEntryInterval: '',
    },
    advice:
      'The leaf looks healthy — good colour, no spots or curling. Keep up your current fertilizer and watering routine. Re-scan if you notice any change.',
  },
  {
    topDiagnosis: 'Leaf blight (Colletotrichum gloeosporioides)',
    symptoms:
      'Small tan spots with dark brown margins scattered across the upper ' +
      'leaf surface, a few merging into larger patches near the midrib. No ' +
      'yellowing between the spots.',
    confidence: 0.76,
    severity: 'mild',
    isHealthy: false,
    alternatives: [
      { name: 'Cercospora leaf spot', confidence: 0.18 },
      { name: 'Nutritional yellowing', confidence: 0.06 },
    ],
    treatment: {
      summary:
        'Light fungal infection. A foliar spray of Mancozeb will halt spread.',
      products: ['Mancozeb 75% WP'],
      doseringPerAcre: '0.6 kg in 200 L water as foliar spray',
      schedule: 'Spray on a dry morning, repeat after 14 days if needed.',
      safetyPrecautions:
        'Wear gloves and a mask while mixing. Avoid skin contact with the ' +
        'concentrate. Do not eat, drink or smoke while spraying, and wash ' +
        'thoroughly afterwards.',
      reEntryInterval:
        'Re-entry after 12 hours. Do not harvest capsules for 21 days after ' +
        'spraying Mancozeb.',
    },
    advice:
      'Early-stage leaf blight. Caught soon enough that one spray should clear it. Avoid spraying right before rain.',
  },
];

/**
 * Did the model decline to diagnose?
 *
 * "Not a cardamom plant" and "Image unclear" are refusals, not advice — the
 * planter learned nothing about their crop. Charging a scan for one is
 * charging for a blank page, and it got worse once the model started
 * refusing properly: three bad photos could cost three of five free scans.
 */
export function isNonDiagnosis(topDiagnosis) {
  return /^\s*(not a cardamom|image unclear|unclear)/i.test(topDiagnosis ?? '');
}

/** "1,500" style grouping for scaled quantities; 1 decimal below 10. */
function formatQty(n) {
  const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return rounded.toLocaleString('en-IN');
}

/** "10 acres" / "1 acre" / "2.5 acres". */
export function formatAcres(acres) {
  const n = Math.round(acres * 100) / 100;
  return `${n} ${n === 1 ? 'acre' : 'acres'}`;
}

/**
 * Units we recognise as a *quantity* of product or water. Anything else that
 * looks like a number is left alone.
 */
const QTY_UNIT = '(?:kg|kgs|g|gm|gms|gram|grams|l|lit|litre|litres|liter|liters|ml)';

/**
 * A number that is a concentration rather than a quantity: "2 ml per litre",
 * "3 g/L". These describe the strength of the mix and must not change when
 * the area changes — 10 acres of spray is still 2 ml per litre.
 */
const PER_UNIT_SUFFIX = new RegExp(`^\\s*(?:/|per\\b)\\s*\\d*\\s*${QTY_UNIT}\\b`, 'i');

/**
 * Scale a per-acre dose to [acres].
 *
 * Multiplies only numbers that are immediately followed by a quantity unit,
 * so the things that must not scale are left untouched:
 *
 *   - concentrations    "2 ml per litre"      → unchanged
 *   - percentages       "Bordeaux mixture 1%" → unchanged
 *   - formulation codes "Chlorpyrifos 20EC"   → unchanged (EC is not a unit)
 *   - product strengths "Mancozeb 75% WP"     → unchanged
 *
 * An earlier version multiplied every number it found, which turned
 * "Chlorpyrifos 20EC" into "400EC" and scaled concentrations along with
 * quantities. Whitelisting units is the fix: a number only scales when the
 * text itself says it is an amount.
 *
 * @returns {string} '' when there is nothing sensible to scale
 */
export function scaleDosePerAcre(perAcre, acres) {
  if (!perAcre || !(acres > 0)) return '';
  const re = new RegExp(`(\\d+(?:[.,]\\d+)*)(\\s*)(${QTY_UNIT})\\b`, 'gi');
  return perAcre.replace(re, (match, num, gap, unit, offset, whole) => {
    // "2 ml per litre" — a rate, not an amount.
    if (PER_UNIT_SUFFIX.test(whole.slice(offset + match.length))) return match;
    const n = Number(String(num).replace(/,/g, ''));
    if (!Number.isFinite(n)) return match;
    return `${formatQty(n * acres)}${gap}${unit}`;
  }).replace(PER_ACRE_LABEL, ' in total');
}

/**
 * "5 kg/acre" and "5 kg per acre" become "100 kg/acre" once scaled, which
 * reads as a per-acre rate twenty times too high — a planter following it
 * would apply twenty times the intended amount. Once the number is a total,
 * the per-acre label has to go with it.
 */
const PER_ACRE_LABEL = /\s*(?:\/|per\s+)ac(?:re|res)?\b/gi;

/**
 * Does the model's own total agree with the arithmetic?
 *
 * Models are unreliable at multiplication, and a wrong pesticide quantity is
 * the most consequential error this product can make. So we never trust the
 * model's total: we recompute it from its own per-acre rate and use ours.
 * This returns whether the two agreed, which is worth recording — persistent
 * disagreement means the per-acre rate itself may be unreliable.
 *
 * Compares the numbers only; wording differences are irrelevant.
 */
export function doseTotalsAgree(modelTotal, computedTotal) {
  if (!modelTotal || !computedTotal) return null;
  const nums = (s) =>
    (String(s).match(/\d+(?:[.,]\d+)*/g) ?? [])
      .map((n) => Number(n.replace(/,/g, '')))
      .filter(Number.isFinite);
  const a = nums(modelTotal);
  const b = nums(computedTotal);
  if (a.length === 0 || a.length !== b.length) return false;
  // 1% tolerance absorbs rounding ("1,500" vs "1500.2").
  return a.every((v, i) => Math.abs(v - b[i]) <= Math.max(0.01, b[i] * 0.01));
}

let mockIndex = 0;
function pickMockResponse() {
  // Deterministic rotation — easier to test than random.
  const r = MOCK_RESPONSES[mockIndex % MOCK_RESPONSES.length];
  mockIndex++;
  return r;
}

export async function mockDiagnose({ areaAcres = null } = {}) {
  // Simulate network latency.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const base = pickMockResponse();
  return {
    ...base,
    treatment: {
      ...base.treatment,
      doseForArea: scaleDosePerAcre(base.treatment.doseringPerAcre, areaAcres),
    },
    doseAgreed: null,
    areaAcres,
    provider: 'mock',
    modelUsed: 'mock-cardamom-v1',
    rawResponse: { mock: true, note: 'canned response for testing' },
    latencyMs: 400,
  };
}

// ---------- Claude (Anthropic) provider ----------

let _anthropic = null;
function anthropicClient() {
  _anthropic ??= new Anthropic({ apiKey: env.anthropic.apiKey });
  return _anthropic;
}

/**
 * Forced tool spec — guarantees the model returns our exact schema rather
 * than free-text JSON we'd have to parse and validate.
 */
export const DIAGNOSIS_TOOL = {
  name: 'record_cardamom_diagnosis',
  description:
    'Record the diagnosis findings for a cardamom plant from the image provided.',
  input_schema: {
    type: 'object',
    properties: {
      // symptoms is first on purpose: the model fills fields in order, so
      // describing the image before naming a disease makes the name follow
      // the evidence instead of the other way round.
      symptoms: {
        type: 'string',
        description:
          'The visual evidence that led to this diagnosis — what is actually ' +
          'visible in the photograph, in one or two sentences. Describe marks, ' +
          'colour, texture and distribution (e.g. "Water-soaked brown lesions ' +
          'on the capsule surface, spreading from the stalk end; skin split in ' +
          'two places"). Never restate the disease name here, and never claim a ' +
          'symptom you cannot see in this image.',
      },
      topDiagnosis: {
        type: 'string',
        description:
          'The most likely disease or condition, chosen to fit the symptoms ' +
          'you just described (e.g. "Azhukal / capsule rot (Phytophthora ' +
          'meadii)", "Healthy"). Use canonical Kerala cardamom names.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: 'Confidence in the top diagnosis (0..1).',
      },
      severity: {
        type: 'string',
        enum: ['mild', 'moderate', 'severe', 'unknown'],
      },
      isHealthy: {
        type: 'boolean',
        description:
          'True only when the subject is confirmed to be a cardamom plant ' +
          'AND it looks fully healthy. Must be false whenever you cannot ' +
          'confirm the plant is cardamom — the app shows this to the planter ' +
          'as an all-clear on their crop.',
      },
      alternatives: {
        type: 'array',
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['name', 'confidence'],
        },
        description: 'Up to 4 differential diagnoses with confidence.',
      },
      treatment: {
        type: 'object',
        properties: {
          summary: {
            type: 'string',
            description: 'One- or two-sentence treatment overview.',
          },
          products: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete product names (chemical or organic).',
          },
          doseringPerAcre: {
            type: 'string',
            description: 'Application rate per acre with units.',
          },
          doseForArea: {
            type: 'string',
            description:
              'Total quantity for the planter\'s area given in the prompt (per-acre rate × acres), with units and water volume, e.g. "15 kg copper oxychloride in 4,000 L water". Empty string if no treatment is needed.',
          },
          schedule: {
            type: 'string',
            description: 'When and how often to apply.',
          },
          safetyPrecautions: {
            type: 'string',
            description:
              'Protective equipment and handling precautions for these ' +
              'products, written for someone spraying with a knapsack in a ' +
              'humid plantation: what to wear, what to avoid, what to do with ' +
              'leftover mix and empty containers. Empty string only when no ' +
              'product is being applied.',
          },
          reEntryInterval: {
            type: 'string',
            description:
              'How long people and animals must stay out of the treated area, ' +
              'and the pre-harvest interval before capsules may be picked — ' +
              'e.g. "Re-entry after 24 hours. Do not harvest for 21 days." ' +
              'This is a legal requirement for pesticide use, so never guess: ' +
              'if the interval for a product is not something you are sure of, ' +
              'say so and tell the planter to check the label. Empty string ' +
              'only when no product is being applied.',
          },
        },
        required: [
          'summary',
          'products',
          'doseringPerAcre',
          'doseForArea',
          'schedule',
          'safetyPrecautions',
          'reEntryInterval',
        ],
      },
      advice: {
        type: 'string',
        description:
          'Plain-English (2–4 sentences) advice for a Kerala cardamom planter — friendly, practical, no jargon.',
      },
    },
    required: [
      'symptoms',
      'topDiagnosis',
      'confidence',
      'severity',
      'isHealthy',
      'alternatives',
      'treatment',
      'advice',
    ],
  },
};

const SYSTEM_PROMPT = `You are a cardamom-specific plant pathology expert advising small-holding planters in the cardamom belt of Kerala, India (Idukki, Wayanad and neighbouring districts of the Western Ghats).

FIRST, BEFORE ANY DIAGNOSIS: confirm the photograph actually shows a cardamom plant.

Cardamom (Elettaria cardamomum) is a herbaceous perennial, not a tree. Its "stem" is a pseudostem of tightly rolled leaf sheaths — smooth, green to pale green, soft. Leaves are long, lance-shaped, smooth-edged, with parallel veins. Capsules are small, ribbed, three-sided, green when fresh, borne on panicles at ground level. Rhizomes are fleshy and pale.

Things that are NOT cardamom, however the photo is labelled: woody bark, tree trunks, lichen- or moss-covered trunks, broad net-veined leaves, grasses, fruit, cooked food, soil alone, people, animals, buildings, screens. A tree trunk is not a cardamom stem no matter what plant part the planter selected.

If you cannot confirm the subject is cardamom, set topDiagnosis to "Not a cardamom plant" (or "Image unclear" when it is simply too blurred, dark or close to read), give it low confidence, set isHealthy to false, and use advice to tell the planter plainly what you see and how to retake the photo. Never set isHealthy to true for a subject you have not confirmed is cardamom — that reads to the planter as an all-clear on their crop.

Only once the subject is confirmed cardamom, proceed:

Each request gives you a photograph plus a CONTEXT block: the estate's district, the month and its seasonal norms, recent weather, and which plant part was photographed. The context is evidence, not decoration — use it:

- Weather drives fungal disease. Sustained rain and high humidity raise the probability of azhukal (Phytophthora) capsule rot and rhizome rot sharply. A dry spell lowers it and raises thrips, mites, shoot/capsule borer and sun scorch instead.
- The plant part the planter tagged is their guess, made before the photo was taken. Use it to narrow candidates only after the image agrees with it; if the picture shows something else, say so rather than diagnosing the label. Do not return a capsule disease for a rhizome photo.
- The CONTEXT gives you growing conditions — rain, humidity, light, soil moisture — never a list of diseases. Reason from the conditions to a risk the way an agronomist would ("leaves have been wet for days, so fungal infection is plausible"), and then check whether the image actually shows it. If it does not, do not diagnose it.
- The month tells you what is plausible, not what is true. If the image clearly shows an off-season problem, diagnose it anyway and say in your advice that it is unusual for the season.
- A specific failure to avoid: the same photograph must not get a different diagnosis in February than in July. The season changes which causes are *likely*, never what is *visible*. Before you commit to a diagnosis, ask yourself whether you would still choose it if the date were six months different. If the honest answer is no, your confidence is too high and the alternatives are mis-ranked.
- Visual evidence always outranks context. Context breaks ties between visually similar candidates; it never overrides what you can see.

Cardamom conditions in scope:
- Azhukal / capsule rot (Phytophthora meadii, P. nicotianae)
- Rhizome rot (Pythium vexans, Fusarium oxysporum)
- Katte / cardamom mosaic virus
- Chenthal disease
- Kokke kandu (bushy dwarf virus)
- Leaf blight / leaf spot (Colletotrichum gloeosporioides, Cercospora)
- Cardamom thrips (Sciothrips cardamomi)
- Shoot/capsule/panicle borer (Conogethes punctiferalis)
- Root grub (Basilepta fulvicorne)
- Nutrient deficiency (N, P, K, Mg, B, Zn)
- Sun scorch, waterlogging, cold injury, mechanical damage

Always call the record_cardamom_diagnosis tool. Rules for its fields:
- Name diseases the way a Kerala planter and an agriculture officer both would: local name first where one exists, binomial in brackets — "Azhukal / capsule rot (Phytophthora meadii)".
- Recommend only products actually sold in Kerala: Bordeaux mixture, copper oxychloride, Mancozeb, Metalaxyl-MZ, Potassium phosphonate, Trichoderma, neem cake, Quinalphos, Chlorpyrifos.
- Doses must be realistic per-acre quantities, in the units the product is actually sold and measured in:
  - Wettable powders and granules (copper oxychloride 50% WP, Mancozeb 75% WP, Bordeaux components, neem cake, Trichoderma) are measured by WEIGHT — g or kg. Never give them in ml.
  - Emulsifiable concentrates and liquids (Chlorpyrifos 20EC, Quinalphos 25EC, Nano Urea) are measured by VOLUME — ml or litres.
- Keep strength and quantity consistent with each other. For a spray, the standard Kerala rates are roughly: copper oxychloride 0.2–0.3% (2–3 g per litre, i.e. 2–3 kg in 1,000 L), Mancozeb 0.2% (2 g per litre), Bordeaux mixture 0.5–1%. If you state a percentage, the quantity you give must work out to that percentage in the stated water volume. A figure like "1.5% (20 ml in 1,000 L)" is wrong twice over — wrong units for a powder, and 20 ml in 1,000 L is 0.002%, not 1.5%.
- doseringPerAcre is the rate for ONE acre. Put the total for the whole area in doseForArea. Do not bury a concentration ("2 ml per litre") in doseringPerAcre as if it were a per-acre amount — give the amount of product and the water volume for one acre, and state the concentration separately in the summary if it matters.
- Not every problem is a pathogen, and you are biased toward finding one because you are framed as a pathologist. Cardamom is damaged at least as often by its growing conditions: waterlogging and poor drainage, too much sun after shade trees are cut, drought stress, salt or fertiliser burn, wind and mechanical damage, cold at altitude. Learn the patterns that distinguish them — damage that starts at leaf tips and margins and moves inward is usually water, salt or scorch stress, not a fungus, which more often gives discrete spots with defined edges that later merge. When the picture fits an environmental cause, say so and rank it accordingly, even first. Recommending a spray for a drainage problem costs the planter money, exposes them and their workers to chemicals for nothing, and leaves the real cause untouched.
- symptoms is the evidence, not the conclusion: describe only what is visible in this photograph — marks, colour, texture, where they sit and how they are spread. A planter who disagrees with your diagnosis should be able to check your reasoning against the plant in front of them. Never put the disease name here, and never list a symptom the image does not show.
- safetyPrecautions and reEntryInterval are not optional for any product you recommend. Write them for someone spraying with a knapsack in a humid plantation, often barefoot. Re-entry and pre-harvest intervals are legally binding in India — if you are not certain of the interval for a product, say plainly that the planter must check the label rather than inventing a number. Leave both empty only when nothing is being applied.
- Advice is 2–4 sentences for a working farmer, not a scientist. Warm, direct, practical. Where the weather or season shaped your conclusion, say so in plain words ("after this much rain, rot spreads fast").

Reminder, because it is the easiest mistake to make: a confident diagnosis of the wrong plant is worse than admitting you cannot tell. If the subject is not clearly cardamom, say so.`;

async function claudeDiagnose({
  imageBase64,
  mime,
  areaAcres = null,
  areaLabel = null,
  contextBlock = null,
  extraImages = [],
}) {
  const t0 = Date.now();
  const model = env.anthropic.diagnosisModel;
  const client = anthropicClient();

  const response = await client.messages.create({
    model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [DIAGNOSIS_TOOL],
    tool_choice: { type: 'tool', name: 'record_cardamom_diagnosis' },
    messages: [
      {
        role: 'user',
        content: [
          // All photos go in a single call so the model can compare angles,
          // rather than diagnosing each one in isolation.
          ...[{ data: imageBase64, mime }, ...extraImages].map((img) => ({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mime ?? 'image/jpeg',
              data: img.data,
            },
          })),
          {
            type: 'text',
            text: [
              'CONTEXT',
              contextBlock ??
                (areaAcres > 0
                  ? `Area to size doses for: ${areaLabel ?? 'the estate'} — ${formatAcres(areaAcres)}.`
                  : 'Area unknown — leave doseForArea empty.'),
              '',
              extraImages.length > 0
                ? `These ${extraImages.length + 1} photographs show the same ` +
                  'problem from different angles. Read them together: a ' +
                  'symptom confirmed across angles is stronger evidence than ' +
                  'one visible in a single shot, and a detail clear in only ' +
                  'one photo is still evidence. Diagnose the plant, not each ' +
                  'photo separately.'
                : 'Diagnose this cardamom plant image using the context above.',
              'Describe what is actually visible first, then name the cause ' +
                'that best fits what you described.',
              'Call record_cardamom_diagnosis with your findings.',
            ].join('\n'),
          },
        ],
      },
    ],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse || toolUse.name !== 'record_cardamom_diagnosis') {
    throw new Error('Model did not call the diagnosis tool.');
  }
  const data = toolUse.input;
  const latencyMs = Date.now() - t0;

  const computedTotal = scaleDosePerAcre(
    data.treatment?.doseringPerAcre,
    areaAcres,
  );
  const doseAgreed = doseTotalsAgree(
    data.treatment?.doseForArea,
    computedTotal,
  );
  if (doseAgreed === false) {
    // eslint-disable-next-line no-console
    console.warn(
      `[diagnosis] dose mismatch — model said "${data.treatment?.doseForArea}", ` +
        `computed "${computedTotal}" from "${data.treatment?.doseringPerAcre}" ` +
        `× ${areaAcres} acres. Using the computed value.`,
    );
  }

  return {
    topDiagnosis: data.topDiagnosis,
    symptoms: data.symptoms ?? '',
    confidence: data.confidence,
    severity: data.severity,
    isHealthy: data.isHealthy,
    alternatives: data.alternatives ?? [],
    treatment: {
      ...data.treatment,
      // Never trust the model's multiplication. We recompute the total from
      // its own per-acre rate and use ours; a wrong pesticide quantity is the
      // most consequential error this product can make, and arithmetic is the
      // one part of this we can do exactly.
      doseForArea: computedTotal || data.treatment?.doseForArea || '',
      safetyPrecautions: data.treatment?.safetyPrecautions ?? '',
      reEntryInterval: data.treatment?.reEntryInterval ?? '',
    },
    /**
     * Whether the model's own total matched ours. null when there was
     * nothing to compare. Persistent `false` means the per-acre rate itself
     * deserves scrutiny, so it is recorded rather than silently discarded.
     */
    doseAgreed,
    areaAcres: areaAcres > 0 ? areaAcres : null,
    advice: data.advice,
    photoCount: 1 + extraImages.length,
    provider: 'claude',
    modelUsed: model,
    rawResponse: data,
    latencyMs,
  };
}

// ---------- selector ----------

/**
 * Run a diagnosis using the configured provider.
 * @param {object} args
 * @param {string} args.imageBase64
 * @param {string} args.mime
 * @param {number|null} [args.areaAcres]  acreage to size doseForArea for
 * @param {string|null} [args.areaLabel]  e.g. 'plot "North slope"'
 * @param {string|null} [args.contextBlock]  district / season / weather /
 *   plant-part preamble from buildDiagnosisContext()
 * @param {Array<{data: string, mime: string}>} [args.extraImages]  photos 2–3
 *   of a multi-photo scan (Pro)
 * @returns {Promise<DiagnosisResult>}
 */
export async function diagnose(args) {
  if (env.diagnosis.provider === 'claude') {
    if (!env.anthropic.apiKey) {
      const err = new Error(
        'ANTHROPIC_API_KEY is missing. Set DIAGNOSIS_PROVIDER=mock or add a key.',
      );
      err.status = 500;
      err.code = 'no_api_key';
      throw err;
    }
    return claudeDiagnose(args);
  }
  return mockDiagnose(args);
}

export const currentDiagnosisProvider = env.diagnosis.provider;
