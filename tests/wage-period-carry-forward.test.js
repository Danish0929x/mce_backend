import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WagePeriod } from '../src/models/WagePeriod.js';

// Missing quarters are created automatically with the latest Basic + DA,
// so union pay never drops to ₹0 just because a circular wasn't entered.

const day = (s) => new Date(`${s}T00:00:00.000Z`);

function stub({ latest, active = null }) {
  const created = [];
  const orig = {
    activeOn: WagePeriod.activeOn,
    findOne: WagePeriod.findOne,
    create: WagePeriod.create,
  };
  WagePeriod.activeOn = async () => active;
  WagePeriod.findOne = () => ({ sort: async () => latest });
  WagePeriod.create = async (doc) => created.push(doc);
  return {
    created,
    restore: () => Object.assign(WagePeriod, orig),
  };
}

test('latest is Jul–Sep 2026, today 8 Oct → Oct–Dec 2026 created with the same rates', async () => {
  const s = stub({
    latest: {
      label: 'Jul–Sep 2026',
      effectiveTo: new Date('2026-09-30T23:59:59.999Z'),
      basicPaise: 42121,
      daPaise: 16000,
    },
  });
  try {
    await WagePeriod.ensureCoversToday('p1', day('2026-10-08'));
    assert.equal(s.created.length, 1);
    const q = s.created[0];
    assert.equal(q.label, 'Oct–Dec 2026');
    assert.deepEqual(q.effectiveFrom, day('2026-10-01'));
    assert.equal(q.effectiveTo.toISOString(), '2026-12-31T23:59:59.999Z');
    assert.equal(q.totalPaise, 58121); // ₹581.21 carried forward
    assert.equal(q.carriedForwardFrom, 'Jul–Sep 2026');
    assert.equal(q.seedKey, 'auto-2026-10-01');
  } finally {
    s.restore();
  }
});

test('a gap of several quarters is filled quarter by quarter', async () => {
  const s = stub({
    latest: {
      label: 'Apr–Jun 2026',
      effectiveTo: new Date('2026-06-30T23:59:59.999Z'),
      basicPaise: 42121,
      daPaise: 15155,
    },
  });
  try {
    await WagePeriod.ensureCoversToday('p1', day('2026-10-08'));
    assert.deepEqual(s.created.map((c) => c.label), ['Jul–Sep 2026', 'Oct–Dec 2026']);
  } finally {
    s.restore();
  }
});

test('nothing is created when today is already covered', async () => {
  const s = stub({ latest: null, active: { label: 'Oct–Dec 2026' } });
  try {
    await WagePeriod.ensureCoversToday('p1', day('2026-10-08'));
    assert.equal(s.created.length, 0);
  } finally {
    s.restore();
  }
});
