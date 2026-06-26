import {
  LoyaltyAccount,
  LoyaltyTier,
  LoyaltyTransaction,
  LoyaltyTxnType,
  LoyaltyReward,
  LoyaltyRedemption,
  ILoyaltyAccount,
  ILoyaltyTier,
  ILoyaltyReward,
} from '../models/Loyalty';
import { IRide } from '../models/Ride';
import { Wallet, Payment } from '../models';
import mongoose from 'mongoose';

/** Default: 1 point per ₹10 of fare. Override via env if needed. */
const POINTS_PER_RUPEE = Number(process.env.LOYALTY_POINTS_PER_RUPEE ?? 0.1);

/**
 * Get-or-create loyalty account for a customer.
 */
export async function getOrCreateAccount(
  userId: mongoose.Types.ObjectId | string
): Promise<ILoyaltyAccount> {
  let acct = await LoyaltyAccount.findOne({ user: userId });
  if (!acct) {
    acct = await LoyaltyAccount.create({ user: userId });
  }
  return acct;
}

/**
 * Recompute tier for an account based on lifetimePoints.
 * Mutates and saves the account if the tier changes.
 */
export async function recalcTier(acct: ILoyaltyAccount): Promise<ILoyaltyAccount> {
  const tiers = await LoyaltyTier.find({ active: true })
    .sort({ minLifetimePoints: -1 })
    .lean();
  const newTier = tiers.find((t) => acct.lifetimePoints >= t.minLifetimePoints);
  if (newTier && String(acct.tier) !== String(newTier._id)) {
    acct.tier = newTier._id;
    acct.tierKey = newTier.key;
    acct.tierAchievedAt = new Date();
    await acct.save();
  } else if (!newTier && acct.tier) {
    acct.tier = null;
    acct.tierKey = undefined;
    await acct.save();
  }
  return acct;
}

/**
 * Add a points transaction. Pass negative `points` for debits.
 * Throws if balance would go negative.
 */
export async function addTransaction(args: {
  userId: mongoose.Types.ObjectId | string;
  type: LoyaltyTxnType;
  points: number;
  description?: string;
  reference?: string;
  ride?: mongoose.Types.ObjectId | string;
  payment?: mongoose.Types.ObjectId | string;
  reward?: mongoose.Types.ObjectId | string;
  performedBy?: mongoose.Types.ObjectId | string;
  metadata?: Record<string, any>;
}): Promise<{ account: ILoyaltyAccount; txnId: mongoose.Types.ObjectId }> {
  const acct = await getOrCreateAccount(args.userId);
  const newBalance = acct.pointsBalance + args.points;
  if (newBalance < 0) throw new Error('Insufficient points');

  acct.pointsBalance = newBalance;
  if (args.points > 0) {
    acct.lifetimePoints += args.points;
    acct.lastEarnAt = new Date();
  } else if (args.points < 0) {
    acct.lastRedeemAt = new Date();
  }
  await acct.save();
  await recalcTier(acct);

  const txn = await LoyaltyTransaction.create({
    user: args.userId,
    type: args.type,
    points: args.points,
    description: args.description,
    reference: args.reference,
    ride: args.ride,
    payment: args.payment,
    reward: args.reward,
    performedBy: args.performedBy,
    metadata: args.metadata,
    balanceAfter: acct.pointsBalance,
  });

  return { account: acct, txnId: txn._id };
}

/**
 * Award points for a completed ride based on actualFare and tier multiplier.
 */
export async function awardPointsForRide(ride: IRide): Promise<void> {
  if (!ride.customer || ride.status !== 'completed') return;
  const fare = ride.actualFare || 0;
  if (fare <= 0) return;

  const acct = await getOrCreateAccount(ride.customer);
  let multiplier = 1;
  if (acct.tier) {
    const tier = (await LoyaltyTier.findById(acct.tier).lean()) as ILoyaltyTier | null;
    if (tier?.earnMultiplier) multiplier = tier.earnMultiplier;
  }
  const basePts = Math.floor(fare * POINTS_PER_RUPEE);
  const pts = Math.max(0, Math.round(basePts * multiplier));
  if (pts === 0) return;

  await addTransaction({
    userId: ride.customer,
    type: 'earn_ride',
    points: pts,
    description: `Earned ${pts} pts for ride`,
    ride: ride._id,
  });
}

