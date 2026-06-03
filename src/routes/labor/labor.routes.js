import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  listWorkers,
  createWorker,
  updateWorker,
  getAttendanceByDate,
  upsertAttendance,
  getWeeklyPayroll,
  listWagePeriods,
  createWagePeriod,
  updateWagePeriod,
  listFestivals,
  createFestival,
  deleteFestival,
  markPayrollPaid,
  listBonuses,
  createBonusRule,
  deleteBonusRule,
  logOneOffBonus,
  deleteBonusPayment,
  getYearEndSettlement,
  getGratuityTracker,
} from '../../controllers/labor/labor.controller.js';

const router = Router();
router.use(requireAuth);

// Workers
router.get('/workers', listWorkers);
router.post('/workers', createWorker);
router.patch('/workers/:id', updateWorker);

// Attendance
router.get('/attendance', getAttendanceByDate);
router.post('/attendance', upsertAttendance);

// Payroll
router.get('/payroll/week', getWeeklyPayroll);
router.post('/payroll/mark-paid', markPayrollPaid);

// Wage periods (CGA circular management)
router.get('/wage-periods', listWagePeriods);
router.post('/wage-periods', createWagePeriod);
router.patch('/wage-periods/:id', updateWagePeriod);

// Festival calendar
router.get('/festivals', listFestivals);
router.post('/festivals', createFestival);
router.delete('/festivals/:id', deleteFestival);

// Bonus management
router.get('/bonuses', listBonuses);
router.post('/bonuses/rules', createBonusRule);
router.delete('/bonuses/rules/:id', deleteBonusRule);
router.post('/bonuses/payments', logOneOffBonus);
router.delete('/bonuses/payments/:id', deleteBonusPayment);

// Year-end settlement + gratuity
router.get('/settlement', getYearEndSettlement);
router.get('/gratuity', getGratuityTracker);

export default router;
