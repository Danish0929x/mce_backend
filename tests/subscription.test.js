import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  effectivePlan,
  entitlementsFor,
  FREE_WORKER_LIMIT,
} from '../src/services/subscription.service.js';

// Plans — brief §5.5.3. Derived from dates at request time.

const NOW = Date.parse('2026-10-07T00:00:00.000Z');
const DAY = 86_400_000;

test('trial still running → pro_trial', () => {
  assert.equal(effectivePlan({ trialEndsAt: new Date(NOW + DAY) }, null, NOW), 'pro_trial');
});

test('trial ended and no subscription → free', () => {
  assert.equal(effectivePlan({ trialEndsAt: new Date(NOW - DAY) }, null, NOW), 'free');
});

test('active store-verified subscription → pro, even after the trial', () => {
  const sub = { isActive: true, expiresDateMs: NOW + 30 * DAY };
  assert.equal(effectivePlan({ trialEndsAt: new Date(NOW - DAY) }, sub, NOW), 'pro');
});

test('expired or revoked subscription → free', () => {
  const user = { trialEndsAt: new Date(NOW - 100 * DAY) };
  assert.equal(effectivePlan(user, { isActive: true, expiresDateMs: NOW - 1 }, NOW), 'free');
  assert.equal(effectivePlan(user, { isActive: false, expiresDateMs: NOW + DAY }, NOW), 'free');
});

test('free plan: 5 workers, 10 AI scans/month, no PDF, no CSV; trial and pro unlock all', () => {
  assert.deepEqual(entitlementsFor('free'), {
    isPro: false,
    workerLimit: FREE_WORKER_LIMIT,
    aiScansPerMonth: 10,
    canExportPdf: false,
    canBulkImport: false,
  });
  assert.equal(FREE_WORKER_LIMIT, 5);
  for (const plan of ['pro', 'pro_trial']) {
    assert.deepEqual(entitlementsFor(plan), {
      isPro: true,
      workerLimit: null,
      aiScansPerMonth: null,
      canExportPdf: true,
      canBulkImport: true,
    });
  }
});
