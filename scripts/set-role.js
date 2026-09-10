/**
 * Grant or revoke admin for an existing user.
 *
 *   npm run set-role -- +919876543210 admin
 *   npm run set-role -- +919876543210 planter
 *
 * The user must have signed in at least once so their account exists.
 */
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { User } from '../src/models/User.js';

const [phone, role] = process.argv.slice(2);

if (!/^\+91\d{10}$/.test(phone ?? '') || !['admin', 'planter'].includes(role)) {
  console.error('Usage: npm run set-role -- +91XXXXXXXXXX admin|planter');
  process.exit(1);
}

await connectDb();
try {
  const user = await User.findOneAndUpdate(
    { phone },
    { $set: { role } },
    { new: true },
  );
  if (!user) {
    console.error(`No user with phone ${phone}. Sign in once from the app first.`);
    process.exitCode = 1;
  } else {
    console.log(`${user.fullName} (${user.phone}) is now: ${user.role}`);
  }
} finally {
  await mongoose.disconnect();
}
