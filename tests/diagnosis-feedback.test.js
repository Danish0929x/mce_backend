import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FOLLOW_UP_DAYS,
  RECURRENCE_WINDOW_DAYS,
  followUpInstant,
  parsePerAcreKg,
  inferApplicationMethod,
} from '../src/services/diagnosis-feedback.service.js';
import { DiagnosisScan } from '../src/models/DiagnosisScan.js';
import { entitlementsFor } from '../src/services/subscription.service.js';

// Phase 2 spec §1: feedback loop, recurrence warning, add-to-schedule.

test('follow-up lands 7 days after the scan', () => {
  assert.equal(FOLLOW_UP_DAYS, 7);
  const scanned = new Date('2026-06-15T09:30:00Z');
  assert.equal(
    followUpInstant(scanned).toISOString(),
    new Date('2026-06-22T09:30:00Z').toISOString(),
  );
});

test('recurrence window is the spec\'s 30 days', () => {
  assert.equal(RECURRENCE_WINDOW_DAYS, 30);
});

test('feedback outcomes are constrained to the three the spec names', () => {
  const fb = DiagnosisScan.schema.path('feedback').schema;
  assert.deepEqual(fb.path('outcome').enumValues, [
    'worked',
    'partial',
    'failed',
  ]);
  assert.equal(fb.path('outcome').isRequired, true);
});

test('a scan starts with no feedback and no treatment taken', () => {
  assert.equal(DiagnosisScan.schema.path('treatmentTaken').defaultValue, false);
  assert.equal(DiagnosisScan.schema.path('feedback').defaultValue, null);
});

test('the recurrence query has an index behind it', () => {
  // Without this index the 30-day lookup is a collection scan on every scan.
  const wanted = ['plantationId', 'plotId', 'topDiagnosis', 'createdAt'];
  const found = DiagnosisScan.schema.indexes().some(([spec]) => {
    const keys = Object.keys(spec);
    return wanted.every((k) => keys.includes(k));
  });
  assert.ok(found, 'no index covers { plantationId, plotId, topDiagnosis }');
});

test('parsePerAcreKg reads weight doses and refuses concentrations', () => {
  assert.equal(parsePerAcreKg('1.5 kg copper oxychloride in 400 L water'), 1.5);
  assert.equal(parsePerAcreKg('0.6 kg in 200 L water as foliar spray'), 0.6);
  assert.equal(parsePerAcreKg('600 g Mancozeb per acre'), 0.6);
  // Concentration has no kg/acre equivalent — must not be guessed.
  assert.equal(parsePerAcreKg('Chlorpyrifos 20EC at 2ml/litre'), null);
  assert.equal(parsePerAcreKg(''), null);
  assert.equal(parsePerAcreKg(null), null);
});

test('parsePerAcreKg does not mistake the water volume for a dose', () => {
  // "400 L water" is the carrier, not the product.
  assert.equal(parsePerAcreKg('Dissolve in 400 L water'), null);
});

test('application method is inferred from how the treatment reads', () => {
  assert.equal(
    inferApplicationMethod({ summary: 'Apply as a soil drench within 3 days' }),
    'soil-drench',
  );
  assert.equal(
    inferApplicationMethod({ doseringPerAcre: '0.6 kg in 200 L as foliar spray' }),
    'foliar-spray',
  );
  assert.equal(inferApplicationMethod({}), 'broadcasting');
});

test('multi-photo is Pro-only, capped at 3', () => {
  assert.equal(entitlementsFor('free').photosPerScan, 1);
  assert.equal(entitlementsFor('pro').photosPerScan, 3);
  assert.equal(entitlementsFor('pro_trial').photosPerScan, 3);
});

test('extra photos are stored without disturbing the first one', () => {
  // The first photo must stay in imageBase64 so existing readers keep working.
  assert.ok(DiagnosisScan.schema.path('imageBase64').isRequired);
  const extra = DiagnosisScan.schema.path('extraImages');
  assert.ok(extra, 'extraImages missing');
  assert.deepEqual(extra.defaultValue(), []);
});
