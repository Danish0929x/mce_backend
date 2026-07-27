import { User } from '../../models/User.js';
import { Plantation } from '../../models/Plantation.js';
import { Plot } from '../../models/Plot.js';
import { Worker } from '../../models/Worker.js';
import { FertilizerSchedule } from '../../models/FertilizerSchedule.js';
import { Fertilizer } from '../../models/Fertilizer.js';
import { Inventory } from '../../models/Inventory.js';
import { Attendance } from '../../models/Attendance.js';
import { PayrollWeek } from '../../models/PayrollWeek.js';
import { BonusPayment } from '../../models/BonusPayment.js';
import { StockPurchase } from '../../models/StockPurchase.js';
import { SupplyLog } from '../../models/SupplyLog.js';
import { calculateWeeklyPayroll } from '../../services/wage-engine.service.js';

function startOfWeekMonday(date) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  const dow = d.getUTCDay();
  const diff = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

/**
 * Sum of every ₹ that already left the estate this week — paid payroll +
 * fertilizer stock purchases + supply purchases. Used for the "week spend
 * so far" card on the dashboard.
 */
async function computeWeekSpendPaise(plantationId, weekStart, weekEnd) {
  const [paidPayroll, stockPurchases, supplyPurchases] = await Promise.all([
    PayrollWeek.find({
      plantationId,
      weekStart,
      paidAt: { $ne: null },
    }),
    StockPurchase.find({
      plantationId,
      purchasedAt: { $gte: weekStart, $lte: weekEnd },
      totalCostPaise: { $gt: 0 },
    }).select('totalCostPaise'),
    SupplyLog.find({
      plantationId,
      kind: 'purchase',
      at: { $gte: weekStart, $lte: weekEnd },
      totalCostPaise: { $gt: 0 },
    }).select('totalCostPaise'),
  ]);

  const payrollSpent = paidPayroll.reduce((s, r) => s + (r.totalPaise ?? 0), 0);
  const stockSpent = stockPurchases.reduce(
    (s, r) => s + (r.totalCostPaise ?? 0),
    0,
  );
  const supplySpent = supplyPurchases.reduce(
    (s, r) => s + (r.totalCostPaise ?? 0),
    0,
  );

  return {
    totalPaise: payrollSpent + stockSpent + supplySpent,
    payrollPaise: payrollSpent,
    stockPaise: stockSpent,
    supplyPaise: supplySpent,
  };
}

/**
 * Sum of unpaid wages + bonuses across all active workers for the current
 * week. Mirrors the Weekly Payroll screen's totals but only counts workers
 * whose PayrollWeek row is missing or unpaid. Already-paid weeks contribute 0.
 */
async function computePayrollDuePaise(plantationId) {
  const weekStart = startOfWeekMonday(new Date());
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  weekEnd.setUTCHours(23, 59, 59, 999);

  const [workers, attendance, paidRows, bonuses] = await Promise.all([
    Worker.find({ plantationId, active: true }),
    Attendance.find({
      plantationId,
      workDate: { $gte: weekStart, $lte: weekEnd },
    }),
    PayrollWeek.find({ plantationId, weekStart }),
    BonusPayment.find({
      plantationId,
      paidAt: { $gte: weekStart, $lte: weekEnd },
    }),
  ]);

  const paidByWorker = new Map(
    paidRows.map((r) => [r.workerId.toString(), r]),
  );
  const bonusByWorker = new Map();
  for (const b of bonuses) {
    const key = b.workerId.toString();
    bonusByWorker.set(key, (bonusByWorker.get(key) ?? 0) + b.amountPaise);
  }

  let due = 0;
  for (const w of workers) {
    const wId = w._id.toString();
    if (paidByWorker.get(wId)?.paidAt) continue; // already paid — nothing due
    const att = attendance.filter((a) => a.workerId.toString() === wId);
    const r = await calculateWeeklyPayroll({
      worker: w,
      attendance: att,
      weekStart,
    });
    due += r.totalPaise + (bonusByWorker.get(wId) ?? 0);
  }
  return due;
}

/**
 * Dashboard composite query — everything the Home screen needs in one round trip.
 *
 * Aligns with brief §5.2.1 (Dashboard overview):
 *   - greeting (time-of-day + first name)
 *   - estate details
 *   - 4 key metrics
 *   - alerts strip
 *   - inventory snapshot
 *   - module tiles (rendered client-side)
 *
 * Some fields (fertilizer next-app date, payroll due, inventory levels) will
 * stay null/empty until the fertilizer + labor modules land. The shape is
 * stable so the Flutter side can render placeholders without breaking.
 */
