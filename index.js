// ============================================================
// KisanDirect — Complete Backend (Node.js + Express + MongoDB)
// Production-ready starter. Run: npm install && node server.js
// ============================================================

console.log("🔥 THIS FILE IS RUNNING");
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.get("/", (req, res) => {
  console.log("✅ ROOT HIT");
  res.send("ROOT WORKING 🚀");
});

// ─── MIDDLEWARE ───────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));

// ─── DATABASE ─────────────────────────────────────────────
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/kisandirect')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

// ─── FIREBASE ADMIN ───────────────────────────────────────
// Firebase disabled for now
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
    });
  }
} catch (e) {
  console.log("Firebase not configured, skipping...");
}

// ─── RAZORPAY ─────────────────────────────────────────────
let razorpay;

try {
  if (process.env.RAZORPAY_KEY_ID) {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_SECRET,
    });
  }
} catch (e) {
  console.log("Razorpay not configured, skipping...");
}

// ════════════════════════════════════════════════════════════
// SCHEMAS
// ════════════════════════════════════════════════════════════

const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: String,
  email: String,
  fcmToken: String,
  addresses: [{
    label: String,
    fullAddress: String,
    lat: Number,
    lng: Number,
    pincode: String,
  }],
  defaultAddressIndex: { type: Number, default: 0 },
  subscription: {
    plan: { type: String, enum: ['none', 'daily', 'weekly', 'bulk'], default: 'none' },
    active: { type: Boolean, default: false },
    startDate: Date,
    nextBillingDate: Date,
  },
  wallet: { type: Number, default: 0 },
  referralCode: { type: String, unique: true },
  referredBy: String,
  hasUsedFirstOrderCoupon: { type: Boolean, default: false },
  totalOrders: { type: Number, default: 0 },
  isBlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const FarmerSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  village: String,
  district: String,
  state: { type: String, default: 'Bihar' },
  farmSize: Number,
  crops: [String],
  profileImage: String,
  bio: String,
  bankAccount: {
    accountNumber: String,
    ifscCode: String,
    holderName: String,
  },
  rating: { type: Number, default: 5.0 },
  totalOrders: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  verificationStatus: { type: String, enum: ['pending', 'verified', 'rejected'], default: 'pending' },
  isActive: { type: Boolean, default: true },
  joinedDate: { type: Date, default: Date.now },
});

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, enum: ['fruits', 'veggies', 'dryfruits', 'spices'], required: true },
  emoji: String,
  images: [String],
  farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Farmer' },
  origin: String,
  unit: String,
  unitWeight: Number,
  price: { type: Number, required: true },
  mrp: { type: Number, required: true },
  farmPrice: Number,
  stock: { type: Number, default: 0 },
  isAvailable: { type: Boolean, default: true },
  tags: [String],
  harvestDate: Date,
  expiryDate: Date,
  certifications: [String],
  rating: { type: Number, default: 4.5 },
  totalSold: { type: Number, default: 0 },
});

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  items: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    farmerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Farmer' },
    name: String,
    emoji: String,
    qty: Number,
    price: Number,
    mrp: Number,
    unit: String,
  }],
  address: {
    fullAddress: String,
    lat: Number,
    lng: Number,
    pincode: String,
  },
  subtotal: Number,
  discount: { type: Number, default: 0 },
  walletUsed: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  total: Number,
  paymentMethod: { type: String, enum: ['upi', 'card', 'cod', 'wallet'] },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  status: {
    type: String,
    enum: ['placed', 'confirmed', 'packing', 'quality_check', 'dispatched', 'delivered', 'cancelled'],
    default: 'placed'
  },
  deliverySlot: String,
  deliveryAgentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  timeline: [{ status: String, note: String, timestamp: { type: Date, default: Date.now } }],
  rating: Number,
  review: String,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);
const Farmer = mongoose.model('Farmer', FarmerSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
app.get("/", (req, res) => {
  res.json({
    success: true,
    message: "Farm Fresh backend is running 🚀",
  });
});

// ════════════════════════════════════════════════════════════
// AUTH MIDDLEWARE
// ════════════════════════════════════════════════════════════

const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);
    if (!user || user.isBlocked) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

const adminAuth = async (req, res, next) => {
  // Add admin check logic — e.g. user.role === 'admin'
  auth(req, res, next);
};

