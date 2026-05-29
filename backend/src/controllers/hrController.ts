import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

// ---------------------------------------------------------
// Input Validation Schemas
// ---------------------------------------------------------

const employeeSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Invalid email address'),
  phone: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
  salary: z.coerce.number().min(0, 'Salary must be at least 0').default(0),
  joiningDate: z.string().optional().transform((val) => val ? new Date(val) : new Date()),
  userId: z.string().uuid('Invalid user ID').optional().nullable(),
});

const clockInSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID').optional(),
});

const leaveRequestSchema = z.object({
  employeeId: z.string().uuid('Invalid employee ID').optional(),
  startDate: z.string().transform((val) => new Date(val)),
  endDate: z.string().transform((val) => new Date(val)),
  type: z.string().min(1, 'Leave type is required'),
  reason: z.string().optional().nullable(),
});

const leaveStatusSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED'], {
    errorMap: () => ({ message: 'Status must be APPROVED or REJECTED' }),
  }),
});

// Helper: Check if user is a privileged manager/owner/admin
const isPrivilegedUser = (role: string) => {
  return ['SUPER_ADMIN', 'BUSINESS_OWNER', 'MANAGER'].includes(role);
};

// Helper: Find employee ID for a user ID
const findEmployeeIdByUserId = async (userId: string) => {
  const employee = await prisma.employee.findUnique({
    where: { userId },
  });
  return employee?.id || null;
};

// ---------------------------------------------------------
// Employee Controllers
// ---------------------------------------------------------

export const getEmployees = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { search } = req.query;
    const where: any = {};

    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
        { department: { contains: search as string, mode: 'insensitive' } },
        { designation: { contains: search as string, mode: 'insensitive' } },
      ];
    }

    const employees = await prisma.employee.findMany({
      where,
      orderBy: { name: 'asc' },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            firstName: true,
            lastName: true,
          },
        },
      },
    });

    // Premium feature: Scrub salary information for non-managers
    const isPrivileged = isPrivilegedUser(userContext.role);
    const scrubbedEmployees = employees.map((emp) => {
      const { salary, ...rest } = emp;
      return isPrivileged ? emp : rest;
    });

    return res.json(scrubbedEmployees);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch employees');
    return res.status(500).json({ error: 'Failed to fetch employees.' });
  }
};

export const getEmployeeById = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  const { id } = req.params;

  try {
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            firstName: true,
            lastName: true,
          },
        },
        attendance: {
          orderBy: { date: 'desc' },
          take: 10,
        },
        leaves: {
          orderBy: { startDate: 'desc' },
          take: 10,
        },
      },
    });

    if (!employee) {
      return res.status(404).json({ error: 'Employee not found.' });
    }

    // Role-based validation: Normal users can only view their own detailed employee card
    const isPrivileged = isPrivilegedUser(userContext.role);
    if (!isPrivileged && employee.userId !== userContext.userId) {
      return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
    }

    // Scrub salary if not privileged
    if (!isPrivileged) {
      const { salary, ...rest } = employee;
      return res.json(rest);
    }

    return res.json(employee);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch employee by ID');
    return res.status(500).json({ error: 'Failed to fetch employee details.' });
  }
};

export const createEmployee = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = employeeSchema.parse(req.body);

    // Validate unique userId link if provided
    if (parsed.userId) {
      const userExists = await prisma.user.findUnique({
        where: { id: parsed.userId },
      });
      if (!userExists) {
        return res.status(404).json({ error: 'Associated user account not found.' });
      }

      const existingEmployee = await prisma.employee.findUnique({
        where: { userId: parsed.userId },
      });
      if (existingEmployee) {
        return res.status(400).json({ error: 'User is already linked to another employee.' });
      }
    }

    const employee = await prisma.employee.create({
      data: {
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        department: parsed.department,
        designation: parsed.designation,
        salary: parsed.salary,
        joiningDate: parsed.joiningDate,
        userId: parsed.userId,
        tenantId: userContext.tenantId,
      },
    });

    return res.status(201).json(employee);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create employee');
    return res.status(500).json({ error: 'Failed to create employee.' });
  }
};

