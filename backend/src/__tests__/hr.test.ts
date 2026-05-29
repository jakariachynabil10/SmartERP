import request from 'supertest';
import app from '../app';
import { prisma } from '../config/prismaClient';
import { generateAccessToken } from '../utils/jwt';
import { Role } from '@prisma/client';
import { tenantStore } from '../config/tenantStore';

describe('HR Module & Multi-Tenant API Tests', () => {
  let tenant1Id: string;
  let tenant2Id: string;

  let manager1Id: string;
  let staff1Id: string;
  let staff2Id: string;

  let managerToken: string;
  let staff1Token: string;
  let staff2Token: string;

  let employee1Id: string; // manager1's employee record
  let employee2Id: string; // staff1's employee record
  let employee3Id: string; // tenant2 staff's employee record

  beforeAll(async () => {
    // We run the setups inside the 'bypass' tenantStore context so Prisma client lets us seed test data freely
    await new Promise<void>((resolve, reject) => {
      tenantStore.run(
        { tenantId: 'bypass', userId: 'test-setup-admin', role: 'SUPER_ADMIN' },
        async () => {
          try {
            // Clean up any lingering test records
            await prisma.leaveRequest.deleteMany({ where: { employee: { email: { contains: '@test-hr' } } } });
            await prisma.attendance.deleteMany({ where: { employee: { email: { contains: '@test-hr' } } } });
            await prisma.employee.deleteMany({ where: { email: { contains: '@test-hr' } } });
            await prisma.user.deleteMany({ where: { email: { contains: '@test-hr' } } });
            await prisma.tenant.deleteMany({ where: { subDomain: { in: ['test-hr-tenant-1', 'test-hr-tenant-2'] } } });

            // Create Tenant 1
            const tenant1 = await prisma.tenant.create({
              data: {
                name: 'Test HR Tenant 1',
                subDomain: 'test-hr-tenant-1',
              },
            });
            tenant1Id = tenant1.id;

            // Create Tenant 2 (for isolation testing)
            const tenant2 = await prisma.tenant.create({
              data: {
                name: 'Test HR Tenant 2',
                subDomain: 'test-hr-tenant-2',
              },
            });
            tenant2Id = tenant2.id;

            // Create Users for Tenant 1
            const managerUser = await prisma.user.create({
              data: {
                email: 'manager@test-hr-1.com',
                passwordHash: 'hashedpassword',
                role: Role.BUSINESS_OWNER,
                firstName: 'HR',
                lastName: 'Manager',
                tenantId: tenant1Id,
              },
            });
            manager1Id = managerUser.id;

            const staff1User = await prisma.user.create({
              data: {
                email: 'staff@test-hr-1.com',
                passwordHash: 'hashedpassword',
                role: Role.STAFF,
                firstName: 'John',
                lastName: 'Staff',
                tenantId: tenant1Id,
              },
            });
            staff1Id = staff1User.id;

            // Create Users for Tenant 2
            const staff2User = await prisma.user.create({
              data: {
                email: 'staff@test-hr-2.com',
                passwordHash: 'hashedpassword',
                role: Role.STAFF,
                firstName: 'Alice',
                lastName: 'Staff2',
                tenantId: tenant2Id,
              },
            });
            staff2Id = staff2User.id;

            // Generate JWT Tokens
            managerToken = generateAccessToken({
              userId: manager1Id,
              tenantId: tenant1Id,
              role: Role.BUSINESS_OWNER,
            });

            staff1Token = generateAccessToken({
              userId: staff1Id,
              tenantId: tenant1Id,
              role: Role.STAFF,
            });

            staff2Token = generateAccessToken({
              userId: staff2Id,
              tenantId: tenant2Id,
              role: Role.STAFF,
            });

            // Create Employee Profiles
            const emp1 = await prisma.employee.create({
              data: {
                name: 'HR Manager',
                email: 'manager@test-hr-1.com',
                salary: 5000,
                department: 'Management',
                designation: 'Director',
                userId: manager1Id,
                tenantId: tenant1Id,
              },
            });
            employee1Id = emp1.id;

            const emp2 = await prisma.employee.create({
              data: {
                name: 'John Staff',
                email: 'staff@test-hr-1.com',
                salary: 2000,
                department: 'Sales',
                designation: 'Representative',
                userId: staff1Id,
                tenantId: tenant1Id,
              },
            });
            employee2Id = emp2.id;

            const emp3 = await prisma.employee.create({
              data: {
                name: 'Alice Staff2',
                email: 'staff@test-hr-2.com',
                salary: 2200,
                department: 'Support',
                designation: 'Agent',
                userId: staff2Id,
                tenantId: tenant2Id,
              },
            });
            employee3Id = emp3.id;

            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      tenantStore.run(
        { tenantId: 'bypass', userId: 'test-setup-admin', role: 'SUPER_ADMIN' },
        async () => {
          try {
            await prisma.leaveRequest.deleteMany({ where: { employee: { email: { contains: '@test-hr' } } } });
            await prisma.attendance.deleteMany({ where: { employee: { email: { contains: '@test-hr' } } } });
            await prisma.employee.deleteMany({ where: { email: { contains: '@test-hr' } } });
            await prisma.user.deleteMany({ where: { email: { contains: '@test-hr' } } });
            await prisma.tenant.deleteMany({ where: { subDomain: { in: ['test-hr-tenant-1', 'test-hr-tenant-2'] } } });
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      );
    });
  });

  describe('Employee Directory CRUD & Role Protections', () => {
    test('Manager can successfully view all employees and see salaries', async () => {
      const res = await request(app)
        .get('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const john = res.body.find((e: any) => e.email === 'staff@test-hr-1.com');
      expect(john).toBeDefined();
      expect(john.salary).toBe(2000);
    });

    test('Staff can view employees but cannot see salary info (premium scrub feature)', async () => {
      const res = await request(app)
        .get('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const john = res.body.find((e: any) => e.email === 'staff@test-hr-1.com');
      expect(john).toBeDefined();
      expect(john.salary).toBeUndefined(); // Scrubbed
    });

    test('Manager can create an employee profile successfully', async () => {
      const newEmpBody = {
        name: 'New Recruited Employee',
        email: 'new-recruit@test-hr-1.com',
        department: 'Engineering',
        designation: 'Developer',
        salary: 4000,
      };

      const res = await request(app)
        .post('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${managerToken}`)
        .send(newEmpBody);

      expect(res.status).toBe(201);
      expect(res.body.name).toBe(newEmpBody.name);
      expect(res.body.tenantId).toBe(tenant1Id);
    });

    test('Staff is Forbidden (403) from creating employee profiles', async () => {
      const newEmpBody = {
        name: 'Hacker Employee',
        email: 'hacker@test-hr-1.com',
      };

      const res = await request(app)
        .post('/api/v1/hr/employees')
        .set('Authorization', `Bearer ${staff1Token}`)
        .send(newEmpBody);

      expect(res.status).toBe(403);
    });

    test('Manager can fetch specific employee with attendance and leaves metadata', async () => {
      const res = await request(app)
        .get(`/api/v1/hr/employees/${employee2Id}`)
        .set('Authorization', `Bearer ${managerToken}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(employee2Id);
      expect(res.body.salary).toBe(2000);
      expect(res.body.attendance).toBeDefined();
      expect(res.body.leaves).toBeDefined();
    });

    test('Staff can fetch their own detailed employee card but without salary', async () => {
      const res = await request(app)
        .get(`/api/v1/hr/employees/${employee2Id}`)
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(employee2Id);
      expect(res.body.salary).toBeUndefined(); // Scrubbed
    });

    test('Staff is Forbidden (403) from fetching another employee\'s detail card', async () => {
      const res = await request(app)
        .get(`/api/v1/hr/employees/${employee1Id}`)
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(403);
    });
  });

  describe('Attendance Tracker (Clock-in / Clock-out)', () => {
    test('Staff can clock in successfully', async () => {
      const res = await request(app)
        .post('/api/v1/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(201);
      expect(res.body.employeeId).toBe(employee2Id);
      expect(res.body.checkIn).toBeDefined();
      expect(res.body.status).toBe('PRESENT');
    });

    test('Duplicate clock-in on the same day is blocked (400)', async () => {
      const res = await request(app)
        .post('/api/v1/hr/attendance/clock-in')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Already clocked in for today.');
    });

    test('Staff can clock out successfully', async () => {
      const res = await request(app)
        .post('/api/v1/hr/attendance/clock-out')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.checkOut).toBeDefined();
    });

    test('Clock out again without active clock-in session is blocked (400)', async () => {
      const res = await request(app)
        .post('/api/v1/hr/attendance/clock-out')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('No active clock-in session found for this employee.');
    });
  });

  describe('Leave Request Workflows', () => {
    let leaveRequestId: string;

    test('Staff can submit a valid leave request', async () => {
      const leaveBody = {
        startDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), // Tomorrow
        endDate: new Date(Date.now() + 172800000).toISOString().slice(0, 10), // Day after tomorrow
        type: 'SICK',
        reason: 'Under the weather',
      };

      const res = await request(app)
        .post('/api/v1/hr/leaves')
        .set('Authorization', `Bearer ${staff1Token}`)
        .send(leaveBody);

      expect(res.status).toBe(201);
      expect(res.body.employeeId).toBe(employee2Id);
      expect(res.body.status).toBe('PENDING');
      leaveRequestId = res.body.id;
    });

    test('Submitting leave with invalid dates is blocked (400)', async () => {
      const leaveBody = {
        startDate: '2026-06-10',
        endDate: '2026-06-05', // Start after end
        type: 'ANNUAL',
        reason: 'Holiday',
      };

      const res = await request(app)
        .post('/api/v1/hr/leaves')
        .set('Authorization', `Bearer ${staff1Token}`)
        .send(leaveBody);

      expect(res.status).toBe(400);
    });

    test('Manager can approve a pending leave request', async () => {
      const res = await request(app)
        .patch(`/api/v1/hr/leaves/${leaveRequestId}/status`)
        .set('Authorization', `Bearer ${managerToken}`)
        .send({ status: 'APPROVED' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('APPROVED');
    });

    test('Staff is Forbidden (403) from approving or rejecting leave requests', async () => {
      const res = await request(app)
        .patch(`/api/v1/hr/leaves/${leaveRequestId}/status`)
        .set('Authorization', `Bearer ${staff1Token}`)
        .send({ status: 'REJECTED' });

      expect(res.status).toBe(403);
    });
  });

  describe('Multi-Tenant Isolation Safeguards', () => {
    test('Staff of Tenant 1 cannot fetch employee roster or leave requests of Tenant 2', async () => {
      // Let's verify that when Tenant 1 staff queries leave requests, they ONLY see Tenant 1 records.
      // We will check that the response contains John's record, but NOT Alice's record.
      const res = await request(app)
        .get('/api/v1/hr/leaves')
        .set('Authorization', `Bearer ${staff1Token}`);

      expect(res.status).toBe(200);
      const aliceLeaves = res.body.filter((leave: any) => leave.employeeId === employee3Id);
      expect(aliceLeaves.length).toBe(0);
    });

    test('Tenant 2 staff cannot fetch Tenant 1 employees via specific ID request', async () => {
      const res = await request(app)
        .get(`/api/v1/hr/employees/${employee2Id}`)
        .set('Authorization', `Bearer ${staff2Token}`);

      // Should return 404 (Prisma extension fails to find record within Tenant 2 context)
      // or 403. Let's make sure it handles finding unique within Tenant 2.
      // In prismaClient, findUnique delegates to findFirst with { where: { id, tenantId } }
      // This means a cross-tenant id look-up will return null, which yields 404 Not Found.
      expect(res.status).toBe(404);
    });
  });
});
