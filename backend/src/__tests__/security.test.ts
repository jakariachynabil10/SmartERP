import { generateAccessToken, verifyAccessToken } from '../utils/jwt';
import { Role } from '@prisma/client';

describe('Security & Authentication Core Tests', () => {
  const mockUser = {
    id: 'user-uuid-1234',
    email: 'cashier@acme.com',
    role: Role.CASHIER,
  };
  const mockTenant = {
    id: 'tenant-uuid-5678',
    name: 'Acme Retailers',
    subDomain: 'acme',
  };

  test('should sign a valid JWT containing user and tenant scopes', () => {
    const token = generateAccessToken({
      userId: mockUser.id,
      tenantId: mockTenant.id,
      role: mockUser.role,
    });
    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
  });

  test('should verify valid JWT and decode token payloads accurately', () => {
    const token = generateAccessToken({
      userId: mockUser.id,
      tenantId: mockTenant.id,
      role: mockUser.role,
    });
    const decoded = verifyAccessToken(token);

    expect(decoded).toBeDefined();
    expect(decoded.userId).toBe(mockUser.id);
    expect(decoded.tenantId).toBe(mockTenant.id);
    expect(decoded.role).toBe(mockUser.role);
  });

  test('should fail validation for malformed token payloads', () => {
    const invalidToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.invalidHeader.invalidSignature';
    expect(() => verifyAccessToken(invalidToken)).toThrow();
  });
});