export const updateEmployee = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  const { id } = req.params;

  try {
    const parsed = employeeSchema.partial().parse(req.body);

    // Validate unique userId link if provided and being updated
    if (parsed.userId) {
      const userExists = await prisma.user.findUnique({
        where: { id: parsed.userId },
      });
      if (!userExists) {
        return res.status(404).json({ error: 'Associated user account not found.' });
      }

      const existingEmployee = await prisma.employee.findUnique({
        where: { userId: parsed.userId },
      });
      if (existingEmployee && existingEmployee.id !== id) {
        return res.status(400).json({ error: 'User is already linked to another employee.' });
      }
    }

    const employee = await prisma.employee.update({
      where: { id },
      data: {
        name: parsed.name,
        email: parsed.email,
        phone: parsed.phone,
        department: parsed.department,
        designation: parsed.designation,
        salary: parsed.salary,
        joiningDate: parsed.joiningDate,
        userId: parsed.userId,
      },
    });

    return res.json(employee);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update employee');
    return res.status(500).json({ error: 'Failed to update employee.' });
  }
};

export const deleteEmployee = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    await prisma.employee.delete({
      where: { id },
    });
    return res.json({ message: 'Employee deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete employee');
    return res.status(500).json({ error: 'Failed to delete employee.' });
  }
};

// ---------------------------------------------------------
// Attendance Controllers
// ---------------------------------------------------------

export const clockIn = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = clockInSchema.parse(req.body);
    let employeeId = parsed.employeeId;

    // Permissions: managers can clock in any employee; normal staff can only clock in themselves
    if (employeeId) {
      if (!isPrivilegedUser(userContext.role)) {
        return res.status(403).json({ error: 'Forbidden. Insufficient permissions to clock in other employees.' });
      }
    } else {
      const resolvedId = await findEmployeeIdByUserId(userContext.userId);
      if (!resolvedId) {
        return res.status(400).json({ error: 'No employee profile associated with your user account. Please contact an admin.' });
      }
      employeeId = resolvedId;
    }

    // Prevent duplicate clock-in for the same calendar date
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    const existingAttendance = await prisma.attendance.findFirst({
      where: {
        employeeId,
        date: {
          gte: startOfToday,
          lte: endOfToday,
        },
      },
    });

    if (existingAttendance) {
      return res.status(400).json({ error: 'Already clocked in for today.' });
    }

    const attendance = await prisma.attendance.create({
      data: {
        employeeId,
        date: new Date(),
        status: 'PRESENT',
        checkIn: new Date(),
        tenantId: userContext.tenantId,
      },
    });

    return res.status(201).json(attendance);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to clock in');
    return res.status(500).json({ error: 'Failed to clock in.' });
  }
};

export const clockOut = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = clockInSchema.parse(req.body); // reuse employeeId optional schema
    let employeeId = parsed.employeeId;

    if (employeeId) {
      if (!isPrivilegedUser(userContext.role)) {
        return res.status(403).json({ error: 'Forbidden. Insufficient permissions to clock out other employees.' });
      }
    } else {
      const resolvedId = await findEmployeeIdByUserId(userContext.userId);
      if (!resolvedId) {
        return res.status(400).json({ error: 'No employee profile associated with your user account.' });
      }
      employeeId = resolvedId;
    }

    // Find the latest active clock-in session (where checkOut is null)
    const activeSession = await prisma.attendance.findFirst({
      where: {
        employeeId,
        checkOut: null,
      },
      orderBy: { date: 'desc' },
    });

    if (!activeSession) {
      return res.status(400).json({ error: 'No active clock-in session found for this employee.' });
    }

    const attendance = await prisma.attendance.update({
      where: { id: activeSession.id },
      data: {
        checkOut: new Date(),
      },
    });

    return res.json(attendance);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to clock out');
    return res.status(500).json({ error: 'Failed to clock out.' });
  }
};

