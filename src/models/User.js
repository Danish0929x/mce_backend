import mongoose from 'mongoose';

const { Schema } = mongoose;

/**
 * Planter account.
 *
 * One user, one extended profile. Phone is the unique identifier (OTP flow).
 * Plan transitions: free → pro_trial (auto on signup, 30 days) → pro.
 *
 * @see Developer brief §4.1
 */
const userSchema = new Schema(
  {
    fullName: { type: String, required: true, trim: true },
    phone: {
      type: String,
      required: true,
      unique: true,
      // E.164 +91XXXXXXXXXX
      match: /^\+91\d{10}$/,
      index: true,
    },
    plan: {
      type: String,
      enum: ['free', 'pro_trial', 'pro'],
      default: 'pro_trial',
    },
    trialEndsAt: { type: Date },
    /**
     * 'admin' = internal Griffon staff (brief §3.2). Can override locked wage
     * periods (§7.6 rule 103). Granted only via `npm run set-role` — never
     * through the API.
     */
    role: { type: String, enum: ['planter', 'admin'], default: 'planter' },
    razorpayCustomerId: { type: String, default: null },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

userSchema.statics.startProTrial = function () {
  const d = new Date();
  d.setDate(d.getDate() + 30); // 30-day Pro trial per brief §5.5.3
  return d;
};

userSchema.methods.toPublicJSON = function () {
  return {
    id: this._id.toString(),
    fullName: this.fullName,
    phone: this.phone,
    plan: this.plan,
    role: this.role,
    trialEndsAt: this.trialEndsAt,
    createdAt: this.createdAt,
  };
};

export const User = mongoose.model('User', userSchema);
