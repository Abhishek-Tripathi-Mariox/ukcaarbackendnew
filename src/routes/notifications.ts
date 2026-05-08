import { Router } from 'express';
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  clearAll,
} from '../controllers/notificationController';
import { registerFcmToken, unregisterFcmToken } from '../controllers/fcmController';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.post('/fcm-token', registerFcmToken);
router.delete('/fcm-token', unregisterFcmToken);

router.get('/', getNotifications);
router.put('/read-all', markAllAsRead);
router.put('/:id/read', markAsRead);
router.delete('/:id', deleteNotification);
router.delete('/', clearAll);

export default router;
