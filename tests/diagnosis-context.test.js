import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seasonalContext, MONTHS } from '../src/utils/season.js';
import { describeWeather } from '../src/services/weather.service.js';
import { PLANT_PARTS } from '../src/services/diagnosis-context.service.js';
import { WeatherSnapshot } from '../src/models/WeatherSnapshot.js';
import { DiagnosisScan } from '../src/models/DiagnosisScan.js';

// Phase 2 spec §1: the prompt carries district, month, season and weather.
// These tests pin the agronomic meaning, not the wording.

test('every month maps to a season with disease pressure', () => {
  for (let m = 0; m < 12; m++) {
    const c = seasonalContext(new Date(Date.UTC(2026, m, 15)));
    assert.equal(c.month, MONTHS[m]);
    assert.ok(c.season.length > 0, `${MONTHS[m]} has no season`);
    assert.ok(c.pressure.length > 0, `${MONTHS[m]} has no pressure`);
    assert.ok(c.harvest.length > 0, `${MONTHS[m]} has no crop stage`);
  }
});

test('monsoon months flag rot; dry months flag thrips', () => {
  // June–August: Phytophthora weather.
  for (const m of [5, 6, 7]) {
    const c = seasonalContext(new Date(Date.UTC(2026, m, 15)));
    assert.match(c.pressure, /rot/i, `${c.month} should flag rot`);
    assert.match(c.season, /monsoon/i);
  }
  // January–March: dry-season pests.
  for (const m of [0, 1, 2]) {
    const c = seasonalContext(new Date(Date.UTC(2026, m, 15)));
    assert.match(c.pressure, /thrips/i, `${c.month} should flag thrips`);
    assert.doesNotMatch(c.season, /monsoon/i);
  }
});

test('plant parts stay in sync with the Flutter enum', () => {
  assert.deepEqual(PLANT_PARTS, [
    'leaf',
    'stem',
    'capsule',
    'rhizome',
    'whole plant',
  ]);
});

test('plantPart is optional and constrained on the scan model', () => {
  const path = DiagnosisScan.schema.path('plantPart');
  assert.ok(!path.isRequired);
  assert.ok(path.enumValues.includes('capsule'));
  assert.ok(path.enumValues.includes('rhizome'));
  assert.ok(!path.enumValues.includes('petal'));
});

test('contextSnapshot is stored per scan for audit and replay', () => {
  assert.ok(DiagnosisScan.schema.path('contextSnapshot'));
});

test('describeWeather returns null when there is no snapshot', () => {
  assert.equal(describeWeather(null), null);
});

test('describeWeather marks a short history as partial', () => {
  const snap = new WeatherSnapshot({
    district: 'idukki',
    fetchedAt: new Date(),
    description: 'moderate rain',
    tempC: 22.6,
    humidity: 91,
    samples: [
      { at: new Date(Date.now() - 2 * 86_400_000), rain3hMm: 12 },
      { at: new Date(Date.now() - 1 * 86_400_000), rain3hMm: 8 },
    ],
  });
  const line = describeWeather(snap);
  assert.match(line, /moderate rain/);
  assert.match(line, /23°C/);
  assert.match(line, /91% humidity/);
  assert.match(line, /20\.0 mm/);
  assert.match(line, /partial history/);
});

test('describeWeather reports a full week once covered', () => {
  const snap = new WeatherSnapshot({
    district: 'wayanad',
    fetchedAt: new Date(),
    description: 'overcast clouds',
    samples: [
      { at: new Date(Date.now() - 7 * 86_400_000), rain3hMm: 40 },
      { at: new Date(Date.now() - 1 * 86_400_000), rain3hMm: 2.5 },
    ],
  });
  const line = describeWeather(snap);
  assert.match(line, /42\.5 mm rain over the last 7 days/);
  assert.doesNotMatch(line, /partial/);
});

test('a stale snapshot discloses its age', () => {
  const snap = new WeatherSnapshot({
    district: 'idukki',
    fetchedAt: new Date(Date.now() - 50 * 3.6e6),
    description: 'clear sky',
    samples: [{ at: new Date(Date.now() - 50 * 3.6e6), rain3hMm: 0 }],
  });
  assert.match(describeWeather(snap), /50h old/);
});

// --- Regression: the context used to list the diseases "likely this month".
// Measured effect: the same photograph came back as leaf blight in November
// and Chenthal disease in February. A list of disease names beside a photo
// is an answer key. The prompt now carries physical conditions only.

test('every month describes physical conditions, not diseases', () => {
  for (let m = 0; m < 12; m++) {
    const c = seasonalContext(new Date(Date.UTC(2026, m, 15)));
    assert.ok(c.conditions?.length > 0, `${c.month} has no conditions`);
    // Conditions describe what the plant experiences, so they must not name
    // a pathogen or a disease.
    assert.doesNotMatch(
      c.conditions,
      /blight|rot|thrips|borer|katte|chenthal|azhukal|phytophthora|virus|mosaic|grub/i,
      `${c.month} conditions name a disease`,
    );
  }
});

test('the prompt block never hands the model a disease list', async () => {
  const { buildDiagnosisContext } = await import(
    '../src/services/diagnosis-context.service.js'
  );
  for (const month of [1, 6, 10]) {
    const { promptBlock } = await buildDiagnosisContext({
      district: 'Wayanad',
      plantPart: 'leaf',
      areaAcres: 20,
      now: new Date(Date.UTC(2026, month, 15)),
    });
    assert.doesNotMatch(promptBlock, /disease pressure/i);
    assert.doesNotMatch(
      promptBlock,
      /blight|azhukal|phytophthora|katte|chenthal|thrips|borer/i,
      `month ${month} leaked disease names into the prompt`,
    );
    assert.match(promptBlock, /Growing conditions now:/);
  }
});

test('the disease list is still recorded, just not sent', async () => {
  const { buildDiagnosisContext } = await import(
    '../src/services/diagnosis-context.service.js'
  );
  const { snapshot } = await buildDiagnosisContext({
    district: 'Idukki',
    areaAcres: 10,
    now: new Date(Date.UTC(2026, 6, 15)),
  });
  // Useful for analysing results after the fact.
  assert.match(snapshot.seasonalPressureNotSent, /rot/i);
  assert.ok(snapshot.conditions?.length > 0);
});
