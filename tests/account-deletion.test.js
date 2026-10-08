import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELETION_GRACE_DAYS,
  plantationScopedModels,
  scheduleDeletion,
} from '../src/services/account-deletion.service.js';

// Account deletion — brief §10.4.

test('purge covers every model that stores estate data', () => {
  const names = plantationScopedModels().map((m) => m.modelName).sort();
  assert.deepEqual(names, [
    'ApplicationLog',
    'Attendance',
    'BonusPayment',
    'BonusRule',
    'DiagnosisScan',
    'Fertilizer',
    'FertilizerSchedule',
    'FestivalDate',
    'Inventory',
    'PayrollWeek',
    'Plot',
    'StockPurchase',
    'Supply',
    'SupplyLog',
    'WagePeriod',
    'Worker',
    'YearEndSettlement',
  ]);
});

test('deletion is scheduled 30 days out', async () => {
  const user = { save: async () => {} };
  const now = new Date('2026-10-07T10:00:00.000Z');
  const after = await scheduleDeletion(user, now);
  assert.equal(DELETION_GRACE_DAYS, 30);
  assert.equal(user.deletedAt, now);
  assert.equal(after.toISOString(), '2026-11-06T10:00:00.000Z');
});
