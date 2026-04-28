console.log("🔥 THIS FILE IS RUNNING");
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/farmfresh')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

let razorpay;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_SECRET) {
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });
    console.log('✅ Razorpay initialized');
  }
} catch (e) { console.log('Razorpay not configured'); }

// ── SCHEMAS ──────────────────────────────────────────────────

const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: String,
  email: String,
  addresses: [{ label: String, fullAddress: String, pincode: String }],
  wallet: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  hasUsedFirstOrderCoupon: { type: Boolean, default: false },
  totalOrders: { type: Number, default: 0 },
  isBlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, enum: ['fruits', 'veggies', 'dryfruits', 'spices'], required: true },
  emoji: String,
  images: [String],
  unit: String,
  price: { type: Number, required: true },
  mrp: { type: Number, required: true },
  stock: { type: Number, default: 0 },
  isAvailable: { type: Boolean, default: true },
  tags: [String],
  certifications: [String],
  rating: { type: Number, default: 4.5 },
  totalSold: { type: Number, default: 0 },
});

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customerName: String,
  phone: String,
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    qty: Number,
    price: Number,
    mrp: Number,
    unit: String,
  }],
  address: { fullAddress: String, pincode: String },
  notes: String,
  subtotal: Number,
  discount: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  total: Number,
  paymentMethod: { type: String, enum: ['upi', 'card', 'cod', 'wallet'] },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  status: {
    type: String,
    enum: ['placed', 'confirmed', 'packing', 'dispatched', 'delivered', 'cancelled'],
    default: 'placed',
  },
  deliverySlot: String,
  timeline: [{ status: String, note: String, timestamp: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);

// ── AUTH MIDDLEWARE ───────────────────────────────────────────

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'farmfresh_secret');
    const user = await User.findById(decoded.userId);
    if (!user || user.isBlocked) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// In-memory OTP store
const otpStore = new Map();

// ── ROUTES: AUTH ──────────────────────────────────────────────

