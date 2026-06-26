import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { FAQ } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';

/**
 * Admin CRUD for FAQ entries. Mounted under /admin so it inherits the
 * authenticate + authorize('admin') middleware from routes/admin.ts.
 *
 * The customer/driver apps read the published subset via GET /support/faqs.
 */
const router = Router();

const AUDIENCES = ['user', 'driver', 'both'] as const;

/** GET /admin/faqs?audience=&isActive=&search= — full list for the admin table. */
router.get(
  '/faqs',
  requirePermission(PERMISSIONS.VIEW_FAQS),
  async (req: Request, res: Response) => {
    try {
      const filter: any = {};
      const { audience, isActive, search } = req.query;
      if (audience && AUDIENCES.includes(audience as any)) {
        filter.audience = audience;
      }
      if (isActive === 'true') filter.isActive = true;
      if (isActive === 'false') filter.isActive = false;
      if (search && String(search).trim()) {
        const rx = new RegExp(String(search).trim(), 'i');
        filter.$or = [{ question: rx }, { answer: rx }];
      }

      const faqs = await FAQ.find(filter).sort({ order: 1, createdAt: 1 });
      res.json({ success: true, data: { faqs } });
    } catch (err) {
      console.error('[FAQ] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load FAQs' });
    }
  },
);

/** POST /admin/faqs — create a new FAQ. */
router.post(
  '/faqs',
  requirePermission(PERMISSIONS.MANAGE_FAQS),
  auditLog({ action: 'faq.create', resourceType: 'FAQ' }),
  async (req: Request, res: Response) => {
    try {
      const { question, answer, audience = 'both', isActive = true, order = 0 } =
        req.body || {};
      if (!question || !String(question).trim()) {
        return res
          .status(400)
          .json({ success: false, message: 'question is required' });
      }
      if (!answer || !String(answer).trim()) {
        return res
          .status(400)
          .json({ success: false, message: 'answer is required' });
      }
      if (!AUDIENCES.includes(audience)) {
        return res.status(400).json({
          success: false,
          message: 'audience must be user, driver, or both',
        });
      }

      const faq = await FAQ.create({
        question: String(question).trim(),
        answer: String(answer).trim(),
        audience,
        isActive: !!isActive,
        order: Number(order) || 0,
      });
      res.status(201).json({ success: true, data: { faq } });
    } catch (err) {
      console.error('[FAQ] create error:', err);
      res.status(500).json({ success: false, message: 'Failed to create FAQ' });
    }
  },
);

/** PUT /admin/faqs/:id — update an existing FAQ. */
router.put(
  '/faqs/:id',
  requirePermission(PERMISSIONS.MANAGE_FAQS),
  auditLog({ action: 'faq.update', resourceType: 'FAQ' }),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid FAQ id' });
      }
      const update: any = {};
      const { question, answer, audience, isActive, order } = req.body || {};
      if (question !== undefined) update.question = String(question).trim();
      if (answer !== undefined) update.answer = String(answer).trim();
      if (audience !== undefined) {
        if (!AUDIENCES.includes(audience)) {
          return res.status(400).json({
            success: false,
            message: 'audience must be user, driver, or both',
          });
        }
        update.audience = audience;
      }
      if (isActive !== undefined) update.isActive = !!isActive;
      if (order !== undefined) update.order = Number(order) || 0;

      const faq = await FAQ.findByIdAndUpdate(req.params.id, update, {
        new: true,
        runValidators: true,
      });
      if (!faq) {
        return res.status(404).json({ success: false, message: 'FAQ not found' });
      }
      res.json({ success: true, data: { faq } });
    } catch (err) {
      console.error('[FAQ] update error:', err);
      res.status(500).json({ success: false, message: 'Failed to update FAQ' });
    }
  },
);

/** DELETE /admin/faqs/:id — remove a FAQ. */
router.delete(
  '/faqs/:id',
  requirePermission(PERMISSIONS.MANAGE_FAQS),
  auditLog({ action: 'faq.delete', resourceType: 'FAQ' }),
  async (req: Request, res: Response) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ success: false, message: 'Invalid FAQ id' });
      }
      const faq = await FAQ.findByIdAndDelete(req.params.id);
      if (!faq) {
        return res.status(404).json({ success: false, message: 'FAQ not found' });
      }
      res.json({ success: true, message: 'FAQ deleted' });
    } catch (err) {
      console.error('[FAQ] delete error:', err);
      res.status(500).json({ success: false, message: 'Failed to delete FAQ' });
    }
  },
);

export default router;
