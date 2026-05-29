import { Router } from 'express';
import { Role } from '@prisma/client';
import { authenticate, requireRole } from '../middleware/authMiddleware';
import {
  getEmployees,
  getEmployeeById,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  clockIn,
  clockOut,
  getAttendanceLogs,
  createLeaveRequest,
  getLeaveRequests,
  updateLeaveStatus,
} from '../controllers/hrController';

const router = Router();

// Apply JWT authentication globally for all HR routes
router.use(authenticate);

// ---------------------------------------------------------
// Employee Management Routes
// ---------------------------------------------------------

// Anyone authenticated can read employees (non-managers get scrubbed salary data)
router.get('/employees', getEmployees);
router.get('/employees/:id', getEmployeeById);

// CUD operations restricted to administrators, business owners, and managers
const managerRoles = [Role.SUPER_ADMIN, Role.BUSINESS_OWNER, Role.MANAGER];

router.post('/employees', requireRole(managerRoles), createEmployee);
router.put('/employees/:id', requireRole(managerRoles), updateEmployee);
router.delete('/employees/:id', requireRole(managerRoles), deleteEmployee);

// ---------------------------------------------------------
// Attendance (Clock-in/out) Routes
// ---------------------------------------------------------

router.post('/attendance/clock-in', clockIn);
router.post('/attendance/clock-out', clockOut);
router.get('/attendance', getAttendanceLogs);

// ---------------------------------------------------------
// Leave Requests Routes
// ---------------------------------------------------------

router.post('/leaves', createLeaveRequest);
router.get('/leaves', getLeaveRequests);

// Only administrators, business owners, and managers can update leave status (approve/reject)
router.patch('/leaves/:id/status', requireRole(managerRoles), updateLeaveStatus);

export default router;
