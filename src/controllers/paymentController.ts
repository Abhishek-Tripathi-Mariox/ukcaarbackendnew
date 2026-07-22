import { Request, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Payment, Wallet, User, SavedPaymentMethod, RechargeOffer, Ride } from '../models';
import { AuthRequest } from '../middleware/auth';
import { config } from '../config';

const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

// GST applied to wallet recharges. Keep in sync with the customer app's
// WalletTopUpScreen so the displayed breakdown matches what's charged.
const WALLET_GST_RATE = 0.18;

/**
 * Collect cancellation fees that couldn't be debited at cancel time.
 *
 * cancelRide records a `cancellation_fee` Payment with status `pending` when
 * the wallet balance was too low — but nothing ever collected it, so the fee
 * existed only as a dead ledger row. Called after every wallet top-up credit:
 * each pending fee is settled atomically against the (now funded) balance,
 * oldest first. Never throws — fee collection must not break a top-up.
 */
async function collectPendingCancellationFees(userId: any): Promise<void> {
  try {
    const pending = await Payment.find({
      user: userId,
      type: 'cancellation_fee',
      status: 'pending',
    }).sort({ createdAt: 1 });
    for (const feeRow of pending) {
      const amt = Math.max(0, Number(feeRow.amount) || 0);
      if (!amt) continue;
      // Conditional debit — only succeeds while the balance covers the fee.
      const debited = await Wallet.findOneAndUpdate(
        { user: userId, balance: { $gte: amt } },
        { $inc: { balance: -amt } },
        { new: true },
      );
      if (!debited) break; // balance exhausted; later top-ups retry the rest
      feeRow.status = 'completed';
      feeRow.description = 'Cancellation fee (collected from wallet top-up)';
      await feeRow.save();
    }
  } catch (err) {
    console.error('collectPendingCancellationFees error:', err);
  }
}


interface RechargeQuote {
  denomination: number; // base recharge value (credited as principal)
  bonus: number; // extra wallet credit on top of the denomination
  discount: number; // absolute INR knocked off the payable price
  gst: number;
  total: number; // amount actually charged via Razorpay
  walletCredit: number; // amount credited to the wallet on success
}

/**
 * Single source of truth for wallet-recharge math. Both preset offers and
 * custom amounts route through here so the charged total and the credited
 * balance are always computed server-side — never from client-sent values.
 */
function computeRechargeQuote(opts: {
  amount: number;
  bonusAmount?: number;
  discountPercent?: number;
}): RechargeQuote {
  const denomination = Math.max(0, Math.round(opts.amount));
  const bonus = Math.max(0, Math.round(opts.bonusAmount || 0));
  const discountPercent = Math.min(Math.max(opts.discountPercent || 0, 0), 100);
  const discount = Math.round((denomination * discountPercent) / 100);
  const payableBeforeGst = Math.max(0, denomination - discount);
  const gst = Math.round(payableBeforeGst * WALLET_GST_RATE);
  const total = payableBeforeGst + gst;
  const walletCredit = denomination + bonus;
  return { denomination, bonus, discount, gst, total, walletCredit };
}

/**
 * GET /api/v1/payments/recharge-offers
 * Active recharge offers for the customer app's wallet top-up screen, sorted
 * by display order. Returns a computed price breakdown per offer so the client
 * doesn't have to duplicate the GST/discount formula.
 */
export const getRechargeOffers = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const now = new Date();
    const offers = await RechargeOffer.find({
      isActive: true,
      $and: [
        { $or: [{ validFrom: { $exists: false } }, { validFrom: null }, { validFrom: { $lte: now } }] },
        { $or: [{ validUntil: { $exists: false } }, { validUntil: null }, { validUntil: { $gte: now } }] },
      ],
    })
      .sort({ order: 1, amount: 1 })
      .lean();

    const items = offers.map((o: any) => {
      const quote = computeRechargeQuote({
        amount: o.amount,
        bonusAmount: o.bonusAmount,
        discountPercent: o.discountPercent,
      });
      return {
        _id: String(o._id),
        amount: o.amount,
        bonusAmount: o.bonusAmount || 0,
        discountPercent: o.discountPercent || 0,
        label: o.label || '',
        isPopular: !!o.isPopular,
        ...quote,
      };
    });

    res.status(200).json({ success: true, data: { offers: items } });
  } catch (error) {
    console.error('getRechargeOffers error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch recharge offers' });
  }
};

/**
 * GET /api/v1/payments
 * Get payment history
 */
