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
}): Promise<{ redemption: any; account: ILoyaltyAccount }> {
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

  // Debit
  await addTransaction({
    userId: args.userId,
    type: 'redeem_reward',
    points: -reward.pointsCost,
    description: `Redeemed: ${reward.name}`,
    reward: reward._id,
  });

  // Issue redemption
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
    status: 'issued',
    issuedAt: new Date(),
    expiresAt,
  });

  await LoyaltyReward.updateOne(
    { _id: reward._id },
    { $inc: { totalRedemptionsCount: 1 } }
  );

  return { redemption, account: await getOrCreateAccount(args.userId) };
}
