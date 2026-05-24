import { Router } from 'express';
import {
  getCategories,
  createCategory,
  updateCategory,
  deleteCategory,
  getProducts,
  createProduct,
  updateProduct,
  deleteProduct,
  adjustStock,
  transferStock,
  getLowStockAlerts,
} from '../controllers/inventoryController';
import { authenticate } from '../middleware/authMiddleware';

const router = Router();

// Apply auth middleware to all inventory routes
router.use(authenticate);

// Category endpoints
router.get('/categories', getCategories);
router.post('/categories', createCategory);
router.put('/categories/:id', updateCategory);
router.delete('/categories/:id', deleteCategory);

// Product endpoints
router.get('/products', getProducts);
router.get('/products/low-stock', getLowStockAlerts);
router.post('/products', createProduct);
router.put('/products/:id', updateProduct);
router.delete('/products/:id', deleteProduct);

// Stock operation endpoints
router.post('/stock/adjust', adjustStock);
router.post('/stock/transfer', transferStock);

export default router;
