import { Router, Request, Response } from 'express';
import { Zone, SurgeRule } from '../models';
import { requirePermission } from '../middleware/auth';
import { auditLog } from '../middleware/audit';
import { PERMISSIONS } from '../config/permissions';
import { resolveSurge, isPickupBlocked } from '../services/surge';

const router = Router();

// ════════════════════════════════════════════════════════════════════
// ZONES
// ════════════════════════════════════════════════════════════════════

function validateGeometry(geometry: any): string | null {
  if (!geometry || typeof geometry !== 'object') return 'geometry is required';
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') {
    return 'geometry.type must be Polygon or MultiPolygon';
  }
  if (!Array.isArray(geometry.coordinates)) return 'geometry.coordinates must be an array';
  // Polygon: [ring][point][lng,lat]; MultiPolygon: [poly][ring][point][lng,lat]
  const polys =
    geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  for (const poly of polys) {
    if (!Array.isArray(poly) || poly.length === 0) return 'invalid polygon ring set';
    for (const ring of poly) {
      if (!Array.isArray(ring) || ring.length < 4) return 'each ring needs >= 4 points';
      for (const p of ring) {
        if (!Array.isArray(p) || p.length < 2) return 'each point must be [lng, lat]';
        const [lng, lat] = p;
        if (typeof lng !== 'number' || typeof lat !== 'number')
          return 'coordinates must be numbers';
        if (lng < -180 || lng > 180 || lat < -90 || lat > 90)
          return 'coordinates out of range';
      }
      const first = ring[0];
      const last = ring[ring.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1])
        return 'each ring must be closed (first point == last point)';
    }
  }
  return null;
}

router.get(
  '/zones',
  requirePermission(PERMISSIONS.VIEW_ZONES),
  async (req: Request, res: Response) => {
    try {
      const { kind, isActive } = req.query;
      const filter: any = {};
      if (kind) filter.kind = kind;
      if (isActive !== undefined) filter.isActive = isActive === 'true';
      const zones = await Zone.find(filter).sort({ createdAt: -1 });
      res.json({ success: true, data: { zones } });
    } catch (err) {
      console.error('[zones] list error:', err);
      res.status(500).json({ success: false, message: 'Failed to load zones' });
    }
  }
);

router.get(
  '/zones/:id',
  requirePermission(PERMISSIONS.VIEW_ZONES),
  async (req: Request, res: Response) => {
    try {
      const zone = await Zone.findById(req.params.id);
      if (!zone) {
        res.status(404).json({ success: false, message: 'Zone not found' });
        return;
      }
      res.json({ success: true, data: { zone } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to load zone' });
    }
  }
);

router.post(
  '/zones',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'zone.create', resourceType: 'zone' }),
  async (req: Request, res: Response) => {
    try {
      const err = validateGeometry(req.body?.geometry);
      if (err) {
        res.status(400).json({ success: false, message: err });
        return;
      }
      const zone = await Zone.create(req.body);
      res.status(201).json({ success: true, data: { zone } });
    } catch (err: any) {
      console.error('[zones] create error:', err);
      res.status(400).json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.patch(
  '/zones/:id',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'zone.update', resourceType: 'zone' }),
  async (req: Request, res: Response) => {
    try {
      if (req.body?.geometry) {
        const err = validateGeometry(req.body.geometry);
        if (err) {
          res.status(400).json({ success: false, message: err });
          return;
        }
      }
      const zone = await Zone.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!zone) {
        res.status(404).json({ success: false, message: 'Zone not found' });
        return;
      }
      res.json({ success: true, data: { zone } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Update failed' });
    }
  }
);

router.delete(
  '/zones/:id',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'zone.delete', resourceType: 'zone' }),
  async (req: Request, res: Response) => {
    try {
      const zone = await Zone.findByIdAndDelete(req.params.id);
      if (!zone) {
        res.status(404).json({ success: false, message: 'Zone not found' });
        return;
      }
      // Detach any surge rules that referenced this zone
      await SurgeRule.updateMany({ zone: zone._id }, { $unset: { zone: '' } });
      res.json({ success: true, message: 'Zone deleted' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Delete failed' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// SURGE RULES
// ════════════════════════════════════════════════════════════════════

router.get(
  '/surge-rules',
  requirePermission(PERMISSIONS.VIEW_ZONES),
  async (req: Request, res: Response) => {
    try {
      const { isActive, zone } = req.query;
      const filter: any = {};
      if (isActive !== undefined) filter.isActive = isActive === 'true';
      if (zone) filter.zone = zone;
      const rules = await SurgeRule.find(filter)
        .populate('zone', 'name kind color')
        .sort({ priority: -1, createdAt: -1 });
      res.json({ success: true, data: { rules } });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Failed to load surge rules' });
    }
  }
);

router.post(
  '/surge-rules',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'surge_rule.create', resourceType: 'surge_rule' }),
  async (req: Request, res: Response) => {
    try {
      const rule = await SurgeRule.create(req.body);
      res.status(201).json({ success: true, data: { rule } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Create failed' });
    }
  }
);

router.patch(
  '/surge-rules/:id',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'surge_rule.update', resourceType: 'surge_rule' }),
  async (req: Request, res: Response) => {
    try {
      const rule = await SurgeRule.findByIdAndUpdate(req.params.id, req.body, {
        new: true,
        runValidators: true,
      });
      if (!rule) {
        res.status(404).json({ success: false, message: 'Surge rule not found' });
        return;
      }
      res.json({ success: true, data: { rule } });
    } catch (err: any) {
      res.status(400).json({ success: false, message: err.message || 'Update failed' });
    }
  }
);

router.delete(
  '/surge-rules/:id',
  requirePermission(PERMISSIONS.MANAGE_ZONES),
  auditLog({ action: 'surge_rule.delete', resourceType: 'surge_rule' }),
  async (req: Request, res: Response) => {
    try {
      const r = await SurgeRule.findByIdAndDelete(req.params.id);
      if (!r) {
        res.status(404).json({ success: false, message: 'Surge rule not found' });
        return;
      }
      res.json({ success: true, message: 'Surge rule deleted' });
    } catch (err) {
      res.status(500).json({ success: false, message: 'Delete failed' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// PROBE — let admins test what surge a (lat,lng,when) resolves to
// ════════════════════════════════════════════════════════════════════

router.post(
  '/surge/probe',
  requirePermission(PERMISSIONS.VIEW_ZONES),
  async (req: Request, res: Response) => {
    try {
      const { lat, lng, subtotal, when } = req.body ?? {};
      if (typeof lat !== 'number' || typeof lng !== 'number') {
        res.status(400).json({ success: false, message: 'lat & lng required (numbers)' });
        return;
      }
      const dt = when ? new Date(when) : new Date();
      const block = await isPickupBlocked(lat, lng);
      const surge = await resolveSurge(lat, lng, Number(subtotal) || 100, dt);
      res.json({
        success: true,
        data: {
          when: dt,
          blocked: block.blocked,
          blockedBy: block.zone
            ? { _id: block.zone._id, name: block.zone.name, kind: block.zone.kind }
            : null,
          surge,
        },
      });
    } catch (err) {
      console.error('[surge.probe] error:', err);
      res.status(500).json({ success: false, message: 'Probe failed' });
    }
  }
);

export default router;