export const getPayments = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const skip = (page - 1) * limit;

    const [payments, total] = await Promise.all([
      Payment.find({ user: req.user!._id })
        .populate('ride', 'rideType pickup.address dropoff.address')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Payment.countDocuments({ user: req.user!._id }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        payments,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payments' });
  }
};

/**
 * GET /api/v1/payments/wallet
 */
export const getWallet = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let wallet = await Wallet.findOne({ user: req.user!._id });
    if (!wallet) {
      wallet = await Wallet.create({ user: req.user!._id, balance: 0 });
    }

    const recentTransactions = await Payment.find({ user: req.user!._id })
      .sort({ createdAt: -1 })
      .limit(10);

    res.status(200).json({
      success: true,
      data: { wallet, recentTransactions },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch wallet' });
  }
};

/**
 * POST /api/v1/payments/create-order
 * Create a Razorpay order for wallet topup or ride payment
 */
/**
 * Activate OnePass for the driver on a verified subscription payment. The plan
 * (and therefore the validity period) was fixed server-side at order time, so
 * the client can't extend it. Extends from the current expiry if still active.
 */
async function activateOnePassFromPayment(payment: any): Promise<void> {
  if (payment.type !== 'subscription' || !payment.subscriptionPlan) return;
  const planDef = config.onePass.plans[payment.subscriptionPlan];
  if (!planDef) return;

  const user = await User.findById(payment.user).select('driverProfile.onePassExpiry');
  const currentExpiry = (user as any)?.driverProfile?.onePassExpiry;
  const base = currentExpiry && new Date(currentExpiry) > new Date() ? new Date(currentExpiry) : new Date();
  const expiry = new Date(base.getTime() + planDef.days * 24 * 60 * 60 * 1000);

  await User.findByIdAndUpdate(payment.user, {
    'driverProfile.isOnePass': true,
    'driverProfile.onePassExpiry': expiry,
  });
}

export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const {
      amount,
      type = 'wallet_topup',
      rideId,
      scheduledRouteId,
      methodPreference,
      offerId,
      plan,
    } = req.body;

    // For wallet top-ups the charged total and the credited balance are
    // computed server-side from the offer (or the custom amount) so the
    // bonus/discount can't be tampered with from the client.
    let chargeAmount = Number(amount);
    let walletCredit: number | undefined;
    let bonusAmount: number | undefined;
    let offerDoc: any = null;
    let subscriptionPlan: string | undefined;

    if (type === 'subscription') {
      // OnePass purchase — price comes from the server-side plan table; the
      // client only chooses a plan key. Activation happens on verify.
      const planDef = config.onePass.plans[String(plan)];
      if (!planDef) {
        res.status(400).json({ success: false, message: 'Invalid OnePass plan' });
        return;
      }
      chargeAmount = planDef.price;
      subscriptionPlan = String(plan);
    } else if (type === 'wallet_topup') {
      let quote: RechargeQuote;
      if (offerId) {
        offerDoc = await RechargeOffer.findById(offerId);
        if (!offerDoc || !offerDoc.isActive) {
          res.status(400).json({ success: false, message: 'Recharge offer is unavailable' });
          return;
        }
        quote = computeRechargeQuote({
          amount: offerDoc.amount,
          bonusAmount: offerDoc.bonusAmount,
          discountPercent: offerDoc.discountPercent,
        });
      } else {
        if (!amount || amount <= 0) {
          res.status(400).json({ success: false, message: 'Invalid amount' });
          return;
        }
        quote = computeRechargeQuote({ amount: Number(amount) });
      }
      chargeAmount = quote.total;
      walletCredit = quote.walletCredit;
      bonusAmount = quote.bonus;
    } else if (type === 'ride_payment' && rideId) {
      // Secure ride payment: NEVER trust the client's amount — derive it from
      // the ride itself (previously any rider could create a ₹1 order for a
      // ₹500 ride and verify-payment would settle the full fare). Also enforce
      // ownership + that the ride is awaiting payment.
      //
      // NOTE: a 'ride_payment' WITHOUT a rideId (the scheduled-booking Razorpay
      // path historically reuses this type) intentionally falls through to the
      // generic client-amount handling below — it has no ride attached, so
      // verify-payment can't settle any ride from it and there's nothing to
      // exploit. This keeps scheduled Razorpay payments working.
      const ride = await Ride.findById(rideId);
      if (!ride) {
        res.status(404).json({ success: false, message: 'Ride not found' });
        return;
      }
      if (String(ride.customer) !== String(req.user!._id)) {
        res.status(403).json({ success: false, message: 'Not your ride' });
        return;
      }
      if (ride.status !== 'payment_pending') {
        res.status(400).json({
          success: false,
          message: ride.status === 'completed' ? 'This ride is already paid' : 'This ride is not awaiting payment',
        });
        return;
      }
      if (ride.paymentStatus === 'completed') {
        res.status(400).json({ success: false, message: 'This ride is already paid' });
        return;
      }
      chargeAmount = Number(ride.actualFare ?? ride.estimatedFare ?? 0);
      if (!(chargeAmount > 0)) {
        res.status(400).json({ success: false, message: 'Ride amount unavailable' });
        return;
      }
    } else if (!amount || amount <= 0) {
      res.status(400).json({ success: false, message: 'Invalid amount' });
      return;
    }

    // Razorpay expects amount in paise (smallest currency unit)
    const order = await razorpay.orders.create({
      amount: Math.round(chargeAmount * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: {
        userId: req.user!._id.toString(),
        type,
        ...(rideId && { rideId }),
        ...(offerId && { offerId }),
        // Stash the route id on the order for traceability — the
        // actual ScheduledBooking is created client-side after verify,
        // since the seat reservation has to be atomic against other
        // riders. notes is searchable in the Razorpay dashboard which
        // helps with reconciliation if a payment lands without a
        // matching booking.
        ...(scheduledRouteId && { scheduledRouteId }),
      },
    });

    // Create a pending payment record. Scheduled bookings don't have a
    // Ride doc — the route id is recorded in the description for now;
    // the booking record itself is created in `bookSeats` after the
    // payment verifies, and we link it back via the payment row.
    const description =
      type === 'wallet_topup'
        ? `Wallet top-up: ₹${chargeAmount}${
            walletCredit && walletCredit !== chargeAmount ? ` (₹${walletCredit} credited)` : ''
          }`
        : type === 'subscription'
        ? `OnePass ${subscriptionPlan} subscription: ₹${chargeAmount}`
        : type === 'scheduled_booking'
        ? `Scheduled booking: ₹${amount}${scheduledRouteId ? ` (route ${scheduledRouteId})` : ''}`
        : `Ride payment: ₹${amount}`;

    const payment = await Payment.create({
      user: req.user!._id,
      ...(rideId && { ride: rideId }),
      type,
      amount: chargeAmount,
      ...(walletCredit !== undefined && { walletCredit }),
      ...(bonusAmount !== undefined && { bonusAmount }),
      ...(offerDoc && { rechargeOffer: offerDoc._id }),
      ...(subscriptionPlan && { subscriptionPlan }),
      method: methodPreference === 'wallet' ? 'wallet' : 'card',
      status: 'pending',
      razorpayOrderId: order.id,
      description,
    });

    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        paymentId: payment._id,
        keyId: config.razorpay.keyId,
        // Echo back the server-computed top-up breakdown so the client shows
        // exactly what will be charged/credited.
        ...(type === 'wallet_topup' && {
          chargeAmount,
          walletCredit,
          bonusAmount,
        }),
      },
    });
  } catch (error) {
    console.error('createOrder error:', error);
    res.status(500).json({ success: false, message: 'Failed to create order' });
  }
};

