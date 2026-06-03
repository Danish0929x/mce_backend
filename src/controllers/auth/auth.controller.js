import { z } from 'zod';
import { User } from '../../models/User.js';
import {
  sendOtp,
  verifyOtp as checkOtpCode,
  currentOtpProvider,
} from '../../services/otp.service.js';
import { issueTokens, verifyRefresh } from '../../services/jwt.service.js';

// ---------- validation schemas ----------

const phoneSchema = z
  .string()
  .regex(/^\+91\d{10}$/, 'Phone must be +91XXXXXXXXXX');

const loginSchema = z.object({
  phone: phoneSchema,
});

const registerSchema = z.object({
  phone: phoneSchema,
  fullName: z.string().trim().min(2).max(120),
});

const verifySchema = z.object({
  phone: phoneSchema,
  code: z.string().regex(/^\d{4,8}$/),
  // Carried forward from the Register screen so we can create the user
  // record on first verification. Optional for the Login flow.
  fullName: z.string().trim().min(2).max(120).optional(),
});

const refreshSchema = z.object({
  refresh: z.string().min(20),
});

// ---------- controllers ----------

// Login — existing planter requests an OTP to sign in.
export async function login(req, res, next) {
  try {
    const { phone } = loginSchema.parse(req.body);
    const result = await sendOtp(phone);
    res.json({
      ok: true,
      provider: currentOtpProvider,
      status: result.status,
    });
  } catch (err) {
    next(toHttpError(err));
  }
}

// Register — new planter requests an OTP. fullName is carried client-side
// into the Verify step so we can create the User on first successful code.
export async function register(req, res, next) {
  try {
    const { phone } = registerSchema.parse(req.body);
    const existing = await User.findOne({ phone });
    if (existing) {
      return res.status(409).json({
        error: 'phone_already_registered',
        message:
          'This number is already registered. Please sign in instead.',
      });
    }
    const result = await sendOtp(phone);
    res.json({
      ok: true,
      provider: currentOtpProvider,
      status: result.status,
    });
  } catch (err) {
    next(toHttpError(err));
  }
}

// Verify — confirm the OTP, create the User if this is a Register flow,
// update lastLoginAt either way, and return a JWT pair.
export async function verify(req, res, next) {
  try {
    const { phone, code, fullName } = verifySchema.parse(req.body);

    const { valid } = await checkOtpCode(phone, code);
    if (!valid) {
      return res.status(401).json({
        error: 'invalid_code',
        message: 'That code is incorrect or expired. Try again.',
      });
    }

    let user = await User.findOne({ phone });
    let isNewUser = false;
    if (!user) {
      if (!fullName) {
        return res.status(400).json({
          error: 'name_required',
          message:
            'No account exists for this number. Provide fullName to register.',
        });
      }
      user = await User.create({
        fullName,
        phone,
        plan: 'pro_trial',
        trialEndsAt: User.startProTrial(),
      });
      isNewUser = true;
    }
    user.lastLoginAt = new Date();
    await user.save();

    const tokens = issueTokens(user);
    res.json({
      ok: true,
      isNewUser,
      user: user.toPublicJSON(),
      tokens,
    });
  } catch (err) {
    next(toHttpError(err));
  }
}

// Me — return the currently signed-in user (auto-login on app launch).
export async function me(req, res, next) {
  try {
    const user = await User.findById(req.user.sub);
    if (!user) {
      return res.status(401).json({ error: 'unknown_user' });
    }
    res.json({ ok: true, user: user.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

// Refresh — trade a refresh token for a fresh access + refresh pair.
export async function refresh(req, res, next) {
  try {
    const { refresh: refreshToken } = refreshSchema.parse(req.body);
    const decoded = verifyRefresh(refreshToken);
    const user = await User.findById(decoded.sub);
    if (!user) {
      return res.status(401).json({ error: 'unknown_user' });
    }
    const tokens = issueTokens(user);
    res.json({ ok: true, tokens });
  } catch (err) {
    next(toHttpError(err));
  }
}

// ---------- shared error mapper ----------

function toHttpError(err) {
  if (err?.name === 'ZodError') {
    const e = new Error(
      err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
    e.status = 400;
    e.code = 'validation_error';
    return e;
  }
  if (err?.name === 'JsonWebTokenError' || err?.name === 'TokenExpiredError') {
    const e = new Error('Invalid or expired token');
    e.status = 401;
    e.code = 'invalid_token';
    return e;
  }
  return err;
}
