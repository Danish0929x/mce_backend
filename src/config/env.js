import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function optional(name, fallback = '') {
  return process.env[name] ?? fallback;
}

const otpProvider = optional('OTP_PROVIDER', 'dev');
if (!['dev', 'twilio'].includes(otpProvider)) {
  throw new Error(
    `OTP_PROVIDER must be one of: dev, twilio. Got "${otpProvider}".`,
  );
}

const diagnosisProvider = optional('DIAGNOSIS_PROVIDER', 'mock');
if (!['mock', 'claude'].includes(diagnosisProvider)) {
  throw new Error(
    `DIAGNOSIS_PROVIDER must be one of: mock, claude. Got "${diagnosisProvider}".`,
  );
}

export const env = {
  nodeEnv: optional('NODE_ENV', 'development'),
  port: Number(optional('PORT', '4000')),

  mongodbUri: required('MONGODB_URI'),

  jwt: {
    secret: required('JWT_SECRET'),
    accessTtl: optional('JWT_ACCESS_TTL', '15m'),
    refreshTtl: optional('JWT_REFRESH_TTL', '30d'),
  },

  otp: {
    /** 'dev' (console log) or 'twilio' (Twilio Verify API). */
    provider: otpProvider,
    /** Length in digits — Twilio Verify supports 4, 6, 8, 10. */
    codeLength: Number(optional('OTP_CODE_LENGTH', '6')),
    /** TTL in seconds for dev provider's in-memory codes. */
    ttlSeconds: Number(optional('OTP_TTL_SECONDS', '300')),
    /**
     * Test phone bypass — when set, this exact phone always accepts TEST_OTP
     * without going through Twilio or the dev store. For QA / reviewer logins
     * while Twilio is unconfigured. Leave both blank in production.
     */
    testPhone: optional('TEST_PHONE'),
    testOtp: optional('TEST_OTP'),
    /**
     * Group testing mode — when 'true' AND TEST_OTP is set, any valid Indian
     * phone number accepts TEST_OTP. Each tester signs into their own account
     * with their own real number. NEVER enable in production.
     */
    acceptAnyPhone: optional('TEST_ACCEPT_ANY_PHONE', 'false') === 'true',
  },

  twilio: {
    accountSid: optional('TWILIO_ACCOUNT_SID'),
    authToken: optional('TWILIO_AUTH_TOKEN'),
    /** Verify Service SID — starts with `VA...`. */
    verifyServiceSid: optional('TWILIO_VERIFY_SERVICE_SID'),
  },

  razorpay: {
    keyId: optional('RAZORPAY_KEY_ID'),
    keySecret: optional('RAZORPAY_KEY_SECRET'),
    planId: optional('RAZORPAY_PLAN_ID'),
  },

  diagnosis: {
    /** 'mock' (canned responses for testing) or 'claude' (Anthropic vision). */
    provider: diagnosisProvider,
    /** Max image bytes accepted on POST /diagnosis/scan. ~3 MB. */
    maxImageBytes: Number(optional('DIAGNOSIS_MAX_IMAGE_BYTES', '3145728')),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY'),
    /** Override at runtime to swap models (e.g. claude-sonnet-4-6). */
    diagnosisModel: optional(
      'ANTHROPIC_DIAGNOSIS_MODEL',
      'claude-haiku-4-5-20251001',
    ),
  },
};

if (env.otp.provider === 'twilio') {
  for (const key of ['accountSid', 'authToken', 'verifyServiceSid']) {
    if (!env.twilio[key]) {
      throw new Error(
        `OTP_PROVIDER=twilio but TWILIO_${key.replace(/([A-Z])/g, '_$1').toUpperCase()} is missing.`,
      );
    }
  }
}

if (env.diagnosis.provider === 'claude' && !env.anthropic.apiKey) {
  throw new Error(
    'DIAGNOSIS_PROVIDER=claude but ANTHROPIC_API_KEY is missing.',
  );
}

export const isDev = env.nodeEnv !== 'production';