/**
 * GET /api/v1/payments/checkout
 * Serves a Razorpay checkout HTML page (for Expo Go / WebBrowser fallback)
 */
export const checkoutPage = async (req: Request, res: Response): Promise<void> => {
  const { orderId, amount, currency, keyId, callbackUrl } = req.query;

  // These values land in an HTML <script> context, so every one is emitted as
  // a properly-escaped JS string literal (JSON.stringify + `<` escaping) to
  // prevent reflected XSS. The callback is additionally forced to this
  // server's own origin so a hostile `callbackUrl` can't exfiltrate the
  // razorpay signature/payment id to an attacker's host (open redirect).
  const jsStr = (v: unknown): string =>
    JSON.stringify(String(v ?? '')).replace(/</g, '\\u003c');

  const selfCallback = `${req.protocol}://${req.get('host')}/api/v1/payments/checkout/callback`;
  let cb = selfCallback;
  try {
    const u = new URL(String(callbackUrl ?? ''));
    if ((u.protocol === 'http:' || u.protocol === 'https:') && u.host === req.get('host')) {
      cb = u.toString();
    }
  } catch {
    /* not a valid absolute URL → keep the server's own callback */
  }

  const html = `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>UKCAAR Payment</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}
.loading{text-align:center;color:#555;}.spinner{border:4px solid #eee;border-top:4px solid #0097B3;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite;margin:0 auto 16px;}
@keyframes spin{to{transform:rotate(360deg)}}</style>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
</head><body>
<div class="loading"><div class="spinner"></div><p>Opening payment...</p></div>
<script>
var CB=${jsStr(cb)};
var options={key:${jsStr(keyId)},amount:${jsStr(amount)},currency:${jsStr(currency)},name:"UKCAAR",
description:"UKCAAR Payment",order_id:${jsStr(orderId)},
theme:{color:"#0097B3"},
handler:function(r){window.location.href=CB+"?razorpay_payment_id="+encodeURIComponent(r.razorpay_payment_id)+"&razorpay_order_id="+encodeURIComponent(r.razorpay_order_id)+"&razorpay_signature="+encodeURIComponent(r.razorpay_signature);},
modal:{ondismiss:function(){window.location.href=CB+"?cancelled=true";}}};
var rzp=new Razorpay(options);rzp.open();
</script></body></html>`;
  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

/**
 * GET /api/v1/payments/checkout/callback
 * Handles redirect after Razorpay web checkout completes
 */
export const checkoutCallback = async (req: Request, res: Response): Promise<void> => {
  const { razorpay_payment_id, razorpay_order_id, razorpay_signature, cancelled } = req.query;

  if (cancelled === 'true') {
    const html = `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Cancelled</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}
.card{text-align:center;background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:320px;}
.icon{font-size:48px;margin-bottom:12px;}h2{color:#333;margin:0 0 8px;}p{color:#777;margin:0 0 20px;font-size:14px;}
.btn{background:#0097B3;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;cursor:pointer;}</style>
</head><body><div class="card"><div class="icon">❌</div><h2>Payment Cancelled</h2>
<p>You can close this window and try again.</p>
<button class="btn" onclick="window.close()">Close</button></div></body></html>`;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
    return;
  }

  // Verify and complete the payment server-side
  let success = false;
  if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', config.razorpay.keySecret)
      .update(body)
      .digest('hex');

    if (expectedSignature === razorpay_signature) {
      // Idempotency guard (see verifyPayment): only credit on the first
      // completion. Replaying this callback URL (it sits in browser history)
      // must not re-credit the wallet.
      const payment = await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id as string, status: { $ne: 'completed' } },
        { status: 'completed', razorpayPaymentId: razorpay_payment_id as string },
        { new: true },
      );

      if (payment) {
        success = true;
        if (payment.type === 'wallet_topup') {
          await Wallet.findOneAndUpdate(
            { user: payment.user },
            { $inc: { balance: payment.walletCredit ?? payment.amount } },
            { upsert: true },
          );
          await collectPendingCancellationFees(payment.user);
        }
        await activateOnePassFromPayment(payment);
      } else {
        // No pending order to complete — already processed (replay) or unknown.
        // Show the success page either way; do NOT re-credit.
        const existing = await Payment.findOne({ razorpayOrderId: razorpay_order_id as string });
        success = !!(existing && existing.status === 'completed');
      }
    }
  }

  const html = success
    ? `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Success</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}
.card{text-align:center;background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:320px;}
.icon{font-size:48px;margin-bottom:12px;}h2{color:#333;margin:0 0 8px;}p{color:#777;margin:0 0 20px;font-size:14px;}
.btn{background:#0097B3;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;cursor:pointer;}</style>
</head><body><div class="card"><div class="icon">✅</div><h2>Payment Successful!</h2>
<p>Your payment has been processed. You can close this window to return to the app.</p>
<button class="btn" onclick="window.close()">Close & Return</button></div></body></html>`
    : `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment Failed</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f5f5f5;}
.card{text-align:center;background:#fff;padding:32px;border-radius:16px;box-shadow:0 2px 12px rgba(0,0,0,0.1);max-width:320px;}
.icon{font-size:48px;margin-bottom:12px;}h2{color:#333;margin:0 0 8px;}p{color:#777;margin:0 0 20px;font-size:14px;}
.btn{background:#0097B3;color:#fff;border:none;padding:14px 32px;border-radius:8px;font-size:16px;cursor:pointer;}</style>
</head><body><div class="card"><div class="icon">⚠️</div><h2>Payment Failed</h2>
<p>Something went wrong. Please close this window and try again.</p>
<button class="btn" onclick="window.close()">Close</button></div></body></html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};

/**
 * POST /api/v1/payments/verify-payment
 * Verify Razorpay payment signature and complete the transaction
 */
export const verifyPayment = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      res.status(400).json({ success: false, message: 'Missing payment verification data' });
      return;
    }

    // Verify signature
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', config.razorpay.keySecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      // Mark payment as failed
      await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id },
        { status: 'failed' },
      );
      res.status(400).json({ success: false, message: 'Payment verification failed' });
      return;
    }

    // Idempotency guard: only flip an order that hasn't already completed.
    // Without the `status != completed` condition, replaying the same (valid)
    // razorpay ids re-ran the wallet credit / ride settlement below on every
    // call — a repeatable money exploit. The atomic conditional update makes
    // the first caller win and every replay find nothing.
    const payment = await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id, status: { $ne: 'completed' } },
      {
        status: 'completed',
        razorpayPaymentId: razorpay_payment_id,
      },
      { new: true },
    );

    if (!payment) {
      // Either the order doesn't exist, or it was already completed (replay).
      // Respond idempotently on an already-completed order without re-crediting.
      const existing = await Payment.findOne({ razorpayOrderId: razorpay_order_id });
      if (existing && existing.status === 'completed') {
        const wallet = await Wallet.findOne({ user: existing.user });
        res.status(200).json({
          success: true,
          message: 'Payment already verified',
          data: { payment: existing, wallet },
        });
        return;
      }
      res.status(404).json({ success: false, message: 'Payment record not found' });
      return;
    }

    // If wallet topup, credit the wallet
    if (payment.type === 'wallet_topup') {
      await Wallet.findOneAndUpdate(
        { user: payment.user },
        { $inc: { balance: payment.walletCredit ?? payment.amount } },
        { upsert: true, new: true },
      );
      await collectPendingCancellationFees(payment.user);
    }

    // If OnePass subscription, activate it now that payment is verified.
    await activateOnePassFromPayment(payment);

    // If this Razorpay order was paying off a ride, flip the ride from
    // `payment_pending` → `completed` and settle the driver's earnings.
    // Without this the ride stayed `payment_pending` forever and the
    // receipt screen kept showing "Proceed to Payment" on relaunch.
    if (payment.type === 'ride_payment' && payment.ride) {
      try {
        const { finalizeRideSettlement } = await import('./rideController');
        const settled = await finalizeRideSettlement(String(payment.ride), 'card');
        const { emitToRide, emitToUser } = await import('../socket');
        if (settled) {
          const evt = { rideId: settled._id, status: 'completed', ride: settled };
          emitToRide(String(settled._id), 'ride:status', evt);
          emitToUser(String(settled.customer), 'ride:status', evt);
          if (settled.driver) emitToUser(String(settled.driver), 'ride:status', evt);
        }
      } catch (e) {
        console.error('[verifyPayment] settle failed:', e);
      }
    }

    const wallet = await Wallet.findOne({ user: payment.user });

    res.status(200).json({
      success: true,
      message: 'Payment verified successfully',
      data: {
        payment,
        wallet,
      },
    });
  } catch (error) {
    console.error('verifyPayment error:', error);
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
};

/**
 * POST /api/v1/payments/wallet/pay-ride
 *
 * Debits the rider's wallet for a completed ride. Atomic enough for our
 * traffic: refetch → check sufficiency → decrement → save. Returns the
 * new balance + the created Payment record so the customer can update
 * Redux without a follow-up /wallet GET.
 *
 * Refuses to debit if:
 *   - The ride doesn't belong to the caller.
 *   - The ride isn't in `completed` status (we don't bill a trip that
 *     hasn't ended).
 *   - The ride is already marked paid — prevents double-debits if the
 *     customer hammers the button while the response is in flight.
 *   - The wallet balance is below the fare. Caller must fall through to
 *     Razorpay (top-up flow handled separately on the client).
 */
export const payRideFromWallet = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { rideId } = req.body as { rideId?: string };
    if (!rideId) {
      res.status(400).json({ success: false, message: 'rideId is required' });
      return;
    }

    const { Ride } = await import('../models');
    const ride = await Ride.findById(rideId);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (String(ride.customer) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your ride' });
      return;
    }
    // We now bill the rider during the `payment_pending` stage — the trip
    // has physically ended (driver pressed "End trip") but the ride is
    // not yet `completed`. Settlement here flips it.
    if (ride.status !== 'payment_pending') {
      res.status(400).json({
        success: false,
        message:
          ride.status === 'completed'
            ? 'This ride is already paid'
            : 'Ride is not awaiting payment',
      });
      return;
    }
    if (ride.paymentStatus === 'completed') {
      res.status(400).json({
        success: false,
        message: 'This ride is already paid',
      });
      return;
    }

    const amount = Number(ride.actualFare ?? ride.estimatedFare ?? 0);
    if (!(amount > 0)) {
      res.status(400).json({ success: false, message: 'Ride amount unavailable' });
      return;
    }

    let wallet = await Wallet.findOne({ user: req.user!._id });
    if (!wallet) wallet = await Wallet.create({ user: req.user!._id, balance: 0 });

    if (wallet.balance < amount) {
      res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance',
        data: { walletBalance: wallet.balance, required: amount },
      });
      return;
    }

    wallet.balance = Math.round((wallet.balance - amount) * 100) / 100;
    await wallet.save();

    // Customer-side payment row (the helper skips this when method='wallet'
    // so we can own the row from here and have a clean wallet statement
    // entry tied to this ride).
    const payment = await Payment.create({
      user: req.user!._id,
      ride: ride._id,
      type: 'ride_payment',
      amount,
      method: 'wallet',
      status: 'completed',
      description: `Ride payment: ₹${amount}`,
    });

    // Move the ride to `completed`, credit the driver, write the
    // commission/earnings rows, fire incentives — all centralised in the
    // helper so wallet/Razorpay/cash paths stay in sync.
    const { finalizeRideSettlement } = await import('./rideController');
    const settled = await finalizeRideSettlement(String(ride._id), 'wallet');

    // Tell the customer & driver (and any admin live tracker) the trip is
    // officially done. The customer's RideComplete screen listens for this
    // to refresh from the new ride doc and offer the rating sheet.
    try {
      const { emitToRide, emitToUser } = await import('../socket');
      const payload = { rideId: ride._id, status: 'completed', ride: settled };
      emitToRide(String(ride._id), 'ride:status', payload);
      emitToUser(String(ride.customer), 'ride:status', payload);
      if (ride.driver) emitToUser(String(ride.driver), 'ride:status', payload);
    } catch (e) {
      console.warn('[wallet-pay] socket emit failed:', e);
    }

    res.status(200).json({
      success: true,
      message: 'Ride paid from wallet',
      data: {
        payment,
        wallet: { balance: wallet.balance, currency: wallet.currency },
        ride: settled,
      },
    });
  } catch (error) {
    console.error('payRideFromWallet error:', error);
    res.status(500).json({ success: false, message: 'Wallet payment failed' });
  }
};

/**
 * POST /api/v1/payments/rides/:rideId/confirm-cash
 *
 * Driver-only. The driver collected cash from the rider at drop-off, so
 * we flip the ride from `payment_pending` to `completed` and settle the
 * driver's earnings. The customer-side Payment row is created inside the
 * settlement helper with method='cash'.
 */
export const confirmCashPayment = async (
  req: AuthRequest,
  res: Response,
): Promise<void> => {
  try {
    const { rideId } = req.params;
    const { Ride } = await import('../models');
    const ride = await Ride.findById(rideId);
    if (!ride) {
      res.status(404).json({ success: false, message: 'Ride not found' });
      return;
    }
    if (String(ride.driver) !== String(req.user!._id)) {
      res.status(403).json({ success: false, message: 'Not your ride' });
      return;
    }
    if (ride.status !== 'payment_pending') {
      res.status(400).json({
        success: false,
        message:
          ride.status === 'completed'
            ? 'This ride is already settled'
            : 'Ride is not awaiting payment',
      });
      return;
    }

    const { finalizeRideSettlement } = await import('./rideController');
    const settled = await finalizeRideSettlement(String(ride._id), 'cash');

    try {
      const { emitToRide, emitToUser } = await import('../socket');
      const payload = { rideId: ride._id, status: 'completed', ride: settled };
      emitToRide(String(ride._id), 'ride:status', payload);
      emitToUser(String(ride.customer), 'ride:status', payload);
      emitToUser(String(ride.driver), 'ride:status', payload);
    } catch (e) {
      console.warn('[cash-confirm] socket emit failed:', e);
    }

    res.status(200).json({
      success: true,
      message: 'Cash collection confirmed',
      data: { ride: settled },
    });
  } catch (error) {
    console.error('confirmCashPayment error:', error);
    res.status(500).json({ success: false, message: 'Cash confirmation failed' });
  }
};

/**
 * POST /api/v1/payments/webhook
 * Razorpay webhook handler (for server-to-server confirmation)
 */
export const razorpayWebhook = async (req: Request, res: Response): Promise<void> => {
  try {
    const webhookSecret = config.razorpay.webhookSecret;
    const signature = req.headers['x-razorpay-signature'] as string;

    const body = JSON.stringify(req.body);
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (expectedSignature !== signature) {
      res.status(400).json({ success: false, message: 'Invalid webhook signature' });
      return;
    }

    const event = req.body.event;
    const paymentEntity = req.body.payload?.payment?.entity;

    if (event === 'payment.captured' && paymentEntity) {
      const payment = await Payment.findOne({
        razorpayOrderId: paymentEntity.order_id,
      });

      if (payment && payment.status !== 'completed') {
        payment.status = 'completed';
        payment.razorpayPaymentId = paymentEntity.id;
        await payment.save();

        if (payment.type === 'wallet_topup') {
          await Wallet.findOneAndUpdate(
            { user: payment.user },
            { $inc: { balance: payment.walletCredit ?? payment.amount } },
            { upsert: true },
          );
          await collectPendingCancellationFees(payment.user);
        }
        // Mirror of the verifyPayment hook — if the webhook captures
        // before the client's verify call lands (async server-to-server
        // path), still settle the ride. The helper is idempotent so a
        // later verify call won't double-credit.
        if (payment.type === 'ride_payment' && payment.ride) {
          try {
            const { finalizeRideSettlement } = await import('./rideController');
            const settled = await finalizeRideSettlement(String(payment.ride), 'card');
            const { emitToRide, emitToUser } = await import('../socket');
            if (settled) {
              const evt = { rideId: settled._id, status: 'completed', ride: settled };
              emitToRide(String(settled._id), 'ride:status', evt);
              emitToUser(String(settled.customer), 'ride:status', evt);
              if (settled.driver) emitToUser(String(settled.driver), 'ride:status', evt);
            }
          } catch (e) {
            console.error('[webhook] settle failed:', e);
          }
        }
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('webhook error:', error);
    res.status(500).json({ success: false });
  }
};

/**
 * POST /api/v1/payments/wallet/topup (kept for backward compat — now uses Razorpay)
 */
export const topUpWallet = async (req: AuthRequest, res: Response): Promise<void> => {
  // Redirect to create-order flow
  return createOrder(req, res);
};

/**
 * POST /api/v1/payments/cancel-order
 * Marks a pending Payment row as 'failed' when the user dismisses the
 * Razorpay sheet without paying. Without this, the row sits in 'pending'
 * forever and shows up in the wallet statement as a yellow "Pending" badge
 * even though the user has long since moved on.
 *
 * The check on { user, status:'pending' } prevents an attacker from
 * flipping someone else's completed payment to failed.
 */
export const cancelOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { razorpay_order_id } = req.body;
    if (!razorpay_order_id) {
      res.status(400).json({ success: false, message: 'razorpay_order_id required' });
      return;
    }
    await Payment.findOneAndUpdate(
      {
        razorpayOrderId: razorpay_order_id,
        user: req.user!._id,
        status: 'pending',
      },
      { status: 'failed' },
    );
    res.status(200).json({ success: true });
  } catch (error) {
    console.error('cancelOrder error:', error);
    res.status(500).json({ success: false, message: 'Failed to mark order cancelled' });
  }
};

/**
 * GET /api/v1/payments/wallet/statement?page=1&limit=20
 * Paginated full transaction history grouped by month on the client.
 * Returns the user's Payment records, newest first.
 */
export const getWalletStatement = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const skip = (page - 1) * limit;

    const [items, total] = await Promise.all([
      Payment.find({ user: req.user!._id })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      Payment.countDocuments({ user: req.user!._id }),
    ]);

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch statement' });
  }
};

/**
 * GET /api/v1/payments/wallet/received
 * Lists driver earning entries with both gross fare and net (after commission).
 * Pulls from completed Rides where this user is the driver.
 */
export const getReceivedAmounts = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const page = Math.max(parseInt(req.query.page as string) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string) || 30, 100);
    const skip = (page - 1) * limit;

    const { Ride } = await import('../models/Ride');
    const [rides, total] = await Promise.all([
      Ride.find({ driver: req.user!._id, status: 'completed' })
        .sort({ completedAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(
          'actualFare estimatedFare commission driverEarnings tip completedAt createdAt',
        ),
      Ride.countDocuments({ driver: req.user!._id, status: 'completed' }),
    ]);

    const items = rides.map((r: any) => {
      const gross =
        r.actualFare ??
        r.estimatedFare ??
        (r.driverEarnings || 0) + (r.commission || 0);
      return {
        _id: String(r._id),
        grossFare: gross,
        commission: r.commission || 0,
        netEarnings: r.driverEarnings || 0,
        tip: r.tip || 0,
        at: r.completedAt || r.createdAt,
      };
    });

    res.status(200).json({
      success: true,
      data: {
        items,
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
      },
    });
  } catch (error) {
    console.error('getReceivedAmounts error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch received amounts' });
  }
};

/**
 * POST /api/v1/payments/wallet/cashout
 * Driver-initiated withdrawal. Debits the wallet immediately and creates a
 * pending Payment of type 'cashout' that ops team marks as completed once
 * the actual bank transfer settles.
 *
 * Body: { amount: number, method: 'bank' | 'upi', upiId?: string }
 */
export const requestCashout = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { amount, method = 'bank', upiId } = req.body as {
      amount?: number;
      method?: 'bank' | 'upi';
      upiId?: string;
    };

    const MIN = 100;
    const FEE = 5;

    if (!amount || amount < MIN) {
      res.status(400).json({
        success: false,
        message: `Minimum withdrawal amount is ₹${MIN}`,
      });
      return;
    }

    const totalDebit = amount + FEE;

    // Snapshot the destination so it survives later bank-detail edits.
    const user = await User.findById(req.user!._id);
    const bank = user?.driverProfile?.bankDetails;
    const accountLast4 = bank?.accountNumber
      ? bank.accountNumber.slice(-4)
      : undefined;

    if (method === 'bank' && !accountLast4) {
      res.status(400).json({
        success: false,
        message: 'Add a bank account before requesting a cashout.',
      });
      return;
    }
    if (method === 'upi' && !upiId) {
      res.status(400).json({
        success: false,
        message: 'Provide a UPI ID to cash out via UPI.',
      });
      return;
    }

    // Atomic conditional debit — only succeeds if balance >= totalDebit. The
    // previous read-check-save let two concurrent cashout requests both pass
    // the check and both save the same decremented balance, so the driver was
    // paid out twice for one debit. `$gte` in the filter makes the second
    // concurrent request find no matching doc.
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user!._id, balance: { $gte: totalDebit } },
      { $inc: { balance: -totalDebit } },
      { new: true },
    );
    if (!wallet) {
      res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance (including ₹5 transaction fee)',
      });
      return;
    }

    let payment;
    try {
      payment = await Payment.create({
        user: req.user!._id,
        type: 'cashout',
        amount,
        method: method === 'upi' ? 'upi' : 'bank_transfer',
        status: 'pending',
        payoutMethod: method,
        payoutDestination:
          method === 'bank'
            ? { bankName: bank?.bankName, accountLast4 }
            : { upiId },
        description:
          method === 'bank'
            ? `Cashout to ${bank?.bankName || 'bank'} ••••${accountLast4}`
            : `Cashout to UPI ${upiId}`,
      });
    } catch (err) {
      // Refund the debit atomically if the payment row couldn't be created.
      await Wallet.findOneAndUpdate(
        { user: req.user!._id },
        { $inc: { balance: totalDebit } },
      );
      throw err;
    }

    // Record the fee as a separate completed line so the statement is honest.
    if (FEE > 0) {
      await Payment.create({
        user: req.user!._id,
        type: 'commission',
        amount: FEE,
        method: 'wallet',
        status: 'completed',
        description: 'Cashout transaction fee',
      });
    }

    res.status(201).json({
      success: true,
      data: {
        payment,
        wallet: { balance: wallet.balance, currency: wallet.currency },
      },
    });
  } catch (error) {
    console.error('requestCashout error:', error);
    res.status(500).json({ success: false, message: 'Failed to request cashout' });
  }
};

// ════════════════════════════════════════════════
// Saved Payment Methods
// ════════════════════════════════════════════════

/**
 * GET /api/v1/payments/methods
 * Get all saved payment methods for the user
 */
export const getSavedMethods = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const methods = await SavedPaymentMethod.find({ user: req.user!._id }).sort({ isDefault: -1, createdAt: -1 });
    res.status(200).json({ success: true, data: { methods } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch payment methods' });
  }
};

/**
 * POST /api/v1/payments/methods
 * Save a new payment method (card, UPI, wallet)
 */
export const addSavedMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { type, brand, last4, cardHolderName, expiryMonth, expiryYear, upiId, walletProvider, walletEmail, label } = req.body;

    if (!type || !label) {
      res.status(400).json({ success: false, message: 'Type and label are required' });
      return;
    }

    // If setting as default, unset other defaults
    if (req.body.isDefault) {
      await SavedPaymentMethod.updateMany({ user: req.user!._id }, { isDefault: false });
    }

    const method = await SavedPaymentMethod.create({
      user: req.user!._id,
      type,
      brand,
      last4,
      cardHolderName,
      expiryMonth,
      expiryYear,
      upiId,
      walletProvider,
      walletEmail,
      label,
      isDefault: req.body.isDefault || false,
    });

    res.status(201).json({ success: true, data: { method } });
  } catch (error) {
    console.error('addSavedMethod error:', error);
    res.status(500).json({ success: false, message: 'Failed to save payment method' });
  }
};

/**
 * DELETE /api/v1/payments/methods/:id
 * Remove a saved payment method
 */
export const deleteSavedMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const method = await SavedPaymentMethod.findOneAndDelete({
      _id: req.params.id,
      user: req.user!._id,
    });

    if (!method) {
      res.status(404).json({ success: false, message: 'Payment method not found' });
      return;
    }

    res.status(200).json({ success: true, message: 'Payment method removed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to remove payment method' });
  }
};

/**
 * PUT /api/v1/payments/methods/:id/default
 * Set a payment method as default
 */
export const setDefaultMethod = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    await SavedPaymentMethod.updateMany({ user: req.user!._id }, { isDefault: false });
    const method = await SavedPaymentMethod.findOneAndUpdate(
      { _id: req.params.id, user: req.user!._id },
      { isDefault: true },
      { new: true },
    );

    if (!method) {
      res.status(404).json({ success: false, message: 'Payment method not found' });
      return;
    }

    res.status(200).json({ success: true, data: { method } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to set default method' });
  }
};

/**
 * POST /api/v1/payments/promo/validate
 */
export const validatePromo = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { code } = req.body;
    // Dynamic import to avoid circular dependency
    const { PromoCode } = await import('../models/Chat');

    const promo = await PromoCode.findOne({
      code: code?.toUpperCase(),
      isActive: true,
      expiresAt: { $gt: new Date() },
      $expr: { $lt: ['$usedCount', '$maxUses'] },
    });

    if (!promo) {
      res.status(404).json({ success: false, message: 'Invalid or expired promo code' });
      return;
    }

    res.status(200).json({
      success: true,
      data: {
        code: promo.code,
        type: promo.type,
        value: promo.value,
        maxDiscount: promo.maxDiscount,
        minFare: promo.minFare,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Promo validation failed' });
  }
};

/**
 * GET /api/v1/payments/driver/summary (Driver)
 * Earnings summary for driver
 */
export const getDriverEarnings = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { period = 'weekly' } = req.query;

    let dateFilter = new Date();
    switch (period) {
      case 'daily':
        dateFilter.setHours(0, 0, 0, 0);
        break;
      case 'weekly':
        dateFilter.setDate(dateFilter.getDate() - 7);
        break;
      case 'monthly':
        dateFilter.setMonth(dateFilter.getMonth() - 1);
        break;
      default:
        dateFilter.setDate(dateFilter.getDate() - 7);
    }

    const { Ride } = await import('../models/Ride');
    const rides = await Ride.find({
      driver: req.user!._id,
      status: 'completed',
      completedAt: { $gte: dateFilter },
    });

    const totalEarnings = rides.reduce((sum, r) => sum + r.driverEarnings, 0);
    const totalTrips = rides.length;
    const totalTips = rides.reduce((sum, r) => sum + r.tip, 0);
    const totalCommission = rides.reduce((sum, r) => sum + r.commission, 0);
    const totalDistance = rides.reduce((sum, r) => sum + (r.actualDistance || r.estimatedDistance), 0);
    const totalDuration = rides.reduce((sum, r) => sum + (r.actualDuration || r.estimatedDuration), 0);

    res.status(200).json({
      success: true,
      data: {
        period,
        totalEarnings: Math.round(totalEarnings * 100) / 100,
        totalTrips,
        totalTips: Math.round(totalTips * 100) / 100,
        totalCommission: Math.round(totalCommission * 100) / 100,
        totalDistance: Math.round(totalDistance * 10) / 10,
        totalDuration: Math.round(totalDuration),
        avgPerTrip: totalTrips > 0
          ? Math.round((totalEarnings / totalTrips) * 100) / 100
          : 0,
        avgPerHour: totalDuration > 0
          ? Math.round((totalEarnings / (totalDuration / 60)) * 100) / 100
          : 0,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get earnings' });
  }
};
