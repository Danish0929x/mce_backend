import mongoose from 'mongoose';
import { z } from 'zod';
import { Plantation } from '../../models/Plantation.js';
import { Supply } from '../../models/Supply.js';
import { SupplyLog } from '../../models/SupplyLog.js';
import { StockPurchase } from '../../models/StockPurchase.js';
import { rupeesToPaise } from '../../utils/money.js';

// ---------- helpers ----------

async function getCallerPlantation(req) {
  return Plantation.findOne({ ownerId: req.user.sub });
}

function toHttpError(err) {
  if (err?.name === 'ZodError') {
    const e = new Error(
      err.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
    e.status = 400;
    e.code = 'validation_error';
    return e;
  }
  return err;
}

// ============================================================
// SUPPLIES — CRUD
// ============================================================

export async function listSupplies(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const supplies = await Supply.find({
      plantationId: p._id,
      active: true,
    }).sort({ category: 1, name: 1 });
    res.json({ ok: true, supplies: supplies.map((s) => s.toPublicJSON()) });
  } catch (err) {
    next(err);
  }
}

const createSupplySchema = z.object({
  category: z.enum(['pesticide', 'tool', 'ppe', 'seed', 'container', 'other']),
  name: z.string().trim().min(2).max(80),
  unit: z.string().trim().min(1).max(16),
  initialQuantity: z.number().nonnegative().optional(),
  lowStockThreshold: z.number().nonnegative().optional(),
  notes: z.string().trim().max(500).optional().nullable(),
});

export async function createSupply(req, res, next) {
  try {
    const body = createSupplySchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    // Guard against duplicate active names for the same plantation.
    const existing = await Supply.findOne({
      plantationId: p._id,
      name: body.name,
      active: true,
    });
    if (existing) {
      return res.status(409).json({
        error: 'duplicate_supply',
        message: 'A supply with that name already exists.',
      });
    }

    const supply = await Supply.create({
      plantationId: p._id,
      category: body.category,
      name: body.name,
      unit: body.unit,
      quantity: body.initialQuantity ?? 0,
      lowStockThreshold: body.lowStockThreshold ?? 0,
      notes: body.notes ?? null,
    });
    res.status(201).json({ ok: true, supply: supply.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

const updateSupplySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    category: z
      .enum(['pesticide', 'tool', 'ppe', 'seed', 'container', 'other'])
      .optional(),
    unit: z.string().trim().min(1).max(16).optional(),
    lowStockThreshold: z.number().nonnegative().optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Provide at least one field to update.',
  });

export async function updateSupply(req, res, next) {
  try {
    const body = updateSupplySchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const supply = await Supply.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!supply) return res.status(404).json({ error: 'supply_not_found' });

    for (const [k, v] of Object.entries(body)) {
      supply[k] = v;
    }
    await supply.save();
    res.json({ ok: true, supply: supply.toPublicJSON() });
  } catch (err) {
    next(toHttpError(err));
  }
}

/** Soft delete (active = false). */
export async function archiveSupply(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const supply = await Supply.findOneAndUpdate(
      { _id: req.params.id, plantationId: p._id },
      { active: false },
      { new: true },
    );
    if (!supply) return res.status(404).json({ error: 'supply_not_found' });
    res.json({ ok: true, supply: supply.toPublicJSON() });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// SUPPLIES — stock operations
// ============================================================

const adjustSupplySchema = z.object({
  kind: z.enum(['purchase', 'use', 'adjust']),
  delta: z.number().refine((n) => n !== 0, 'delta must be non-zero'),
  unitCostRupees: z.number().nonnegative().optional(),
  supplier: z.string().trim().max(120).optional().nullable(),
  reason: z.string().trim().max(200).optional().nullable(),
});

/**
 * Log a purchase, use, or manual adjustment against a Supply. Atomically
 * updates Supply.quantity and (for purchases) the rolling avg unit cost.
 */
export async function adjustSupply(req, res, next) {
  const session = await mongoose.startSession();
  try {
    const body = adjustSupplySchema.parse(req.body);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const supply = await Supply.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!supply) return res.status(404).json({ error: 'supply_not_found' });

    // Enforce sign convention.
    let delta = body.delta;
    if (body.kind === 'purchase' && delta < 0) delta = Math.abs(delta);
    if (body.kind === 'use' && delta > 0) delta = -Math.abs(delta);
    if (supply.quantity + delta < 0) {
      return res.status(400).json({
        error: 'insufficient_stock',
        message: 'Not enough stock for this operation.',
      });
    }

    let unitCostPaise = null;
    let totalCostPaise = 0;
    if (body.kind === 'purchase' && body.unitCostRupees != null) {
      unitCostPaise = rupeesToPaise(String(body.unitCostRupees));
      totalCostPaise = Math.round(unitCostPaise * delta);
    }

    let updated, logDoc;
    await session.withTransaction(async () => {
      const $inc = { quantity: delta };
      const $set = {};
      // Weighted-average unit cost on purchases.
      if (body.kind === 'purchase' && unitCostPaise != null) {
        const prevQty = supply.quantity;
        const prevCost = supply.avgUnitCostPaise ?? unitCostPaise;
        const newQty = prevQty + delta;
        const weighted =
          newQty > 0
            ? Math.round(
                (prevQty * prevCost + delta * unitCostPaise) / newQty,
              )
            : unitCostPaise;
        $set.avgUnitCostPaise = weighted;
      }
      updated = await Supply.findByIdAndUpdate(
        supply._id,
        { $inc, $set },
        { new: true, session },
      );
      [logDoc] = await SupplyLog.create(
        [
          {
            plantationId: p._id,
            supplyId: supply._id,
            kind: body.kind,
            delta,
            unitCostPaise,
            totalCostPaise,
            supplier: body.supplier ?? null,
            reason: body.reason ?? null,
            at: new Date(),
          },
        ],
        { session },
      );
    });

    res.json({
      ok: true,
      supply: updated.toPublicJSON(),
      log: logDoc.toPublicJSON(),
    });
  } catch (err) {
    next(toHttpError(err));
  } finally {
    session.endSession();
  }
}

/** Returns the last N supply-log entries for a given supply (newest first). */
export async function listSupplyHistory(req, res, next) {
  try {
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });
    const supply = await Supply.findOne({
      _id: req.params.id,
      plantationId: p._id,
    });
    if (!supply) return res.status(404).json({ error: 'supply_not_found' });
    const logs = await SupplyLog.find({ supplyId: supply._id })
      .sort({ at: -1 })
      .limit(100);
    res.json({ ok: true, logs: logs.map((l) => l.toPublicJSON()) });
  } catch (err) {
    next(err);
  }
}