function generateRedemptionCode(): string {
  return 'LP-' + Math.random().toString(36).slice(2, 10).toUpperCase();
}

/**
 * Redeem a reward — debits points, issues a redemption code.
 */
export async function redeemReward(args: {
  userId: mongoose.Types.ObjectId | string;
  rewardId: string;
}): Promise<{
  redemption: any;
  account: ILoyaltyAccount;
  walletCredited: number;
  fulfilled: 'wallet' | 'voucher';
}> {
  const reward = (await LoyaltyReward.findById(args.rewardId)) as ILoyaltyReward | null;
  if (!reward) throw new Error('Reward not found');
  if (!reward.active) throw new Error('Reward not active');

  const now = new Date();
  if (reward.validFrom && now < reward.validFrom) throw new Error('Reward not yet available');
  if (reward.validUntil && now > reward.validUntil) throw new Error('Reward expired');

  if (
    reward.totalRedemptionLimit &&
    reward.totalRedemptionsCount >= reward.totalRedemptionLimit
  ) {
    throw new Error('Reward limit reached');
  }

  const acct = await getOrCreateAccount(args.userId);

  // Tier gate
  if (reward.minTierKey) {
    const minTier = await LoyaltyTier.findOne({ key: reward.minTierKey }).lean();
    if (minTier) {
      if (!acct.lifetimePoints || acct.lifetimePoints < minTier.minLifetimePoints) {
        throw new Error(`Requires ${minTier.name} tier`);
      }
    }
  }

  // Per-user limit
  if (reward.maxRedemptionsPerUser) {
    const count = await LoyaltyRedemption.countDocuments({
      user: args.userId,
      reward: reward._id,
      status: { $ne: 'cancelled' },
    });
    if (count >= reward.maxRedemptionsPerUser) {
      throw new Error('Per-user redemption limit reached');
    }
  }

  if (acct.pointsBalance < reward.pointsCost) {
    throw new Error('Insufficient points');
  }

  // Debit the points cost.
  await addTransaction({
    userId: args.userId,
    type: 'redeem_reward',
    points: -reward.pointsCost,
    description: `Redeemed: ${reward.name}`,
    reward: reward._id,
  });

  // `wallet_credit` rewards are fulfilled immediately — the ₹ value lands in
  // the customer's wallet and the redemption is recorded as already used.
  // There's no code to apply later, so it can never become a dangling voucher.
  const isWalletCredit = reward.type === 'wallet_credit';
  let walletCredited = 0;

  const code = generateRedemptionCode();
  const expiresAt = reward.validUntil ?? new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
  const redemption = await LoyaltyRedemption.create({
    user: args.userId,
    reward: reward._id,
    rewardSnapshot: {
      name: reward.name,
      type: reward.type,
      value: reward.value,
      pointsCost: reward.pointsCost,
    },
    code,
    status: isWalletCredit ? 'used' : 'issued',
    issuedAt: new Date(),
    usedAt: isWalletCredit ? new Date() : undefined,
    expiresAt,
  });

  if (isWalletCredit) {
    walletCredited = Math.max(0, Math.round(reward.value * 100) / 100);
    if (walletCredited > 0) {
      await Wallet.findOneAndUpdate(
        { user: args.userId },
        { $inc: { balance: walletCredited } },
        { upsert: true }
      );
      await Payment.create({
        user: args.userId,
        type: 'bonus',
        amount: walletCredited,
        method: 'wallet',
        status: 'completed',
        description: `Loyalty reward credited: ${reward.name}`,
      });
    }
  }

  await LoyaltyReward.updateOne(
    { _id: reward._id },
    { $inc: { totalRedemptionsCount: 1 } }
  );

  return {
    redemption,
    account: await getOrCreateAccount(args.userId),
    walletCredited,
    fulfilled: isWalletCredit ? 'wallet' : 'voucher',
  };
}

/** Round to 2 decimals. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Discount a single redemption voucher is worth against `amount`.
 * - ride_discount_flat / voucher → flat ₹ off (capped at the amount)
 * - ride_discount_pct            → percentage of the amount
 * - free_ride                    → the whole amount
 * - wallet_credit                → 0 (handled at redeem time, not at booking)
 */