app.get('/', (req, res) => res.json({ success: true, message: 'Farm Fresh backend 🚀' }));

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });

    // Send SMS via Fast2SMS
    if (process.env.FAST2SMS_API_KEY) {
      try {
        const smsRes = await fetch('https://www.fast2sms.com/dev/bulkV2', {
          method: 'POST',
          headers: {
            'authorization': process.env.FAST2SMS_API_KEY,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            route: 'otp',
            variables_values: otp,
            numbers: phone,
            flash: '0',
          }),
        });
        const smsData = await smsRes.json();
        console.log('Fast2SMS response:', smsData);
      } catch (smsErr) {
        console.error('SMS send failed:', smsErr);
      }
    }

    console.log(`OTP for ${phone}: ${otp}`);
    res.json({ success: true, message: 'OTP sent' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, otp } = req.body;
    const stored = otpStore.get(phone);
    if (!stored || stored.otp !== otp || Date.now() > stored.expires) {
      return res.status(400).json({ error: 'Invalid or expired OTP' });
    }
    otpStore.delete(phone);
    let user = await User.findOne({ phone });
    const isNew = !user;
    if (!user) {
      user = await User.create({
        phone,
        referralCode: 'FF' + Math.random().toString(36).substr(2, 6).toUpperCase(),
      });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'farmfresh_secret', { expiresIn: '30d' });
    res.json({ success: true, token, user, isNew });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// PATCH /api/auth/profile
app.patch('/api/auth/profile', auth, async (req, res) => {
  const { name, email } = req.body;
  const updated = await User.findByIdAndUpdate(req.user._id, { name, email }, { new: true });
  res.json({ user: updated });
});

// ── ROUTES: PRODUCTS ─────────────────────────────────────────

app.get('/api/products', async (req, res) => {
  try {
    const { category, search, sort = 'default', limit = 50, skip = 0 } = req.query;
    const query = { isAvailable: true, stock: { $gt: 0 } };
    if (category) query.category = category;
    if (search) query.name = { $regex: search, $options: 'i' };
    const sortMap = { price_asc: { price: 1 }, price_desc: { price: -1 }, default: { totalSold: -1 } };
    const products = await Product.find(query).sort(sortMap[sort] || sortMap.default).limit(parseInt(limit)).skip(parseInt(skip));
    const total = await Product.countDocuments(query);
    res.json({ products, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ product });
});

// ── ROUTES: ORDERS ────────────────────────────────────────────

// POST /api/orders — Guest-friendly, no auth required
app.post('/api/orders', async (req, res) => {
  try {
    const { items, address, phone, customerName, notes, deliverySlot, paymentMethod, couponCode } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!phone || !address?.fullAddress) return res.status(400).json({ error: 'Phone and address required' });

    // Find or create user by phone
    let user = await User.findOne({ phone });
    if (!user) {
      user = await User.create({
        phone,
        name: customerName,
        referralCode: 'FF' + Math.random().toString(36).substr(2, 6).toUpperCase(),
      });
    } else if (customerName && !user.name) {
      user.name = customerName;
      await user.save();
    }

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isAvailable || product.stock < item.qty) {
        return res.status(400).json({ error: `${product?.name || 'Item'} is unavailable` });
      }
      subtotal += product.price * item.qty;
      validatedItems.push({
        productId: product._id,
        name: product.name,
        qty: item.qty,
        price: product.price,
        mrp: product.mrp,
        unit: product.unit,
      });
      await Product.findByIdAndUpdate(product._id, { $inc: { stock: -item.qty, totalSold: item.qty } });
    }

    // Coupon
    let discount = 0;
    if (couponCode === 'KISAN80' && !user.hasUsedFirstOrderCoupon && subtotal >= 199) {
      discount = 80;
      user.hasUsedFirstOrderCoupon = true;
      await user.save();
    }

    const deliveryFee = subtotal >= 399 ? 0 : 29;
    const total = Math.max(0, subtotal - discount + deliveryFee);

    // Razorpay order
    let razorpayOrderId = null;
    if (paymentMethod !== 'cod' && razorpay) {
      const rzOrder = await razorpay.orders.create({
        amount: total * 100,
        currency: 'INR',
        receipt: `ff_${Date.now()}`,
      });
      razorpayOrderId = rzOrder.id;
    }

    const order = await Order.create({
      userId: user._id,
      customerName: customerName || user.name,
      phone,
      items: validatedItems,
      address,
      notes,
      subtotal, discount, deliveryFee, total,
      paymentMethod: paymentMethod || 'cod',
      paymentStatus: 'pending',
      razorpayOrderId,
      deliverySlot: deliverySlot || 'Today, 6–9 PM',
      status: 'placed',
      timeline: [{ status: 'placed', note: 'Order received', timestamp: new Date() }],
    });

    await User.findByIdAndUpdate(user._id, { $inc: { totalOrders: 1 } });

    res.status(201).json({ success: true, order, razorpayOrderId, total });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ error: 'Order failed. Please try again.' });
  }
});

app.get('/api/orders', auth, async (req, res) => {
  const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20);
  res.json({ orders });
});

app.get('/api/orders/:id', auth, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

// ── ROUTES: PAYMENTS ─────────────────────────────────────────

app.post('/api/payments/verify', async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const expectedSig = crypto
      .createHmac('sha256', process.env.RAZORPAY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');
    if (expectedSig !== razorpaySignature) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }
    await Order.findOneAndUpdate(
      { razorpayOrderId },
      { paymentStatus: 'paid', razorpayPaymentId, status: 'confirmed', $push: { timeline: { status: 'confirmed', note: 'Payment received' } } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification error' });
  }
});

// ── ROUTES: ADMIN ────────────────────────────────────────────

app.post('/api/admin/products', async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json({ product });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/admin/products/:id', async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ product });
});

app.delete('/api/admin/products/:id', async (req, res) => {
  await Product.findByIdAndDelete(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/orders', async (req, res) => {
  const orders = await Order.find().sort({ createdAt: -1 }).limit(50);
  res.json({ orders });
});

app.patch('/api/admin/orders/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status, $push: { timeline: { status, note, timestamp: new Date() } } },
    { new: true }
  );
  res.json({ success: true, order });
});

app.get('/api/admin/analytics', async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [todayOrders, totalOrders, totalUsers] = await Promise.all([
    Order.find({ createdAt: { $gte: today } }),
    Order.countDocuments(),
    User.countDocuments(),
  ]);
  const todayGMV = todayOrders.reduce((s, o) => s + (o.total || 0), 0);
  res.json({ todayOrders: todayOrders.length, todayGMV, totalOrders, totalUsers });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Farm Fresh API running on port ${PORT}`));
module.exports = app;
