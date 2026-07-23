import { config } from '../config';

export interface OnePassPlan {
  key: string;
  label: string;
  price: number;
  days: number;
  active: boolean;
}

/** Config defaults, used until an admin configures plans in Settings. */
export function defaultOnePassPlans(): OnePassPlan[] {
  return Object.entries(config.onePass.plans).map(([key, p]) => ({
    key,
    label: p.label,
    price: p.price,
    days: p.days,
    active: true,
  }));
}

/**
 * The live OnePass plan list — admin-configured (Settings.onePassPlans) if
 * present, else the config defaults. Both the driver plans endpoint and the
 * server-side price lookup use this so the app can never charge a price the
 * admin didn't set.
 */
export async function resolveOnePassPlans(): Promise<OnePassPlan[]> {
  try {
    const { Settings } = await import('../models');
    const doc: any = await Settings.findOne({ key: 'platform' })
      .select('onePassPlans')
      .lean();
    const plans = doc?.onePassPlans as OnePassPlan[] | undefined;
    if (Array.isArray(plans) && plans.length) {
      return plans.map((p) => ({
        key: String(p.key),
        label: String(p.label),
        price: Math.max(0, Number(p.price) || 0),
        days: Math.max(1, Number(p.days) || 1),
        active: p.active !== false,
      }));
    }
  } catch (err) {
    console.error('resolveOnePassPlans error:', err);
  }
  return defaultOnePassPlans();
}

/** Look up a single plan by key (any status). */
export async function findOnePassPlan(key: string): Promise<OnePassPlan | undefined> {
  return (await resolveOnePassPlans()).find((p) => p.key === key);
}
