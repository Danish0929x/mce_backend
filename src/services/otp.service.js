import crypto from 'node:crypto';
import twilio from 'twilio';
import { env, isDev } from '../config/env.js';

/**
 * Send-and-verify OTP service. Two providers behind one interface so the
 * rest of the app never knows whether the code came from Twilio or a dev
 * console log.
 *
 * Switch by env: OTP_PROVIDER=dev | twilio
 */

/**
 * @typedef {object} OtpProvider
 * @property {(phoneE164: string) => Promise<{ status: string }>} sendCode
 * @property {(phoneE164: string, code: string) => Promise<{ valid: boolean }>} verifyCode
 */

// ---------- dev provider: in-memory + console log ----------

/** @type {Map<string, { code: string, expiresAt: number }>} */
const devStore = new Map();

/** @type {OtpProvider} */
const devProvider = {
  async sendCode(phoneE164) {
    const code = generateNumericCode(env.otp.codeLength);
    const expiresAt = Date.now() + env.otp.ttlSeconds * 1000;
    devStore.set(phoneE164, { code, expiresAt });
    // eslint-disable-next-line no-console
    console.log(
      `\x1b[33m[otp:dev]\x1b[0m generated for ••••${phoneE164.slice(-4)}: \x1b[1m${code}\x1b[0m  (expires in ${env.otp.ttlSeconds}s)`,
    );
    // Handed back so a dev build can show it on screen — Twilio isn't set up
    // locally and reading the server console on every sign-in is friction.
    // sendOtp() decides whether it's safe to expose; see the guard there.
    return { status: 'pending', devCode: code };
  },

  async verifyCode(phoneE164, code) {
    const entry = devStore.get(phoneE164);
    if (!entry) return { valid: false };
    if (entry.expiresAt < Date.now()) {
      devStore.delete(phoneE164);
      return { valid: false };
    }
    if (entry.code !== code) return { valid: false };
    devStore.delete(phoneE164);
    return { valid: true };
  },
};

// ---------- twilio provider: Twilio Verify API ----------

let _twilioClient = null;
function twilioClient() {
  _twilioClient ??= twilio(env.twilio.accountSid, env.twilio.authToken);
  return _twilioClient;
}

/** @type {OtpProvider} */
const twilioProvider = {
  async sendCode(phoneE164) {
    const v = await twilioClient()
      .verify.v2.services(env.twilio.verifyServiceSid)
      .verifications.create({ to: phoneE164, channel: 'sms' });
    return { status: v.status };
  },

  async verifyCode(phoneE164, code) {
    try {
      const check = await twilioClient()
        .verify.v2.services(env.twilio.verifyServiceSid)
        .verificationChecks.create({ to: phoneE164, code });
      return { valid: check.status === 'approved' };
    } catch (err) {
      // Twilio throws 404 when no pending verification exists. Treat as invalid.
      if (err?.status === 404) return { valid: false };
      throw err;
    }
  },
};

// ---------- test phone bypass ----------

/**
 * Reviewer / QA bypass — when env.otp.testPhone is configured, requests for
 * that exact number short-circuit (no SMS sent, no console code) and the
 * matching env.otp.testOtp value is the only one that verifies. Useful for
 * handing the app to a tester without paying for Twilio. Disabled by default.
 */
function isTestPhone(phoneE164) {
  if (!env.otp.testOtp) return false;
  // Group-testing mode — any valid phone accepts the master OTP.
  if (env.otp.acceptAnyPhone) return true;
  // Single-phone reviewer bypass.
  return env.otp.testPhone && phoneE164 === env.otp.testPhone;
}

// ---------- selector + helpers ----------

const provider = env.otp.provider === 'twilio' ? twilioProvider : devProvider;

/**
 * May the OTP be returned in the HTTP response?
 *
 * Only when **both** hold:
 *   - the dev provider is active (no real SMS is being sent anyway), and
 *   - NODE_ENV is not 'production'.
 *
 * Returning a one-time code over the same channel that asks for it defeats
 * the point of having one, so this must never be true on a deployed server.
 * Two independent conditions rather than one, so flipping a single env var
 * by accident cannot expose it.
 */
function mayRevealCode() {
  return env.otp.provider === 'dev' && isDev;
}

export async function sendOtp(phoneE164) {
  if (!isValidIndianE164(phoneE164)) {
    const err = new Error('Phone must be in +91XXXXXXXXXX format');
    err.status = 400;
    err.code = 'invalid_phone';
    throw err;
  }
  if (isTestPhone(phoneE164)) {
    // eslint-disable-next-line no-console
    // No phone number in logs (brief §10.3: no PII in logs).
    console.log('\x1b[36m[otp:test]\x1b[0m bypass — accept TEST_OTP');
    return {
      status: 'pending',
      ...(mayRevealCode() ? { devCode: env.otp.testOtp } : {}),
    };
  }
  const result = await provider.sendCode(phoneE164);
  // Strip the code unless this build is allowed to show it.
  if (!mayRevealCode()) {
    const { devCode: _dropped, ...safe } = result;
    return safe;
  }
  return result;
}

export async function verifyOtp(phoneE164, code) {
  if (!/^\d+$/.test(code) || code.length !== env.otp.codeLength) {
    return { valid: false };
  }
  if (isTestPhone(phoneE164)) {
    return { valid: code === env.otp.testOtp };
  }
  return provider.verifyCode(phoneE164, code);
}

export const currentOtpProvider = env.otp.provider;

function generateNumericCode(length) {
  const max = 10 ** length;
  // crypto for unbiased random; pad with leading zeros.
  return String(crypto.randomInt(0, max)).padStart(length, '0');
}

function isValidIndianE164(phone) {
  return /^\+91\d{10}$/.test(phone);
}