// ============================================================
// SPENDING — cross-inventory rollup
// ============================================================

const spendingQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

/**
 * Total ₹ spent across fertilizer stock purchases + supply purchases in a
 * time window. Groups by (source, category). Adjustment entries (which have
 * no real cost) are ignored via the totalCostPaise>0 filter.
 */
export async function getInventorySpending(req, res, next) {
  try {
    const q = spendingQuerySchema.parse(req.query);
    const p = await getCallerPlantation(req);
    if (!p) return res.status(404).json({ error: 'no_plantation' });

    const now = new Date();
    const from =
      q.from ?? new Date(now.getFullYear(), now.getMonth() - 2, 1);
    const to = q.to ?? now;

    // Fertilizer side — StockPurchase rows.
    const fertAgg = await StockPurchase.aggregate([
      {
        $match: {
          plantationId: p._id,
          purchasedAt: { $gte: from, $lte: to },
          totalCostPaise: { $gt: 0 },
        },
      },
      {
        $group: {
          _id: null,
          totalPaise: { $sum: '$totalCostPaise' },
          count: { $sum: 1 },
        },
      },
    ]);

    // Supply side — purchase kind only.
    const supplyAgg = await SupplyLog.aggregate([
      {
        $match: {
          plantationId: p._id,
          kind: 'purchase',
          at: { $gte: from, $lte: to },
          totalCostPaise: { $gt: 0 },
        },
      },
      {
        $lookup: {
          from: 'supplies',
          localField: 'supplyId',
          foreignField: '_id',
          as: 'supply',
        },
      },
      { $unwind: '$supply' },
      {
        $group: {
          _id: '$supply.category',
          totalPaise: { $sum: '$totalCostPaise' },
          count: { $sum: 1 },
        },
      },
    ]);

    const byCategory = [
      {
        category: 'fertilizer',
        totalPaise: fertAgg[0]?.totalPaise ?? 0,
        purchases: fertAgg[0]?.count ?? 0,
      },
      ...supplyAgg.map((r) => ({
        category: r._id,
        totalPaise: r.totalPaise,
        purchases: r.count,
      })),
    ];

    const totalPaise = byCategory.reduce((s, r) => s + r.totalPaise, 0);
    const totalPurchases = byCategory.reduce((s, r) => s + r.purchases, 0);

    res.json({
      ok: true,
      from,
      to,
      totalPaise,
      totalPurchases,
      byCategory,
    });
  } catch (err) {
    next(toHttpError(err));
  }
}
