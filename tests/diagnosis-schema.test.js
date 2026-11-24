import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIAGNOSIS_TOOL,
  mockDiagnose,
} from '../src/services/diagnosis.service.js';
import { DiagnosisScan } from '../src/models/DiagnosisScan.js';

// Phase 2 spec §1: the planter must be able to see WHY a diagnosis was made,
// and must be told how to apply a product safely. These pin that contract so
// a prompt edit can't quietly drop a required field.

const schema = DIAGNOSIS_TOOL.input_schema;
const treatment = schema.properties.treatment;

test('the model is forced to report its visual evidence', () => {
  assert.ok(schema.properties.symptoms, 'symptoms missing from tool schema');
  assert.equal(schema.properties.symptoms.type, 'string');
  assert.ok(
    schema.required.includes('symptoms'),
    'symptoms must be required — optional evidence gets omitted',
  );
});

test('safety fields are required on every treatment', () => {
  for (const field of ['safetyPrecautions', 'reEntryInterval']) {
    assert.ok(treatment.properties[field], `${field} missing`);
    assert.ok(
      treatment.required.includes(field),
      `${field} must be required — pesticide advice without it is unsafe`,
    );
  }
});

test('re-entry guidance tells the model not to guess', () => {
  // A hallucinated pre-harvest interval is worse than none at all.
  assert.match(
    treatment.properties.reEntryInterval.description,
    /never guess|check the label/i,
  );
});

test('up to 4 differential diagnoses, per spec', () => {
  assert.equal(schema.properties.alternatives.maxItems, 4);
});

test('taxonomy covers the full spec disease list with binomials', () => {
  // SYSTEM_PROMPT is private, so assert through what it produces: the tool
  // description set plus the canonical names the mocks use.
  const required = [
    /phytophthora/i,
    /pythium|fusarium/i,
    /katte|mosaic/i,
    /chenthal/i,
    /colletotrichum/i,
    /sciothrips|thrips/i,
    /conogethes|borer/i,
    /basilepta|root grub/i,
  ];
  // Pulled from the module source so the list can't drift silently.
  const src = require_source();
  for (const re of required) {
    assert.match(src, re, `taxonomy is missing ${re}`);
  }
});

function require_source() {
  return readFileSync(
    new URL('../src/services/diagnosis.service.js', import.meta.url),
    'utf8',
  );
}

test('every mock response carries the Phase B fields', async () => {
  // Three canned responses rotate; drain all of them.
  for (let i = 0; i < 3; i++) {
    const r = await mockDiagnose({ areaAcres: 10 });
    assert.ok(r.symptoms.length > 0, `mock ${i} has no symptoms`);
    assert.ok(
      'safetyPrecautions' in r.treatment,
      `mock ${i} missing safetyPrecautions`,
    );
    assert.ok(
      'reEntryInterval' in r.treatment,
      `mock ${i} missing reEntryInterval`,
    );
    // The healthy mock applies nothing, so empty safety text is correct there.
    if (r.treatment.products.length > 0) {
      assert.ok(
        r.treatment.safetyPrecautions.length > 0,
        `mock ${i} recommends a product with no precautions`,
      );
      assert.ok(
        r.treatment.reEntryInterval.length > 0,
        `mock ${i} recommends a product with no re-entry interval`,
      );
    }
  }
});

test('new fields are persisted and default to empty, not undefined', () => {
  assert.equal(DiagnosisScan.schema.path('symptoms').defaultValue, '');
  const t = DiagnosisScan.schema.path('treatment').schema;
  assert.equal(t.path('safetyPrecautions').defaultValue, '');
  assert.equal(t.path('reEntryInterval').defaultValue, '');
});

// --- Regression: a lichen-covered tree trunk came back as a healthy
// cardamom stem at 85% confidence, because the context block asserted the
// planter's chosen plant part as fact. The tag is a hint, not evidence.

test('the plant part is offered as the planter\'s claim, not as fact', async () => {
  const { buildDiagnosisContext } = await import(
    '../src/services/diagnosis-context.service.js'
  );
  const { promptBlock } = await buildDiagnosisContext({
    district: 'Idukki',
    plantPart: 'stem',
    areaAcres: 20,
    areaLabel: 'the whole estate',
  });
  // Must not state it as established fact.
  assert.doesNotMatch(promptBlock, /Plant part photographed: stem\./);
  // Must mark it as the planter's label and ask for it to be checked.
  assert.match(promptBlock, /tagged this photo as: stem/i);
  assert.match(promptBlock, /check it against the image/i);
});

test('subject verification comes before diagnosis in the prompt', () => {
  const src = readFileSync(
    new URL('../src/services/diagnosis.service.js', import.meta.url),
    'utf8',
  );
  const verify = src.indexOf('confirm the photograph actually shows a cardamom');
  const context = src.indexOf('Each request gives you a photograph plus a CONTEXT');
  assert.ok(verify > -1, 'no subject-verification instruction');
  assert.ok(
    verify < context,
    'subject verification must precede the context rules',
  );
  // Name the specific thing that fooled it.
  assert.match(src, /tree trunk is not a cardamom stem/i);
});

test('isHealthy cannot be true for an unconfirmed subject', () => {
  const desc = DIAGNOSIS_TOOL.input_schema.properties.isHealthy.description;
  assert.match(desc, /confirmed/i);
  assert.match(desc, /false whenever you cannot confirm/i);
});