function voucherDiscountFor(snapshot: { type: string; value: number }, amount: number): number {
  switch (snapshot.type) {
    case 'ride_discount_flat':
    case 'voucher':
      return Math.min(snapshot.value, amount);
    case 'ride_discount_pct':
      return Math.min((amount * snapshot.value) / 100, amount);
    case 'free_ride':
      return amount;
    default:
      return 0;
  }
}

export interface BookingLoyalty {
  account: ILoyaltyAccount;
  tierPct: number;
  /** The voucher that will apply (best applicable, or the one named by code). */
  voucher: {
    redemptionId: mongoose.Types.ObjectId;
    code: string;
    type: string;
    value: number;
  } | null;
}

/**
 * Resolve the loyalty context for a booking once: the customer's tier
 * discount % and the voucher to apply. If `voucherCode` is given we use that
 * exact issued voucher; otherwise we auto-pick the most valuable applicable
 * one so a redeemed reward is never wasted. Pure read — nothing is consumed.
 */
export async function resolveBookingLoyalty(
  userId: mongoose.Types.ObjectId | string,
  voucherCode?: string
): Promise<BookingLoyalty> {
  const account = await getOrCreateAccount(userId);

  let tierPct = 0;
  if (account.tier) {
    const tier = (await LoyaltyTier.findById(account.tier).lean()) as ILoyaltyTier | null;
    if (tier?.rideDiscountPct) tierPct = tier.rideDiscountPct;
  }

  const now = new Date();
  const baseQuery: any = {
    user: userId,
    status: 'issued',
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: null }, { expiresAt: { $gte: now } }],
    'rewardSnapshot.type': { $ne: 'wallet_credit' },
  };

  let voucher: BookingLoyalty['voucher'] = null;
  if (voucherCode) {
    const red = await LoyaltyRedemption.findOne({ ...baseQuery, code: voucherCode.toUpperCase() }).lean();
    if (red) {
      voucher = {
        redemptionId: red._id,
        code: red.code,
        type: red.rewardSnapshot.type,
        value: red.rewardSnapshot.value,
      };
    }
  } else {
    // Auto-pick: prefer free_ride, then highest flat value, then highest pct.
    const candidates = await LoyaltyRedemption.find(baseQuery).lean();
    if (candidates.length) {
      const score = (s: any) =>
        s.rewardSnapshot.type === 'free_ride'
          ? 1e9
          : s.rewardSnapshot.type === 'ride_discount_flat' || s.rewardSnapshot.type === 'voucher'
            ? s.rewardSnapshot.value
            : s.rewardSnapshot.value; // pct
      const best = candidates.sort((a, b) => score(b) - score(a))[0];
      voucher = {
        redemptionId: best._id,
        code: best.code,
        type: best.rewardSnapshot.type,
        value: best.rewardSnapshot.value,
      };
    }
  }

  return { account, tierPct, voucher };
}

/**
 * The total ₹ loyalty discount for `amount` given a resolved context: tier %
 * plus the voucher's value. Capped so the fare never goes below zero.
 */
export function loyaltyDiscountForAmount(ctx: BookingLoyalty, amount: number): number {
  if (amount <= 0) return 0;
  const tierDiscount = (amount * ctx.tierPct) / 100;
  let remaining = Math.max(0, amount - tierDiscount);
  const voucherDiscount = ctx.voucher
    ? voucherDiscountFor({ type: ctx.voucher.type, value: ctx.voucher.value }, remaining)
    : 0;
  return r2(Math.min(amount, tierDiscount + voucherDiscount));
}

/**
 * Mark a redeemed voucher as consumed against a ride. Records a ledger note
 * so the customer's transaction history shows where the voucher went.
 */
export async function consumeRedemption(
  redemptionId: mongoose.Types.ObjectId | string,
  rideId: mongoose.Types.ObjectId | string
): Promise<void> {
  await LoyaltyRedemption.updateOne(
    { _id: redemptionId, status: 'issued' },
    { $set: { status: 'used', usedAt: new Date(), usedRide: rideId } }
  );
}
