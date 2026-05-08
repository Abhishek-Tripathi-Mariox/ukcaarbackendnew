import { Router } from 'express';
import { getChat, sendMessage } from '../controllers/chatController';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);

router.get('/:rideId', getChat);
router.post('/:rideId/message', sendMessage);

export default router;
