/**
 * One-time migration: shared wage periods → one set per plantation.
 *
 * Wage periods used to be a single shared list. They are now per plantation
 * (brief §5.4.5, §7.3). This copies the current shared list to every
 * plantation that has none yet, then removes the shared rows.
 *
 *   npm run migrate:wage-periods            # dry run — shows what would change
 *   npm run migrate:wage-periods -- --apply # do it
 *
 * Safe to re-run: once the shared rows are gone there is nothing to do.
 * Deploy the new backend at the same time — the old code expects the
 * shared list.
 */
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db.js';
import { Plantation } from '../src/models/Plantation.js';
import { WagePeriod } from '../src/models/WagePeriod.js';

const apply = process.argv.includes('--apply');

await connectDb();
try {
  const col = WagePeriod.collection;
  const shared = await col
    .find({ plantationId: { $in: [null] } }) // matches null and missing
    .sort({ effectiveFrom: 1 })
    .toArray();

  if (shared.length === 0) {
    console.log('No shared wage periods left — nothing to migrate.');
  } else {
    console.log(`Shared wage periods (${shared.length}):`);
    for (const s of shared) {
      console.log(
        `  ${s.label.padEnd(14)} ${s.effectiveFrom.toISOString().slice(0, 10)} → ` +
          `${s.effectiveTo.toISOString().slice(0, 10)}  ` +
          `Basic ${(s.basicPaise / 100).toFixed(2)} + DA ${(s.daPaise / 100).toFixed(2)}`,
      );
    }

    const plantations = await Plantation.find({}, { name: 1 });
    const targets = [];
    for (const p of plantations) {
      const own = await col.countDocuments({ plantationId: p._id });
      if (own === 0) targets.push(p);
      else console.log(`  skip "${p.name}" — already has ${own} period(s)`);
    }
    console.log(
      `\nWill copy ${shared.length} period(s) to ${targets.length} plantation(s), ` +
        `then delete the ${shared.length} shared row(s).`,
    );

    if (!apply) {
      console.log('\nDry run — nothing changed. Re-run with --apply to migrate.');
    } else {
      // The old unique index on seedKey alone would block per-plantation copies.
      const indexes = await col.indexes();
      if (indexes.some((i) => i.name === 'seedKey_1')) {
        await col.dropIndex('seedKey_1');
        console.log('Dropped old index seedKey_1.');
      }

      for (const p of targets) {
        const copies = shared.map(({ _id, ...rest }) => ({
          ...rest,
          plantationId: p._id,
        }));
        await col.insertMany(copies);
        console.log(`  copied to "${p.name}"`);
      }

      const { deletedCount } = await col.deleteMany({
        _id: { $in: shared.map((s) => s._id) },
      });
      console.log(`Deleted ${deletedCount} shared row(s).`);

      await WagePeriod.syncIndexes();
      console.log('Indexes synced. Migration complete.');
    }
  }
} finally {
  await mongoose.disconnect();
}
