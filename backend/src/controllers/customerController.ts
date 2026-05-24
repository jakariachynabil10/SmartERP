import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/prismaClient';
import { tenantStore } from '../config/tenantStore';
import { logger } from '../config/logger';

const customerSchema = z.object({
  name: z.string().min(1, 'Customer name is required'),
  phone: z.string().optional().nullable(),
  email: z.string().email('Invalid email').optional().nullable().or(z.literal('')),
  address: z.string().optional().nullable(),
  loyaltyPoints: z.coerce.number().int().default(0),
});

export const getCustomers = async (req: Request, res: Response) => {
  try {
    const { search } = req.query;
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search as string, mode: 'insensitive' } },
        { phone: { contains: search as string, mode: 'insensitive' } },
        { email: { contains: search as string, mode: 'insensitive' } },
      ];
    }
    const customers = await prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
    });
    return res.json(customers);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch customers');
    return res.status(500).json({ error: 'Failed to fetch customers.' });
  }
};

export const getCustomerById = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const customer = await prisma.customer.findUnique({
      where: { id },
      include: {
        sales: {
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found.' });
    }
    return res.json(customer);
  } catch (error) {
    logger.error({ error }, 'Failed to fetch customer profile');
    return res.status(500).json({ error: 'Failed to fetch customer profile.' });
  }
};

export const createCustomer = async (req: Request, res: Response) => {
  const userContext = tenantStore.getStore();
  if (!userContext) return res.status(401).json({ error: 'Unauthorized context' });

  try {
    const parsed = customerSchema.parse(req.body);
    const emailValue = parsed.email || null;
    const customer = await prisma.customer.create({
      data: {
        name: parsed.name,
        phone: parsed.phone,
        email: emailValue,
        address: parsed.address,
        loyaltyPoints: parsed.loyaltyPoints,
        tenantId: userContext.tenantId,
      },
    });
    return res.status(201).json(customer);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to create customer');
    return res.status(500).json({ error: 'Customer with this phone number already exists.' });
  }
};

export const updateCustomer = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const parsed = customerSchema.partial().parse(req.body);
    const emailValue = parsed.email === '' ? null : parsed.email || undefined;
    const customer = await prisma.customer.update({
      where: { id },
      data: {
        name: parsed.name,
        phone: parsed.phone,
        email: emailValue,
        address: parsed.address,
        loyaltyPoints: parsed.loyaltyPoints,
      },
    });
    return res.json(customer);
  } catch (error) {
    if (error instanceof z.ZodError) return res.status(400).json({ errors: error.errors });
    logger.error({ error }, 'Failed to update customer');
    return res.status(500).json({ error: 'Failed to update customer.' });
  }
};

export const deleteCustomer = async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    // Prevent deleting Walk-in customer since POS relies on it
    const customer = await prisma.customer.findUnique({ where: { id } });
    if (customer && customer.name === 'Walk-in Customer') {
      return res.status(400).json({ error: 'Cannot delete default Walk-in Customer.' });
    }
    await prisma.customer.delete({ where: { id } });
    return res.json({ message: 'Customer deleted successfully.' });
  } catch (error) {
    logger.error({ error }, 'Failed to delete customer');
    return res.status(500).json({ error: 'Failed to delete customer.' });
  }
};
