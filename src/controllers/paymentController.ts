import { Request, Response } from 'express';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Payment, Wallet, User, SavedPaymentMethod } from '../models';
import { AuthRequest } from '../middleware/auth';
import { config } from '../config';

const razorpay = new Razorpay({
  key_id: config.razorpay.keyId,
  key_secret: config.razorpay.keySecret,
});

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
export const createOrder = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { amount, type = 'wallet_topup', rideId, methodPreference } = req.body;
    if (!amount || amount <= 0) {
      res.status(400).json({ success: false, message: 'Invalid amount' });
      return;
    }

    // Razorpay expects amount in paise (smallest currency unit)
    const order = await razorpay.orders.create({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      notes: {
        userId: req.user!._id.toString(),
        type,
        ...(rideId && { rideId }),
      },
    });

    // Create a pending payment record
    const payment = await Payment.create({
      user: req.user!._id,
      ...(rideId && { ride: rideId }),
      type,
      amount,
      method: methodPreference === 'wallet' ? 'wallet' : 'card',
      status: 'pending',
      razorpayOrderId: order.id,
      description: type === 'wallet_topup'
        ? `Wallet top-up: ₹${amount}`
        : `Ride payment: ₹${amount}`,
    });

    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        amount: order.amount,
        currency: order.currency,
        paymentId: payment._id,
        keyId: config.razorpay.keyId,
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
var options={key:"${keyId}",amount:"${amount}",currency:"${currency}",name:"UKCAAR",
description:"UKCAAR Payment",order_id:"${orderId}",
theme:{color:"#0097B3"},
handler:function(r){window.location.href="${callbackUrl}?razorpay_payment_id="+r.razorpay_payment_id+"&razorpay_order_id="+r.razorpay_order_id+"&razorpay_signature="+r.razorpay_signature;},
modal:{ondismiss:function(){window.location.href="${callbackUrl}?cancelled=true";}}};
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
      const payment = await Payment.findOneAndUpdate(
        { razorpayOrderId: razorpay_order_id as string },
        { status: 'completed', razorpayPaymentId: razorpay_payment_id as string },
        { new: true },
      );

      if (payment) {
        success = true;
        if (payment.type === 'wallet_topup') {
          await Wallet.findOneAndUpdate(
            { user: payment.user },
            { $inc: { balance: payment.amount } },
            { upsert: true },
          );
        }
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

    // Update payment record
    const payment = await Payment.findOneAndUpdate(
      { razorpayOrderId: razorpay_order_id },
      {
        status: 'completed',
        razorpayPaymentId: razorpay_payment_id,
      },
      { new: true },
    );

    if (!payment) {
      res.status(404).json({ success: false, message: 'Payment record not found' });
      return;
    }

    // If wallet topup, credit the wallet
    if (payment.type === 'wallet_topup') {
      await Wallet.findOneAndUpdate(
        { user: payment.user },
        { $inc: { balance: payment.amount } },
        { upsert: true, new: true },
      );
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
            { $inc: { balance: payment.amount } },
            { upsert: true },
          );
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
