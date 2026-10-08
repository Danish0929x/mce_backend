import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockDiagnose,
  formatAcres,
  scaleDosePerAcre,
} from '../src/services/diagnosis.service.js';
import { DiagnosisScan } from '../src/models/DiagnosisScan.js';

// Brief §6.1: treatment quantities calculated for the planter's acreage.

test('scaleDosePerAcre multiplies every quantity, with Indian grouping', () => {
  assert.equal(
    scaleDosePerAcre('1.5 kg copper oxychloride in 400 L water', 10),
    '15 kg copper oxychloride in 4,000 L water',
  );
  assert.equal(
    scaleDosePerAcre('0.6 kg in 200 L water', 2.5),
    '1.5 kg in 500 L water',
  );
});

test('scaleDosePerAcre leaves concentrations alone', () => {
  assert.equal(
    scaleDosePerAcre('Bordeaux mixture 1%, 500 L', 4),
    'Bordeaux mixture 1%, 2,000 L',
  );
});

test('scaleDosePerAcre: no dose or no acreage → empty', () => {
  assert.equal(scaleDosePerAcre('', 10), '');
  assert.equal(scaleDosePerAcre('1 kg', null), '');
  assert.equal(scaleDosePerAcre('1 kg', 0), '');
});

test('formatAcres', () => {
  assert.equal(formatAcres(1), '1 acre');
  assert.equal(formatAcres(10), '10 acres');
  assert.equal(formatAcres(2.5), '2.5 acres');
});

test('mock provider sizes the dose for the given area', async () => {
  const r = await mockDiagnose({ areaAcres: 10 });
  assert.equal(r.areaAcres, 10);
  assert.equal(typeof r.treatment.doseForArea, 'string');
  if (r.treatment.doseringPerAcre) assert.notEqual(r.treatment.doseForArea, '');
});

test('old scans without doseForArea/areaAcres serialize as empty/null', () => {
  const scan = new DiagnosisScan({
    plantationId: '64b000000000000000000001',
    imageBase64: 'x',
    provider: 'mock',
    topDiagnosis: 'Healthy',
    treatment: { summary: 'ok', doseringPerAcre: '1 kg' },
  });
  const json = scan.toPublicJSON();
  assert.equal(json.treatment.doseForArea, '');
  assert.equal(json.areaAcres, null);
});
