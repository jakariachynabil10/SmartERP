import { Router } from 'express';
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  getPurchaseOrders,
  createPurchaseOrder,
  updatePurchaseOrderStatus,
} from '../controllers/supplierController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

router.use(authenticate);

// Supplier CRUD
router.get('/', getSuppliers);
router.post('/', createSupplier);
router.put('/:id', updateSupplier);
router.delete('/:id', deleteSupplier);

// Procurement Purchase Orders
router.get('/orders', getPurchaseOrders);
router.post('/orders', createPurchaseOrder);
router.put('/orders/:id/status', updatePurchaseOrderStatus);

export default router;
