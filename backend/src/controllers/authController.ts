import { Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { Role } from '@prisma/client';
import { logger } from '../config/logger';

// Input Validation Schemas
const registerSchema = z.object({
  businessName: z.string().min(2, 'Business name must be at least 2 characters'),
  subDomain: z.string().min(2, 'Subdomain must be at least 2 characters').toLowerCase(),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export const register = async (req: Request, res: Response) => {
  try {
    const body = registerSchema.parse(req.body);

    // Run in a 'bypass' context to verify globally unique fields
    return await tenantStore.run({ tenantId: 'bypass', userId: '', role: '' }, async () => {
      // 1. Check if subDomain already exists
      const existingTenant = await prisma.tenant.findUnique({
        where: { subDomain: body.subDomain },
      });
      if (existingTenant) {
        return res.status(400).json({ error: 'Subdomain is already taken.' });
      }

      // 2. Check if email is registered
      const existingUser = await prisma.user.findUnique({
        where: { email: body.email },
      });
      if (existingUser) {
        return res.status(400).json({ error: 'Email is already registered.' });
      }

      const passwordHash = await bcrypt.hash(body.password, 10);

      // Create Tenant, Warehouse, and User in a transaction
      const result = await prisma.$transaction(async (tx) => {
        const tenant = await tx.tenant.create({
          data: {
            name: body.businessName,
            subDomain: body.subDomain,
          },
        });

        // Set local RLS variable for remainder of tx if needed
        await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenant.id}';`);

        await tx.warehouse.create({
          data: {
            name: 'Main Warehouse',
            location: 'Default Location',
            tenantId: tenant.id,
          },
        });

        const user = await tx.user.create({
          data: {
            email: body.email,
            passwordHash,
            role: Role.BUSINESS_OWNER,
            firstName: body.firstName,
            lastName: body.lastName,
            isVerified: true, // Auto-verify for simplicity in this flow
            tenantId: tenant.id,
          },
        });

        // Setup default CRM customer representing Walk-in Sales
        await tx.customer.create({
          data: {
            name: 'Walk-in Customer',
            phone: '0000000000',
            tenantId: tenant.id,
          },
        });

        return { tenant, user };
      });

      const tokenPayload = {
        userId: result.user.id,
        tenantId: result.tenant.id,
        role: result.user.role,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);

      // Set cookie
      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      });

      logger.info({ tenantId: result.tenant.id, userId: result.user.id }, 'New tenant registered');

      return res.status(201).json({
        message: 'Registration successful',
        accessToken,
        user: {
          id: result.user.id,
          email: result.user.email,
          role: result.user.role,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
        },
        tenant: {
          id: result.tenant.id,
          name: result.tenant.name,
          subDomain: result.tenant.subDomain,
        },
      });
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ errors: error.errors });
    }
    logger.error({ error }, 'Registration error');
    return res.status(500).json({ error: 'Internal server error during registration.' });
  }
};

export const login = async (req: Request, res: Response) => {
  try {
    const body = loginSchema.parse(req.body);

    return await tenantStore.run({ tenantId: 'bypass', userId: '', role: '' }, async () => {
      // Find user
      const user = await prisma.user.findUnique({
        where: { email: body.email },
        include: { tenant: true },
      });

      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Verify password
      const passwordMatch = await bcrypt.compare(body.password, user.passwordHash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      // Check tenant status
      if (user.tenant.status !== 'ACTIVE') {
        return res.status(403).json({ error: 'Account is suspended or deactivated.' });
      }

      const tokenPayload = {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
      };

      const accessToken = generateAccessToken(tokenPayload);
      const refreshToken = generateRefreshToken(tokenPayload);

      res.cookie('refreshToken', refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000,
      });

      // Write an audit log entry for login
      // Run it in user's tenant context
      await tenantStore.run(tokenPayload, async () => {
        await prisma.auditLog.create({
          data: {
            userId: user.id,
            action: 'LOGIN',
            module: 'AUTH',
            details: 'User logged in successfully',
            ipAddress: req.ip,
            tenantId: tokenPayload.tenantId,
          },
        });
      });

      logger.info({ userId: user.id, tenantId: user.tenantId }, 'User logged in');

      return res.json({
        message: 'Login successful',
        accessToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          firstName: user.firstName,
          lastName: user.lastName,
        },
        tenant: {
          id: user.tenant.id,
          name: user.tenant.name,
          subDomain: user.tenant.subDomain,
        },
      });
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ errors: error.errors });
    }
    logger.error({ error }, 'Login error');
    return res.status(500).json({ error: 'Internal server error during login.' });
  }
};

export const refreshToken = async (req: Request, res: Response) => {
  const token = req.cookies?.refreshToken || req.body?.refreshToken;

  if (!token) {
    return res.status(400).json({ error: 'Refresh token is required.' });
  }

  try {
    const payload = verifyRefreshToken(token);

    return await tenantStore.run({ tenantId: 'bypass', userId: '', role: '' }, async () => {
      const user = await prisma.user.findUnique({
        where: { id: payload.userId },
        include: { tenant: true },
      });

      if (!user || user.tenant.status !== 'ACTIVE') {
        return res.status(401).json({ error: 'User not found or tenant inactive.' });
      }

      const newPayload = {
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
      };

      const accessToken = generateAccessToken(newPayload);

      return res.json({ accessToken });
    });
  } catch (error) {
    logger.debug({ error }, 'Token refresh failed');
    return res.status(401).json({ error: 'Invalid or expired refresh token.' });
  }
};

export const logout = async (_req: Request, res: Response) => {
  res.clearCookie('refreshToken');
  return res.json({ message: 'Logged out successfully.' });
};

export const getProfile = async (_req: Request, res: Response) => {
  // Safe since authenticate middleware guarantees user presence and tenant isolation context
  const userContext = tenantStore.getStore();
  if (!userContext) {
    return res.status(401).json({ error: 'Unauthorized context.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: userContext.userId },
      select: {
        id: true,
        email: true,
        role: true,
        firstName: true,
        lastName: true,
        tenant: {
          select: {
            id: true,
            name: true,
            subDomain: true,
            plan: true,
          },
        },
      },
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    return res.json(user);
  } catch (error) {
    logger.error({ error }, 'Get profile error');
    return res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
};
