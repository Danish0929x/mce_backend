import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mockDiagnose,
  formatAcres,
  scaleDosePerAcre,
  doseTotalsAgree,
  isNonDiagnosis,
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

// --- Regression: the dose errors found in the first live scan ---
// A real scan returned "Copper oxychloride 1.5% (20 mL concentrate in
// 1,000 L water)" scaled to "300 mL in 20,000 L" for 20 acres — wrong units
// for a wettable powder, a strength off by ~750x, and 20x20 != 300.

test('formulation codes are not quantities', () => {
  // "20EC" is part of the product name. Scaling it renames the chemical.
  assert.equal(
    scaleDosePerAcre('Chlorpyrifos 20EC at 2 ml per litre', 20),
    'Chlorpyrifos 20EC at 2 ml per litre',
  );
  assert.equal(
    scaleDosePerAcre('Mancozeb 75% WP 2 kg in 1,000 L water', 20),
    'Mancozeb 75% WP 40 kg in 20,000 L water',
  );
});

test('concentrations do not scale with area', () => {
  // 10 acres of spray is still 2 ml per litre.
  assert.equal(scaleDosePerAcre('2 ml per litre', 10), '2 ml per litre');
  assert.equal(scaleDosePerAcre('3 g/L of water', 10), '3 g/L of water');
});

test('only numbers attached to a unit are scaled', () => {
  // "within 3 days" is not an amount of anything.
  assert.equal(
    scaleDosePerAcre('Apply 1.5 kg in 400 L water within 3 days', 10),
    'Apply 15 kg in 4,000 L water within 3 days',
  );
});

test('doseTotalsAgree catches the arithmetic the model got wrong', () => {
  // 20 mL/acre x 20 acres is 400, not 300.
  assert.equal(
    doseTotalsAgree('300 mL in 20,000 L water', '400 mL in 20,000 L water'),
    false,
  );
  assert.equal(
    doseTotalsAgree('40 kg in 20,000 L water', '40 kg in 20,000 L water'),
    true,
  );
});

test('doseTotalsAgree tolerates rounding and wording, not real differences', () => {
  assert.equal(doseTotalsAgree('15 kg in 4,000 L', '15 kg in 4,000 L'), true);
  // Different count of numbers means we cannot compare them meaningfully.
  assert.equal(doseTotalsAgree('15 kg', '15 kg in 4,000 L'), false);
  assert.equal(doseTotalsAgree('', '15 kg'), null);
  assert.equal(doseTotalsAgree('15 kg', ''), null);
});

test('a scaled total never keeps a per-acre label', () => {
  // "5 kg/acre" x 20 is 100 kg TOTAL. Leaving "/acre" on it reads as a rate
  // twenty times too high — a planter following it overdoses by 20x.
  assert.equal(
    scaleDosePerAcre('Potassium nitrate 5 kg/acre', 20),
    'Potassium nitrate 100 kg in total',
  );
  assert.equal(
    scaleDosePerAcre('600 g Mancozeb per acre', 20),
    '12,000 g Mancozeb in total',
  );
  // "per litre" is a concentration, not a per-acre label — must survive.
  assert.match(scaleDosePerAcre('2 ml per litre', 20), /per litre/);
});

test('non-diagnoses are recognised so they are not billed', () => {
  for (const t of [
    'Not a cardamom plant',
    'Image unclear',
    'image unclear — too dark',
    'Unclear',
  ]) {
    assert.equal(isNonDiagnosis(t), true, `${t} should be a non-diagnosis`);
  }
  for (const t of [
    'Azhukal / capsule rot (Phytophthora meadii)',
    'Healthy',
    'Leaf blight (Colletotrichum gloeosporioides)',
  ]) {
    assert.equal(isNonDiagnosis(t), false, `${t} should be billable`);
  }
  assert.equal(isNonDiagnosis(''), false);
  assert.equal(isNonDiagnosis(null), false);
});
