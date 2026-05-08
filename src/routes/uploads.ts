import { Router } from 'express';
import multer from 'multer';
import { uploadFile, deleteFile, getPresignedUrl } from '../controllers/uploadController';
import { authenticate } from '../middleware/auth';

const router = Router();

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// All routes require authentication
router.use(authenticate);

// ── Upload file ──
router.post('/', upload.single('file'), uploadFile);

// ── Get presigned URL for direct upload ──
router.post('/presigned', getPresignedUrl);

// ── Delete file ──
router.delete('/:key(*)', deleteFile);

export default router;
