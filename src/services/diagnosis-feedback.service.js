/**
 * Diagnosis feedback and model-accuracy reporting — Phase 2 spec, Module 01.
 *
 * The spec hands the Griffon team the job of "evaluating model accuracy over
 * time". That is only possible if outcomes are collected from the first day
 * the feature ships, so this is deliberately built before anything reads it.
 *
 * Accuracy here means **treatment outcome**, not diagnostic truth: we never
 * learn what the plant really had, only whether what we told the planter to
 * do fixed it. That is the honest measure, and it is the one a planter
 * cares about.
 */

import { DiagnosisScan } from '../models/DiagnosisScan.js';

/** Days after a scan that we ask "did the treatment work?". */
export const FOLLOW_UP_DAYS = 7;

/** When to ask about a scan taken at [scannedAt]. */
export function followUpInstant(scannedAt) {
  return new Date(scannedAt.getTime() + FOLLOW_UP_DAYS * 86_400_000);
}

/**
 * Outcome → a score we can average. `partial` is deliberately 0.5 rather
 * than being thrown away: "the spray helped but didn't clear it" is real
 * information about a borderline diagnosis.
 */
const OUTCOME_SCORE = { worked: 1, partial: 0.5, failed: 0 };

/**
 * Accuracy rollup across every estate.
 *
 * Grouped by `topDiagnosis`, because an aggregate number hides the only
 * thing worth knowing: *which* diagnoses are unreliable. A model at 85%
 * overall can still be wrong about rhizome rot every single time.
 *
 * @param {object} [opts]
 * @param {Date} [opts.from] inclusive lower bound on scan date
 * @param {Date} [opts.to]   inclusive upper bound
 * @param {number} [opts.minScans] hide diagnoses with fewer than this many
 *   rated scans — a 1-of-1 failure is noise, not a signal
 */
export async function accuracyReport({ from, to, minScans = 1 } = {}) {
  const match = { 'feedback.outcome': { $exists: true, $ne: null } };
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = from;
    if (to) match.createdAt.$lte = to;
  }

  const rows = await DiagnosisScan.aggregate([
    { $match: match },
    {
      $group: {
        _id: { diagnosis: '$topDiagnosis', provider: '$provider' },
        rated: { $sum: 1 },
        worked: {
          $sum: { $cond: [{ $eq: ['$feedback.outcome', 'worked'] }, 1, 0] },
        },
        partial: {
          $sum: { $cond: [{ $eq: ['$feedback.outcome', 'partial'] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ['$feedback.outcome', 'failed'] }, 1, 0] },
        },
        avgConfidence: { $avg: '$confidence' },
        avgLatencyMs: { $avg: '$latencyMs' },
      },
    },
    { $match: { rated: { $gte: minScans } } },
    { $sort: { rated: -1 } },
  ]);

  const byDiagnosis = rows.map((r) => {
    const score =
      (r.worked * OUTCOME_SCORE.worked +
        r.partial * OUTCOME_SCORE.partial +
        r.failed * OUTCOME_SCORE.failed) /
      r.rated;
    return {
      diagnosis: r._id.diagnosis,
      provider: r._id.provider,
      rated: r.rated,
      worked: r.worked,
      partial: r.partial,
      failed: r.failed,
      /** 0..1, where `partial` counts as a half success. */
      successRate: Number(score.toFixed(3)),
      avgConfidence: r.avgConfidence == null ? null : Number(r.avgConfidence.toFixed(3)),
      avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(r.avgLatencyMs),
      /**
       * The number that matters most: the model was confident and still
       * wrong. A high value here means confidence is not calibrated and
       * should not be shown to planters as a trust signal.
       */
      overconfident: r.failed > 0 && (r.avgConfidence ?? 0) >= 0.75,
    };
  });

  // Coverage: feedback is voluntary, so a flattering success rate drawn from
  // 3% of scans means nothing. Report the denominator alongside it.
  const [totals] = await DiagnosisScan.aggregate([
    {
      $match:
        from || to
          ? { createdAt: match.createdAt }
          : {},
    },
    {
      $group: {
        _id: null,
        scans: { $sum: 1 },
        treatmentTaken: { $sum: { $cond: ['$treatmentTaken', 1, 0] } },
        rated: {
          $sum: {
            $cond: [{ $ifNull: ['$feedback.outcome', false] }, 1, 0],
          },
        },
      },
    },
  ]);

  const scans = totals?.scans ?? 0;
  const rated = totals?.rated ?? 0;
  const overallRated = byDiagnosis.reduce((n, d) => n + d.rated, 0);
  const overallScore =
    overallRated === 0
      ? null
      : Number(
          (
            byDiagnosis.reduce((sum, d) => sum + d.successRate * d.rated, 0) /
            overallRated
          ).toFixed(3),
        );

  return {
    window: { from: from ?? null, to: to ?? null },
    coverage: {
      scans,
      treatmentTaken: totals?.treatmentTaken ?? 0,
      rated,
      /** Share of scans with an outcome. Below ~0.2 treat rates as anecdote. */
      feedbackRate: scans === 0 ? null : Number((rated / scans).toFixed(3)),
    },
    overallSuccessRate: overallScore,
    byDiagnosis,
  };
}