export async function dashboard(req, res, next) {
  try {
    const [user, plantation] = await Promise.all([
      User.findById(req.user.sub),
      Plantation.findOne({ ownerId: req.user.sub }).sort({ createdAt: -1 }),
    ]);

    if (!user) {
      return res.status(401).json({ error: 'unknown_user' });
    }
    if (!plantation) {
      return res.status(404).json({
        error: 'no_plantation',
        message: 'Complete onboarding before viewing your dashboard.',
      });
    }

    const [plots, workers, nextApplication, inventoryRows] = await Promise.all([
      Plot.find({ plantationId: plantation._id }),
      Worker.find({ plantationId: plantation._id, active: true }),
      FertilizerSchedule.findOne({
        plantationId: plantation._id,
        status: { $in: ['upcoming', 'due'] },
      }).sort({ scheduledDate: 1 }),
      Inventory.find({ plantationId: plantation._id }),
    ]);

    const acresActive = plots.reduce((s, p) => s + p.acres, 0);
    const unionCount = workers.filter((w) => w.type === 'union').length;
    const tempCount = workers.filter((w) => w.type === 'temp').length;

    const weekStart = startOfWeekMonday(new Date());
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
    weekEnd.setUTCHours(23, 59, 59, 999);

    const [payrollDuePaise, weekSpend] = await Promise.all([
      computePayrollDuePaise(plantation._id),
      computeWeekSpendPaise(plantation._id, weekStart, weekEnd),
    ]);

    // Days until the next scheduled application (negative if overdue).
    let daysUntilNextApplication = null;
    if (nextApplication) {
      const msPerDay = 86_400_000;
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      daysUntilNextApplication = Math.ceil(
        (nextApplication.scheduledDate.getTime() - today.getTime()) / msPerDay,
      );
    }

    res.json({
      ok: true,
      greeting: {
        timeOfDay: timeOfDayIST(),
        firstName: firstName(user.fullName),
      },
      estate: {
        id: plantation._id.toString(),
        name: plantation.name,
        district: plantation.district,
        totalAcres: plantation.totalAcres,
        primaryCrop: plantation.primaryCrop,
      },
      metrics: {
        acresActive,
        workersActive: workers.length,
        unionWorkers: unionCount,
        tempWorkers: tempCount,
        daysUntilNextApplication,
        payrollDuePaise,
        weekStart,
        weekEnd,
        weekSpendPaise: weekSpend.totalPaise,
        weekSpendBreakdown: {
          payrollPaise: weekSpend.payrollPaise,
          stockPaise: weekSpend.stockPaise,
          supplyPaise: weekSpend.supplyPaise,
        },
      },
      alerts: await buildAlerts({
        plantationId: plantation._id,
        inventoryRows,
        nextApplication,
        daysUntilNextApplication,
      }),
      inventory: await buildInventorySnapshot(inventoryRows),
      trial: {
        endsAt: user.trialEndsAt,
        plan: user.plan,
      },
    });
  } catch (err) {
    next(err);
  }
}

// ---------- helpers ----------

/** First word of a full name (for greetings). */
function firstName(fullName) {
  if (!fullName) return '';
  return fullName.trim().split(/\s+/)[0];
}

/**
 * Compute the alerts strip from current state. Brief §5.2.1 lists 4 alert
 * types — we wire the ones we can compute today:
 *   - low-stock fertilizer (red)
 *   - overdue fertilizer application (red)
 *   - upcoming application within 3 days (brass)
 * Wage period + bonus alerts come when those modules land.
 */
async function buildAlerts({
  inventoryRows,
  nextApplication,
  daysUntilNextApplication,
}) {
  const alerts = [];

  // Low-stock fertilizers
  const lowRows = inventoryRows.filter((i) => i.quantityGrams < i.lowStockThresholdGrams);
  if (lowRows.length) {
    const ferts = await Fertilizer.find({
      _id: { $in: lowRows.map((r) => r.fertilizerId) },
    });
    const byId = new Map(ferts.map((f) => [f._id.toString(), f]));
    for (const row of lowRows.slice(0, 2)) {
      const f = byId.get(row.fertilizerId.toString());
      const kg = (row.quantityGrams / 1000).toFixed(1);
      alerts.push({
        id: `low-stock-${row._id}`,
        title: `Low stock: ${f?.name ?? 'fertilizer'}`,
        subtitle: `${kg} kg on hand · below reorder level.`,
        severity: 'danger',
        deepLink: '/fertilizer',
      });
    }
  }

  // Overdue / imminent fertilizer application
  if (nextApplication && daysUntilNextApplication != null) {
    if (daysUntilNextApplication < 0) {
      alerts.push({
        id: `overdue-${nextApplication._id}`,
        title: 'Overdue application',
        subtitle: `Was due ${Math.abs(daysUntilNextApplication)} days ago.`,
        severity: 'danger',
        deepLink: '/fertilizer',
      });
    } else if (daysUntilNextApplication <= 3) {
      alerts.push({
        id: `due-soon-${nextApplication._id}`,
        title: `Next application in ${daysUntilNextApplication}d`,
        subtitle: 'Confirm stock and labor are ready.',
        severity: 'warning',
        deepLink: '/fertilizer',
      });
    }
  }

  return alerts;
}

/** Top 4 fertilizers by ratio of quantityOnHand / lowStockThreshold. */
async function buildInventorySnapshot(inventoryRows) {
  if (!inventoryRows.length) {
    return { totalItems: 0, snapshot: [] };
  }
  const ferts = await Fertilizer.find({
    _id: { $in: inventoryRows.map((r) => r.fertilizerId) },
  });
  const byId = new Map(ferts.map((f) => [f._id.toString(), f]));

  const items = inventoryRows.map((r) => {
    const denom = Math.max(r.lowStockThresholdGrams * 4, 1);
    const pct = Math.max(0, Math.min(100, (r.quantityGrams / denom) * 100));
    return {
      fertilizerName:
        byId.get(r.fertilizerId.toString())?.name ?? 'Fertilizer',
      percentRemaining: pct,
    };
  });
  items.sort((a, b) => a.percentRemaining - b.percentRemaining);
  return {
    totalItems: inventoryRows.length,
    snapshot: items.slice(0, 4),
  };
}

/** 'morning' / 'afternoon' / 'evening' in IST. */
function timeOfDayIST() {
  const utc = new Date();
  // IST is UTC+5:30 — shift by 330 minutes.
  const ist = new Date(utc.getTime() + 330 * 60 * 1000);
  const hour = ist.getUTCHours();
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  return 'evening';
}