export const getAttendanceLogs = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { employeeId, startDate, endDate } = req.query;
    const isPrivileged = isPrivilegedUser(userContext.role);
    let targetEmployeeId = employeeId as string | undefined;

    // Normal staff are forced to view only their own logs
    if (!isPrivileged) {
      const resolvedId = await findEmployeeIdByUserId(userContext.userId);
      if (!resolvedId) {
        return res.status(400).json({ error: 'No employee profile associated with your user account.' });
      }
      targetEmployeeId = resolvedId;
    }

    const where: any = {};
    if (targetEmployeeId) {
      where.employeeId = targetEmployeeId;
    }

    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        where.date.gte = new Date(startDate as string);
      }
      if (endDate) {
        where.date.lte = new Date(endDate as string);
      }
    }

    const logs = await prisma.attendance.findMany({
      where,
      orderBy: { date: 'desc' },
      include: {
        employee: {
          select: {
            name: true,
            email: true,
            department: true,
          },
        },
      },
    });

    return res.json(logs);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch attendance logs');
    return res.status(500).json({ error: 'Failed to fetch attendance logs.' });
  }
};

// ---------------------------------------------------------
// Leave Requests Controllers
// ---------------------------------------------------------

export const createLeaveRequest = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = leaveRequestSchema.parse(req.body);
    let employeeId = parsed.employeeId;

    if (employeeId) {
      if (!isPrivilegedUser(userContext.role)) {
        return res.status(403).json({ error: 'Forbidden. Insufficient permissions to request leave for other employees.' });
      }
    } else {
      const resolvedId = await findEmployeeIdByUserId(userContext.userId);
      if (!resolvedId) {
        return res.status(400).json({ error: 'No employee profile associated with your user account.' });
      }
      employeeId = resolvedId;
    }

    // Ensure start date is before or equal to end date
    if (parsed.startDate > parsed.endDate) {
      return res.status(400).json({ error: 'Start date cannot be after end date.' });
    }

    const leaveRequest = await prisma.leaveRequest.create({
      data: {
        employeeId,
        startDate: parsed.startDate,
        endDate: parsed.endDate,
        type: parsed.type,
        reason: parsed.reason,
        status: 'PENDING',
        tenantId: userContext.tenantId,
      },
    });

    return res.status(201).json(leaveRequest);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create leave request');
    return res.status(500).json({ error: 'Failed to request leave.' });
  }
};

export const getLeaveRequests = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const { employeeId, status } = req.query;
    const isPrivileged = isPrivilegedUser(userContext.role);
    let targetEmployeeId = employeeId as string | undefined;

    // Normal staff are forced to view only their own requests
    if (!isPrivileged) {
      const resolvedId = await findEmployeeIdByUserId(userContext.userId);
      if (!resolvedId) {
        return res.status(400).json({ error: 'No employee profile associated with your user account.' });
      }
      targetEmployeeId = resolvedId;
    }

    const where: any = {};
    if (targetEmployeeId) {
      where.employeeId = targetEmployeeId;
    }
    if (status) {
      where.status = status as string;
    }

    const leaves = await prisma.leaveRequest.findMany({
      where,
      orderBy: { startDate: 'desc' },
      include: {
        employee: {
          select: {
            name: true,
            email: true,
            department: true,
          },
        },
      },
    });

    return res.json(leaves);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch leave requests');
    return res.status(500).json({ error: 'Failed to fetch leave requests.' });
  }
};

export const updateLeaveStatus = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  // Only manager or admin roles can update status
  if (!isPrivilegedUser(userContext.role)) {
    return res.status(403).json({ error: 'Forbidden. Insufficient permissions.' });
  }

  const { id } = req.params;

  try {
    const parsed = leaveStatusSchema.parse(req.body);

    const leaveRequest = await prisma.leaveRequest.findUnique({
      where: { id },
    });

    if (!leaveRequest) {
      return res.status(404).json({ error: 'Leave request not found.' });
    }

    const updated = await prisma.leaveRequest.update({
      where: { id },
      data: {
        status: parsed.status,
      },
    });

    return res.json(updated);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update leave request status');
    return res.status(500).json({ error: 'Failed to update leave request status.' });
  }
};