// ---------- repeat-diagnosis detection (Phase 2 spec, Module 01) ----------

/** A repeat inside this window is treated as the same ongoing problem. */
export const RECURRENCE_WINDOW_DAYS = 30;

/**
 * Has this diagnosis already been made for this plot recently?
 *
 * Spec: "if same disease diagnosed in same plot within 30 days, shows a
 * 'recurring issue' warning". A recurrence usually means the first
 * treatment failed or the cause is environmental — waterlogging, shade,
 * drainage — rather than something another spray will fix.
 *
 * Runs on the index { plantationId, plotId, topDiagnosis, createdAt }.
 *
 * @param {object} args
 * @param {import('mongoose').Types.ObjectId} args.plantationId
 * @param {import('mongoose').Types.ObjectId|null} args.plotId
 * @param {string} args.topDiagnosis
 * @param {import('mongoose').Types.ObjectId} [args.excludeScanId] the scan
 *   just created, which would otherwise match itself
 * @returns {Promise<{isRecurring: boolean, priorCount: number,
 *   lastSeenAt: Date|null, lastTreatmentTaken: boolean,
 *   lastOutcome: string|null}>}
 */
export async function detectRecurrence({
  plantationId,
  plotId = null,
  topDiagnosis,
  excludeScanId = null,
  now = new Date(),
}) {
  const none = {
    isRecurring: false,
    priorCount: 0,
    lastSeenAt: null,
    lastTreatmentTaken: false,
    lastOutcome: null,
  };

  // "Image unclear" is not a disease — repeats of it mean bad photos, not a
  // recurring problem, and warning about it would be noise.
  if (!topDiagnosis || /^image unclear/i.test(topDiagnosis)) return none;

  const since = new Date(now.getTime() - RECURRENCE_WINDOW_DAYS * 86_400_000);
  const query = {
    plantationId,
    plotId,
    topDiagnosis,
    createdAt: { $gte: since },
  };
  if (excludeScanId) query._id = { $ne: excludeScanId };

  const [priorCount, last] = await Promise.all([
    DiagnosisScan.countDocuments(query),
    DiagnosisScan.findOne(query)
      .sort({ createdAt: -1 })
      .select('createdAt treatmentTaken feedback'),
  ]);

  if (priorCount === 0) return none;

  return {
    isRecurring: true,
    priorCount,
    lastSeenAt: last?.createdAt ?? null,
    lastTreatmentTaken: last?.treatmentTaken ?? false,
    lastOutcome: last?.feedback?.outcome ?? null,
  };
}

// ---------- treatment → fertilizer schedule (Phase 2 spec, Module 01) ----------

/**
 * Best-effort kg/acre from a dose string like
 * "1.5 kg copper oxychloride in 400 L water" → 1.5.
 *
 * Returns null when the dose is not expressed by weight — crop-protection
 * products are often dosed by concentration ("2 ml per litre"), which has no
 * kg/acre equivalent without knowing the spray volume. The caller then asks
 * the planter for a quantity instead of inventing one.
 */
export function parsePerAcreKg(doseText) {
  if (!doseText) return null;
  // Weight only, and only before the water volume: "400 L water" is not a dose.
  const kg = /(\d+(?:\.\d+)?)\s*kg\b/i.exec(doseText);
  if (kg) return Number(kg[1]);
  const g = /(\d+(?:\.\d+)?)\s*(?:g|gm|gram)\b/i.exec(doseText);
  if (g) return Number(g[1]) / 1000;
  return null;
}

/**
 * Pick the application method the schedule should use, from how the
 * treatment describes itself. Falls back to the schedule's own default.
 */
export function inferApplicationMethod(treatment) {
  const text = `${treatment?.summary ?? ''} ${treatment?.doseringPerAcre ?? ''} ${treatment?.schedule ?? ''}`.toLowerCase();
  if (/drench|soil application|around the rhizome/.test(text)) return 'soil-drench';
  if (/foliar|spray/.test(text)) return 'foliar-spray';
  if (/fertigation|through irrigation/.test(text)) return 'fertigation';
  return 'broadcasting';
}
