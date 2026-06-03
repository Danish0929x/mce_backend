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
 * @property {number} confidence            0..1
 * @property {'mild'|'moderate'|'severe'|'unknown'} severity
 * @property {boolean} isHealthy
 * @property {Array<{name: string, confidence: number}>} alternatives
 * @property {{summary: string, products: string[], doseringPerAcre: string, schedule: string}} treatment
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
    topDiagnosis: 'Phytophthora capsule rot',
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
    },
    advice:
      'The capsules show typical Phytophthora rot — water-soaked lesions turning brown. Common in your area during early monsoon. Acting now prevents spread to neighbouring plants. Make sure water doesn\'t pool around the rhizomes.',
  },
  {
    topDiagnosis: 'Healthy',
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
    },
    advice:
      'The leaf looks healthy — good colour, no spots or curling. Keep up your current fertilizer and watering routine. Re-scan if you notice any change.',
  },
  {
    topDiagnosis: 'Leaf blight (Colletotrichum)',
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
    },
    advice:
      'Early-stage leaf blight. Caught soon enough that one spray should clear it. Avoid spraying right before rain.',
  },
];

let mockIndex = 0;
function pickMockResponse() {
  // Deterministic rotation — easier to test than random.
  const r = MOCK_RESPONSES[mockIndex % MOCK_RESPONSES.length];
  mockIndex++;
  return r;
}

async function mockDiagnose() {
  // Simulate network latency.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const base = pickMockResponse();
  return {
    ...base,
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
const DIAGNOSIS_TOOL = {
  name: 'record_cardamom_diagnosis',
  description:
    'Record the diagnosis findings for a cardamom plant from the image provided.',
  input_schema: {
    type: 'object',
    properties: {
      topDiagnosis: {
        type: 'string',
        description:
          'The most likely disease or condition (e.g. "Phytophthora capsule rot", "Healthy"). Use canonical Kerala cardamom disease names.',
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
        description: 'True only if the plant looks fully healthy.',
      },
      alternatives: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
          required: ['name', 'confidence'],
        },
        description: 'Up to 3 differential diagnoses with confidence.',
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
          schedule: {
            type: 'string',
            description: 'When and how often to apply.',
          },
        },
        required: ['summary', 'products', 'doseringPerAcre', 'schedule'],
      },
      advice: {
        type: 'string',
        description:
          'Plain-English (2–4 sentences) advice for a Kerala cardamom planter — friendly, practical, no jargon.',
      },
    },
    required: [
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

const SYSTEM_PROMPT = `You are a cardamom-specific plant pathology expert advising small-holding planters in the Idukki and Wayanad districts of Kerala, India.

When given a photograph of a cardamom leaf, stem, capsule, or rhizome, identify the most likely disease or condition. Common cardamom problems include:
- Phytophthora capsule rot (azhukal)
- Rhizome rot (Pythium / Fusarium)
- Leaf blight (Colletotrichum, Cercospora)
- Cardamom mosaic virus (kokke kandu / katte disease)
- Thrips, shoot/capsule borer damage
- Nutritional deficiencies (N, Mg, Zn)
- Sun scorch, mechanical damage

Always call the record_cardamom_diagnosis tool with structured findings. Treatment products should be ones actually available in Kerala (Bordeaux mixture, copper oxychloride, Mancozeb, Tricoderma, Neem cake, etc.). Doses should be realistic per-acre quantities. Advice should be warm, practical, and assume the planter is a working farmer — not a scientist.

If the image is not of a cardamom plant or is unclear, set topDiagnosis to "Image unclear" with low confidence and ask the planter (in advice) to retake the photo.`;

async function claudeDiagnose({ imageBase64, mime }) {
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
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: mime,
              data: imageBase64,
            },
          },
          {
            type: 'text',
            text: 'Diagnose this cardamom plant image. Call the recording tool with your findings.',
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

  return {
    topDiagnosis: data.topDiagnosis,
    confidence: data.confidence,
    severity: data.severity,
    isHealthy: data.isHealthy,
    alternatives: data.alternatives ?? [],
    treatment: data.treatment,
    advice: data.advice,
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
  return mockDiagnose();
}

export const currentDiagnosisProvider = env.diagnosis.provider;
