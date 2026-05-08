import { SupportTicket, TicketCategory, TicketPriority } from '../models';

/**
 * Generate a sequential ticket number per calendar month.
 * Format: TKT-YYMM-NNNNNN
 */
export async function generateTicketNumber(): Promise<string> {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const periodPrefix = `TKT-${yy}${mm}-`;

  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const count = await SupportTicket.countDocuments({
    createdAt: { $gte: start, $lt: end },
  });
  const seq = String(count + 1).padStart(6, '0');
  return `${periodPrefix}${seq}`;
}

/**
 * SLA targets per priority (hours from creation).
 */
export const SLA_HOURS: Record<TicketPriority, number> = {
  urgent: 2,
  high: 8,
  normal: 24,
  low: 72,
};

export function computeSlaDue(priority: TicketPriority, from: Date = new Date()): Date {
  const hours = SLA_HOURS[priority] ?? 24;
  return new Date(from.getTime() + hours * 60 * 60 * 1000);
}

/**
 * Suggest a default priority from category for inbound tickets.
 */
export function defaultPriorityForCategory(category: TicketCategory): TicketPriority {
  switch (category) {
    case 'safety':
      return 'urgent';
    case 'payment':
    case 'refund':
    case 'driver_behavior':
      return 'high';
    case 'lost_item':
    case 'ride_issue':
      return 'normal';
    default:
      return 'normal';
  }
}