// In-memory OTP store (use Redis in production)
const otpStore = new Map();

// ════════════════════════════════════════════════════════════
// ROUTES — AUTH
// ════════════════════════════════════════════════════════════

// POST /api/auth/send-otp
app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone || !/^[6-9]\d{9}$/.test(phone)) {
      return res.status(400).json({ error: 'Invalid phone number' });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore.set(phone, { otp, expires: Date.now() + 5 * 60 * 1000 });

    // In production: use Firebase Auth or MSG91 to send real SMS
    // await sendSMS(phone, `Your KisanDirect OTP: ${otp}`);

    console.log(`OTP for ${phone}: ${otp}`); // Dev only
    res.json({ success: true, message: 'OTP sent', ...(process.env.NODE_ENV === 'development' && { otp }) });
  } catch (err) {
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
        referralCode: 'KD' + Math.random().toString(36).substr(2, 6).toUpperCase(),
      });
    }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user, isNew });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// PATCH /api/auth/profile
app.patch('/api/auth/profile', auth, async (req, res) => {
  const { name, email, fcmToken } = req.body;
  const updated = await User.findByIdAndUpdate(req.user._id, { name, email, fcmToken }, { new: true });
  res.json({ user: updated });
});

// ════════════════════════════════════════════════════════════
// ROUTES — PRODUCTS
// ════════════════════════════════════════════════════════════

// GET /api/products
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, sort = 'default', limit = 20, skip = 0 } = req.query;
    const query = { isAvailable: true, stock: { $gt: 0 } };
    if (category) query.category = category;
    if (search) query.name = { $regex: search, $options: 'i' };
    const sortMap = {
      'price_asc': { price: 1 },
      'price_desc': { price: -1 },
      'discount': { mrp: -1 },
      'default': { totalSold: -1 },
    };
    const products = await Product.find(query)
      .sort(sortMap[sort])
      .limit(parseInt(limit))
      .skip(parseInt(skip))
      .populate('farmerId', 'name village district rating');
    const total = await Product.countDocuments(query);
    res.json({ products, total });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// GET /api/products/:id
app.get('/api/products/:id', async (req, res) => {
  const product = await Product.findById(req.params.id).populate('farmerId');
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ product });
});

// ════════════════════════════════════════════════════════════
// ROUTES — ORDERS
// ════════════════════════════════════════════════════════════

// POST /api/orders
app.post('/api/orders', async (req, res) => {
  try {
    const { items, addressIndex = 0, deliverySlot, paymentMethod, couponCode } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });

    let subtotal = 0;
    const validatedItems = [];

    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isAvailable || product.stock < item.qty) {
        return res.status(400).json({ error: `${item.name || 'Item'} unavailable` });
      }
      subtotal += product.price * item.qty;
      validatedItems.push({
        productId: product._id,
        farmerId: product.farmerId,
        name: product.name,
        emoji: product.emoji,
        qty: item.qty,
        price: product.price,
        mrp: product.mrp,
        unit: product.unit,
      });
      await Product.findByIdAndUpdate(product._id, {
        $inc: { stock: -item.qty, totalSold: item.qty }
      });
    }

    let discount = 0;
    if (couponCode === 'KISAN80' && !req.user.hasUsedFirstOrderCoupon && subtotal >= 199) {
      discount = 80;
      req.user.hasUsedFirstOrderCoupon = true;
      await req.user.save();
    }

    const deliveryFee = subtotal >= 399 ? 0 : 29;
    const total = Math.max(0, subtotal - discount + deliveryFee);
    const userAddress = req.user.addresses[addressIndex] || req.user.addresses[0];

    let razorpayOrderId = null;
    if (paymentMethod !== 'cod') {
      const rzOrder = await razorpay.orders.create({
        amount: total * 100,
        currency: 'INR',
        receipt: `kd_${Date.now()}`,
      });
      razorpayOrderId = rzOrder.id;
    }

    const order = await Order.create({
      userId: req.user._id,
      items: validatedItems,
      address: userAddress,
      subtotal, discount, deliveryFee, total,
      paymentMethod,
      paymentStatus: paymentMethod === 'cod' ? 'pending' : 'pending',
      razorpayOrderId,
      deliverySlot,
      status: 'placed',
      timeline: [{ status: 'placed', note: 'Order received', timestamp: new Date() }],
    });

    await User.findByIdAndUpdate(req.user._id, { $inc: { totalOrders: 1 } });

    if (req.user.fcmToken) {
      await admin.messaging().send({
        token: req.user.fcmToken,
        notification: {
          title: '🌿 Order Confirmed!',
          body: `Order #KD-${order._id.toString().slice(-5)} is being packed. Arriving ${deliverySlot}.`,
        },
      }).catch(console.error);
    }

    res.status(201).json({ success: true, order, razorpayOrderId, total });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Order failed. Please try again.' });
  }
});

