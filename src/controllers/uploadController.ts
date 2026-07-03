import { Response } from 'express';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import { config } from '../config';
import { User } from '../models';
import { AuthRequest } from '../middleware/auth';

// ── S3 Client ──
const s3Client = new S3Client({
  region: config.s3.region,
  credentials: {
    accessKeyId: config.s3.accessKeyId,
    secretAccessKey: config.s3.secretAccessKey,
  },
});

// ── Allowed file types ──
const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
];

const MAX_FILE_SIZE = config.upload.maxFileSize; // 5MB default

/**
 * POST /api/v1/uploads
 * Upload a file to S3
 */
export const uploadFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const file = req.file;
    const { type } = req.body; // 'avatar' | 'licence' | 'insurance' | 'vehicle' | 'document'

    if (!file) {
      res.status(400).json({ success: false, message: 'No file provided' });
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      res.status(400).json({ success: false, message: 'Invalid file type. Allowed: JPG, PNG, WebP, PDF' });
      return;
    }

    if (file.size > MAX_FILE_SIZE) {
      res.status(400).json({ success: false, message: 'File too large. Maximum size is 5MB' });
      return;
    }

    // Generate unique filename. Driver registration docs go under
    // driver/{id}/docs/{type}/... so they're easy to find per-driver in S3.
    const ext = path.extname(file.originalname);
    const DRIVER_DOC_TYPES = ['licence', 'aadhaar', 'aadhaar-front', 'aadhaar-back', 'profile-photo', 'insurance', 'vehicle', 'dbs', 'phv'];
    const isDriverDoc = DRIVER_DOC_TYPES.includes(type);
    const key = isDriverDoc
      ? `driver/${req.user!._id}/docs/${type}/${uuidv4()}${ext}`
      : `${type || 'general'}/${req.user!._id}/${uuidv4()}${ext}`;

    // Upload to S3
    // NOTE: no ACL set — the bucket has Object Ownership = "Bucket owner
    // enforced" (ACLs disabled), so PutObject with an ACL fails with
    // AccessControlListNotSupported. Public read is granted via the bucket
    // policy instead, so uploaded objects are still publicly accessible.
    const command = new PutObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
    });

    await s3Client.send(command);

    const fileUrl = `${config.s3.baseUrl}/${key}`;

    // If avatar, update user profile
    if (type === 'avatar') {
      await User.findByIdAndUpdate(req.user!._id, { avatar: fileUrl });
    }

    // If driver document: UPSERT by type (one entry per type). Re-uploading
    // a previously-rejected doc replaces the URL and resets status to
    // 'pending' so admin reviews it fresh.
    if (['licence', 'aadhaar', 'aadhaar-front', 'aadhaar-back', 'profile-photo', 'insurance', 'vehicle', 'dbs', 'phv'].includes(type)) {
      const user = await User.findById(req.user!._id);
      if (user && user.driverProfile) {
        const docs = user.driverProfile.documents || [];
        const idx = docs.findIndex((d: any) => d.type === type);
        if (idx >= 0) {
          docs[idx].url = fileUrl;
          docs[idx].status = 'pending';
        } else {
          docs.push({ type, url: fileUrl, status: 'pending' });
        }
        user.driverProfile.documents = docs as any;
        user.markModified('driverProfile.documents');
        await user.save();
      }
    }

    res.status(200).json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        url: fileUrl,
        key,
        type,
      },
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: 'File upload failed' });
  }
};

/**
 * DELETE /api/v1/uploads/:key
 * Delete a file from S3
 */
export const deleteFile = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { key } = req.params;

    // Verify the file belongs to the user (key starts with user ID)
    if (!key.includes(req.user!._id.toString())) {
      res.status(403).json({ success: false, message: 'Unauthorized to delete this file' });
      return;
    }

    const command = new DeleteObjectCommand({
      Bucket: config.s3.bucketName,
      Key: decodeURIComponent(key),
    });

    await s3Client.send(command);

    res.status(200).json({
      success: true,
      message: 'File deleted successfully',
    });
  } catch (error) {
    console.error('Delete error:', error);
    res.status(500).json({ success: false, message: 'File deletion failed' });
  }
};

/**
 * POST /api/v1/uploads/presigned
 * Get a presigned URL for direct browser upload
 */
export const getPresignedUrl = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { filename, contentType, type } = req.body;

    if (!filename || !contentType) {
      res.status(400).json({ success: false, message: 'Filename and contentType are required' });
      return;
    }

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      res.status(400).json({ success: false, message: 'Invalid content type' });
      return;
    }

    const ext = path.extname(filename);
    const folder = type || 'general';
    const key = `${folder}/${req.user!._id}/${uuidv4()}${ext}`;

    // No ACL — bucket has ACLs disabled (see uploadFile). If the presigned
    // PUT included an x-amz-acl header the client's upload would 400, so the
    // client must not send one either.
    const command = new PutObjectCommand({
      Bucket: config.s3.bucketName,
      Key: key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 }); // 5 minutes

    res.status(200).json({
      success: true,
      data: {
        uploadUrl: presignedUrl,
        fileUrl: `${config.s3.baseUrl}/${key}`,
        key,
        expiresIn: 300,
      },
    });
  } catch (error) {
    console.error('Presigned URL error:', error);
    res.status(500).json({ success: false, message: 'Failed to generate upload URL' });
  }
};
