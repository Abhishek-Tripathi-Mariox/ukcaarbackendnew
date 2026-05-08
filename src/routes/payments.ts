import { Router } from 'express';
import {
  getPayments,
  getWallet,
  topUpWallet,
  createOrder,
  verifyPayment,
  razorpayWebhook,
  checkoutPage,
  checkoutCallback,
  validatePromo,
  getDriverEarnings,
  getSavedMethods,
  addSavedMethod,
  deleteSavedMethod,
  setDefaultMethod,
} from '../controllers/paymentController';
import { authenticate, authorize } from '../middleware/auth';

const router = Router();

// Public routes (no auth)
router.post('/webhook', razorpayWebhook);
router.get('/checkout', checkoutPage);
router.get('/checkout/callback', checkoutCallback);

// Protected routes
router.use(authenticate);

router.get('/', getPayments);
router.get('/wallet', getWallet);
router.post('/wallet/topup', topUpWallet);
router.post('/create-order', createOrder);
router.post('/verify-payment', verifyPayment);
router.post('/promo/validate', validatePromo);

// Saved payment methods
router.get('/methods', getSavedMethods);
router.post('/methods', addSavedMethod);
router.delete('/methods/:id', deleteSavedMethod);
router.put('/methods/:id/default', setDefaultMethod);

router.get('/driver/summary', authorize('driver'), getDriverEarnings);

export default router;