// GET /api/orders — User order history
app.get('/api/orders', auth, async (req, res) => {
  const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20);
  res.json({ orders });
});

// GET /api/orders/:id — Order detail
app.get('/api/orders/:id', auth, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, userId: req.user._id });
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

// ════════════════════════════════════════════════════════════
// ROUTES — PAYMENTS
// ════════════════════════════════════════════════════════════

// POST /api/payments/verify
app.post('/api/payments/verify', auth, async (req, res) => {
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
      {
        paymentStatus: 'paid', razorpayPaymentId, status: 'confirmed',
        $push: { timeline: { status: 'confirmed', note: 'Payment received', timestamp: new Date() } }
      }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Verification error' });
  }
});

// ════════════════════════════════════════════════════════════
// ROUTES — FARMERS
// ════════════════════════════════════════════════════════════

// GET /api/farmers/:id
app.get('/api/farmers/:id', async (req, res) => {
  const farmer = await Farmer.findById(req.params.id).select('-bankAccount');
  if (!farmer) return res.status(404).json({ error: 'Farmer not found' });
  const products = await Product.find({ farmerId: farmer._id, isAvailable: true });
  res.json({ farmer, products });
});

// POST /api/farmers/onboard
app.post('/api/farmers/onboard', async (req, res) => {
  try {
    const { name, phone, village, district, farmSize, crops } = req.body;
    const farmer = await Farmer.create({ name, phone, village, district, farmSize, crops });
    res.status(201).json({ success: true, farmer });
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: 'Phone already registered' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

// ════════════════════════════════════════════════════════════
// ROUTES — ADMIN
// ════════════════════════════════════════════════════════════

// PATCH /api/admin/orders/:id/status
app.patch('/api/admin/orders/:id/status', adminAuth, async (req, res) => {
  const { status, note } = req.body;
  const order = await Order.findByIdAndUpdate(
    req.params.id,
    { status, $push: { timeline: { status, note, timestamp: new Date() } } },
    { new: true }
  ).populate('userId', 'fcmToken name phone');

  const msgs = {
    packing: { title: '🌾 Being packed!', body: 'Your fresh produce is being packed at the farm.' },
    dispatched: { title: '🛵 On the way!', body: 'Your order is out for delivery. ETA: ~45 mins.' },
    delivered: { title: '✅ Delivered!', body: 'Enjoy your fresh produce! How was your experience?' },
  };

  if (order.userId?.fcmToken && msgs[status]) {
    await admin.messaging().send({
      token: order.userId.fcmToken,
      notification: msgs[status],
    }).catch(console.error);
  }

  res.json({ success: true, order });
});

// GET /api/admin/analytics
app.get('/api/admin/analytics', adminAuth, async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [todayOrders, totalOrders, totalUsers, totalFarmers] = await Promise.all([
    Order.find({ createdAt: { $gte: today } }),
    Order.countDocuments(),
    User.countDocuments(),
    Farmer.countDocuments({ verificationStatus: 'verified' }),
  ]);
  const todayGMV = todayOrders.reduce((s, o) => s + o.total, 0);
  const todayRevenue = todayOrders.reduce((s, o) => s + (o.total - o.subtotal * 0.6), 0);
  res.json({ todayOrders: todayOrders.length, todayGMV, todayRevenue, totalOrders, totalUsers, totalFarmers });
});

// POST /api/admin/products
app.post('/api/admin/products', async (req, res) => {
  const product = await Product.create(req.body);
  res.status(201).json({ product });
});

// PATCH /api/admin/products/:id
app.patch('/api/admin/products/:id', async (req, res) => {
  const product = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true });
  res.json({ product });
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

// ─── START ────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 KisanDirect API running on port ${PORT}`));

module.exports = app;
