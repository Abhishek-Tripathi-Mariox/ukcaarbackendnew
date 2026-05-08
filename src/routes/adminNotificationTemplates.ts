import { Router, Request, Response } from 'express';
import { NotificationTemplate, User } from '../models';
import { authenticate, authorize, requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { renderString, sendTemplated } from '../services/notificationTemplate';

const router = Router();
router.use(authenticate);
router.use(authorize('admin'));

/**
 * GET /admin/notification-templates
 */
router.get(
  '/notification-templates',
  requirePermission(PERMISSIONS.VIEW_NOTIFICATION_TEMPLATES),
  async (req: Request, res: Response) => {
    try {
      const { search, type, locale, isActive } = req.query as Record<string, string>;
      const filter: any = {};
      if (search) {
        filter.$or = [
          { key: { $regex: search, $options: 'i' } },
          { name: { $regex: search, $options: 'i' } },
        ];
      }
      if (type) filter.type = type;
      if (locale) filter.locale = locale;
      if (isActive === 'true') filter.isActive = true;
      if (isActive === 'false') filter.isActive = false;

      const templates = await NotificationTemplate.find(filter).sort({ key: 1, locale: 1 });
      res.status(200).json({ success: true, data: { templates } });
    } catch (error) {
      console.error('list templates error:', error);
      res.status(500).json({ success: false, message: 'Failed to list templates' });
    }
  },
);

/**
 * GET /admin/notification-templates/:id
 */
router.get(
  '/notification-templates/:id',
  requirePermission(PERMISSIONS.VIEW_NOTIFICATION_TEMPLATES),
  async (req: Request, res: Response) => {
    try {
      const tpl = await NotificationTemplate.findById(req.params.id);
      if (!tpl) {
        res.status(404).json({ success: false, message: 'Template not found' });
        return;
      }
      res.status(200).json({ success: true, data: { template: tpl } });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to fetch template' });
    }
  },
);

/**
 * POST /admin/notification-templates
 */
router.post(
  '/notification-templates',
  requirePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  auditLog({ action: 'notification_template.create', resourceType: 'NotificationTemplate' }),
  async (req: Request, res: Response) => {
    try {
      const body = req.body || {};
      if (!body.key || !body.name || !body.titleTemplate || !body.bodyTemplate) {
        res.status(400).json({
          success: false,
          message: 'key, name, titleTemplate, bodyTemplate are required',
        });
        return;
      }
      const tpl = await NotificationTemplate.create({
        key: body.key,
        name: body.name,
        description: body.description ?? '',
        type: body.type ?? 'system',
        channel: body.channel ?? 'both',
        locale: body.locale ?? 'en',
        titleTemplate: body.titleTemplate,
        bodyTemplate: body.bodyTemplate,
        defaultData: body.defaultData ?? {},
        variables: body.variables ?? [],
        isActive: body.isActive ?? true,
      });
      res.status(201).json({ success: true, data: { template: tpl } });
    } catch (error: any) {
      if (error?.code === 11000) {
        res
          .status(409)
          .json({ success: false, message: 'A template with this key + locale already exists' });
        return;
      }
      console.error('create template error:', error);
      res.status(500).json({ success: false, message: 'Failed to create template' });
    }
  },
);

/**
 * PATCH /admin/notification-templates/:id
 */
router.patch(
  '/notification-templates/:id',
  requirePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  auditLog({ action: 'notification_template.update', resourceType: 'NotificationTemplate' }),
  async (req: Request, res: Response) => {
    try {
      const allowed = [
        'name',
        'description',
        'type',
        'channel',
        'locale',
        'titleTemplate',
        'bodyTemplate',
        'defaultData',
        'variables',
        'isActive',
      ];
      const update: Record<string, any> = {};
      for (const k of allowed) {
        if (req.body[k] !== undefined) update[k] = req.body[k];
      }
      const tpl = await NotificationTemplate.findByIdAndUpdate(req.params.id, update, {
        new: true,
      });
      if (!tpl) {
        res.status(404).json({ success: false, message: 'Template not found' });
        return;
      }
      res.status(200).json({ success: true, data: { template: tpl } });
    } catch (error: any) {
      if (error?.code === 11000) {
        res
          .status(409)
          .json({ success: false, message: 'A template with this key + locale already exists' });
        return;
      }
      res.status(500).json({ success: false, message: 'Failed to update template' });
    }
  },
);

/**
 * DELETE /admin/notification-templates/:id
 */
router.delete(
  '/notification-templates/:id',
  requirePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  auditLog({ action: 'notification_template.delete', resourceType: 'NotificationTemplate' }),
  async (req: Request, res: Response) => {
    try {
      await NotificationTemplate.findByIdAndDelete(req.params.id);
      res.status(200).json({ success: true });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Failed to delete template' });
    }
  },
);

/**
 * POST /admin/notification-templates/preview
 * Body: { titleTemplate, bodyTemplate, vars }
 * Renders without persisting — useful for the live editor preview.
 */
router.post(
  '/notification-templates/preview',
  requirePermission(PERMISSIONS.VIEW_NOTIFICATION_TEMPLATES),
  async (req: Request, res: Response) => {
    try {
      const { titleTemplate = '', bodyTemplate = '', vars = {} } = req.body || {};
      res.status(200).json({
        success: true,
        data: {
          title: renderString(titleTemplate, vars),
          body: renderString(bodyTemplate, vars),
        },
      });
    } catch (error) {
      res.status(500).json({ success: false, message: 'Preview failed' });
    }
  },
);

/**
 * POST /admin/notification-templates/:id/test
 * Body: { userId, vars }
 * Sends the template to a single user as a real notification.
 */
router.post(
  '/notification-templates/:id/test',
  requirePermission(PERMISSIONS.MANAGE_NOTIFICATION_TEMPLATES),
  auditLog({ action: 'notification_template.test', resourceType: 'NotificationTemplate' }),
  async (req: Request, res: Response) => {
    try {
      const tpl = await NotificationTemplate.findById(req.params.id);
      if (!tpl) {
        res.status(404).json({ success: false, message: 'Template not found' });
        return;
      }
      const { userId, vars = {} } = req.body || {};
      if (!userId) {
        res.status(400).json({ success: false, message: 'userId is required' });
        return;
      }
      const user = await User.findById(userId).select('_id');
      if (!user) {
        res.status(404).json({ success: false, message: 'User not found' });
        return;
      }
      const result = await sendTemplated(String(user._id), tpl.key, vars);
      res.status(200).json({ success: true, data: result });
    } catch (error) {
      console.error('template test error:', error);
      res.status(500).json({ success: false, message: 'Test send failed' });
    }
  },
);

export default router;
