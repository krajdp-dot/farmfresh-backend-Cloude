console.log("🔥 THIS FILE IS RUNNING");
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
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

// ── FIREBASE ADMIN ────────────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
  });
  console.log('✅ Firebase Admin initialized');
}

// ── NODEMAILER ────────────────────────────────────────────────
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

async function notifyOwnerEmail(order) {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS) return;
  const items = order.items.map(i => `${i.name} x${i.qty} — Rs.${i.price * i.qty}`).join('\n');
  await mailer.sendMail({
    from: `"Farm Fresh Orders" <${process.env.GMAIL_USER}>`,
    to: process.env.GMAIL_USER,
    subject: `New Order from ${order.customerName || order.phone} — Rs.${order.total}`,
    text: `New order received!\n\nName: ${order.customerName || 'N/A'}\nPhone: ${order.phone}\nTotal: Rs.${order.total} (${order.paymentMethod?.toUpperCase()})\nSlot: ${order.deliverySlot}\nAddress: ${order.address?.fullAddress}\n\nItems:\n${items}`,
  });
}

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
    name: String, qty: Number, price: Number, mrp: Number, unit: String,
  }],
  address: { fullAddress: String, pincode: String },
  notes: String,
  subtotal: Number,
  discount: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 },
  platformFee: { type: Number, default: 0 },
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

const SubscriptionSchema = new mongoose.Schema({
  customerName: String,
  phone: { type: String, required: true, index: true },
  address: { fullAddress: String, pincode: String },
  basketItems: [{
    itemId: String,
    name: String,
    emoji: String,
    qty: Number,
    unit: String,
    price: Number,
  }],
  frequency: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
  deliveryDay: { type: String, default: 'Saturday' },
  payType: { type: String, enum: ['upfront', 'per_delivery'], default: 'upfront' },
  basketTotal: Number,
  upfrontTotal: Number,
  status: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
  nextDelivery: Date,
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', UserSchema);
const Product = mongoose.model('Product', ProductSchema);
const Order = mongoose.model('Order', OrderSchema);
const Subscription = mongoose.model('Subscription', SubscriptionSchema);

// ── HELPERS ───────────────────────────────────────────────────

// Notify owner via Telegram
async function notifyOwnerTelegram(message) {
  const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8703112237:AAGK_OHusDHFZiYlpKc098XOAR1RkBKIcf4';
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '8797240896';
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text: message, parse_mode: 'Markdown' }),
    });
    const data = await res.json();
    console.log('Telegram notify:', data.ok ? '✅ Sent' : data);
  } catch (e) { console.error('Telegram notify failed:', e); }
}

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
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── ROUTES: AUTH ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ success: true, message: 'Farm Fresh API' }));
app.get('/api/ping', (req, res) => res.json({ ok: true })); // 
module.exports = app;
require('./keepalive'); // ← add this

app.post('/api/auth/verify-firebase-token', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'No token provided' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = decoded.phone_number?.replace('+91', '');
    if (!phone) return res.status(400).json({ error: 'No phone in token' });
    let user = await User.findOne({ phone });
    const isNew = !user;
    if (!user) {
      user = await User.create({
        phone,
        referralCode: 'FF' + Math.random().toString(36).substr(2, 6).toUpperCase(),
      });
    }
    const token = jwt.sign(
      { userId: user._id },
      process.env.JWT_SECRET || 'farmfresh_secret',
      { expiresIn: '30d' }
    );
    res.json({ success: true, token, user, isNew });
  } catch (err) {
    console.error('Firebase verify error:', err);
    res.status(401).json({ error: 'Invalid Firebase token' });
  }
});

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
  } catch (err) { res.status(500).json({ error: 'Failed to fetch products' }); }
});

app.get('/api/products/:id', async (req, res) => {
  const product = await Product.findById(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });
  res.json({ product });
});

// ── ROUTES: ORDERS ────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { items, address, phone, customerName, notes, deliverySlot, paymentMethod, couponCode } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!phone || !address?.fullAddress) return res.status(400).json({ error: 'Phone and address required' });

    let user = await User.findOne({ phone });
    if (!user) {
      user = await User.create({ phone, name: customerName, referralCode: 'FF' + Math.random().toString(36).substr(2, 6).toUpperCase() });
    } else if (customerName && !user.name) {
      user.name = customerName; await user.save();
    }

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isAvailable || product.stock < item.qty)
        return res.status(400).json({ error: `${product?.name || 'Item'} is unavailable` });
      subtotal += product.price * item.qty;
      validatedItems.push({ productId: product._id, name: product.name, qty: item.qty, price: product.price, mrp: product.mrp, unit: product.unit });
      await Product.findByIdAndUpdate(product._id, { $inc: { stock: -item.qty, totalSold: item.qty } });
    }

    let discount = 0;
    if (couponCode === 'KISAN80' && !user.hasUsedFirstOrderCoupon && subtotal >= 199) {
      discount = 80; user.hasUsedFirstOrderCoupon = true; await user.save();
    }

    const deliveryFee = subtotal >= 299 ? 0 : 29;
    const platformFee = 0;
    const total = Math.max(0, subtotal - discount + deliveryFee + platformFee);

    let razorpayOrderId = null;
    if (paymentMethod !== 'cod' && razorpay) {
      const rzOrder = await razorpay.orders.create({ amount: total * 100, currency: 'INR', receipt: `ff_${Date.now()}` });
      razorpayOrderId = rzOrder.id;
    }

    const order = await Order.create({
      userId: user._id, customerName: customerName || user.name, phone,
      items: validatedItems, address, notes,
      subtotal, discount, deliveryFee, platformFee, total,
      paymentMethod: paymentMethod || 'cod',
      paymentStatus: 'pending',
      razorpayOrderId,
      deliverySlot: deliverySlot || 'Today, 6-9 PM',
      status: 'placed',
      timeline: [{ status: 'placed', note: 'Order received', timestamp: new Date() }],
    });

    await User.findByIdAndUpdate(user._id, { $inc: { totalOrders: 1 } });

    const itemsList = validatedItems.map(i => `  - ${i.name} x${i.qty} - Rs.${i.price * i.qty}`).join('\n');
    const msg =
      `*New Order - Farm Fresh!*\n\n` +
      `*${order.customerName}*\n` +
      `Ph: ${order.phone}\n` +
      `Addr: ${order.address?.fullAddress}\n\n` +
      `*Items:*\n${itemsList}\n\n` +
      `*Total: Rs.${order.total}* (${order.paymentMethod.toUpperCase()})\n` +
      `Slot: ${order.deliverySlot || 'Today, 6-9 PM'}`;
    notifyOwnerTelegram(msg).catch(console.error);
    notifyOwnerEmail(order).catch(err => console.error('Email notify error:', err));

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
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
    if (expectedSig !== razorpaySignature)
      return res.status(400).json({ error: 'Payment verification failed' });
    await Order.findOneAndUpdate(
      { razorpayOrderId },
      { paymentStatus: 'paid', razorpayPaymentId, status: 'confirmed', $push: { timeline: { status: 'confirmed', note: 'Payment received' } } }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Verification error' }); }
});

// ── ROUTES: SUBSCRIPTIONS ─────────────────────────────────────
app.post('/api/subscriptions', async (req, res) => {
  try {
    const { customerName, phone, address, basketItems, frequency, deliveryDay, payType, basketTotal, upfrontTotal } = req.body;
    if (!phone || !address?.fullAddress || !basketItems?.length)
      return res.status(400).json({ error: 'Missing required fields' });

    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const targetDay = days.indexOf(deliveryDay);
    const now = new Date();
    const daysUntil = (targetDay - now.getDay() + 7) % 7 || 7;
    const nextDelivery = new Date(now);
    nextDelivery.setDate(now.getDate() + daysUntil);

    const subscription = await Subscription.create({
      customerName, phone, address, basketItems,
      frequency, deliveryDay, payType,
      basketTotal, upfrontTotal, nextDelivery, status: 'active',
    });

    const itemsList = basketItems.map(i => `  - ${i.name} x${i.qty}${i.unit}`).join('\n');
    const msg =
      `*New Subscription - Farm Fresh!*\n\n` +
      `*${customerName}*\n` +
      `Ph: ${phone}\n` +
      `Addr: ${address.fullAddress}\n\n` +
      `*Basket:*\n${itemsList}\n\n` +
      `*${frequency}* every ${deliveryDay}\n` +
      `Rs.${basketTotal}/delivery\n` +
      `First delivery: ${nextDelivery.toDateString()}`;
    notifyOwnerTelegram(msg).catch(console.error);

    res.status(201).json({ success: true, subscription });
  } catch (err) {
    console.error('Subscription error:', err);
    res.status(500).json({ error: 'Failed to create subscription' });
  }
});

app.get('/api/subscriptions/:phone', async (req, res) => {
  const subs = await Subscription.find({ phone: req.params.phone, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 });
  res.json({ subscriptions: subs });
});

app.patch('/api/subscriptions/:id/pause', async (req, res) => {
  const sub = await Subscription.findByIdAndUpdate(req.params.id, { status: 'paused' }, { new: true });
  res.json({ success: true, subscription: sub });
});

app.patch('/api/subscriptions/:id/resume', async (req, res) => {
  const sub = await Subscription.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true });
  res.json({ success: true, subscription: sub });
});

app.delete('/api/subscriptions/:id', async (req, res) => {
  await Subscription.findByIdAndUpdate(req.params.id, { status: 'cancelled' });
  res.json({ success: true });
});

// ── ROUTES: ADMIN ─────────────────────────────────────────────
app.post('/api/admin/products', async (req, res) => {
  try {
    const product = await Product.create(req.body);
    res.status(201).json({ product });
  } catch (err) { res.status(500).json({ error: err.message }); }
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
  const orders = await Order.find().sort({ createdAt: -1 }).limit(100);
  res.json({ orders });
});

app.patch('/api/admin/orders/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const order = await Order.findByIdAndUpdate(req.params.id,
    { status, $push: { timeline: { status, note, timestamp: new Date() } } }, { new: true });
  res.json({ success: true, order });
});

app.get('/api/admin/analytics', async (req, res) => {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [todayOrders, totalOrders, totalUsers] = await Promise.all([
    Order.find({ createdAt: { $gte: today } }),
    Order.countDocuments(),
    User.countDocuments(),
  ]);
  res.json({ todayOrders: todayOrders.length, todayGMV: todayOrders.reduce((s, o) => s + (o.total || 0), 0), totalOrders, totalUsers });
});

app.get('/api/admin/subscriptions', async (req, res) => {
  const subs = await Subscription.find().sort({ createdAt: -1 }).limit(100);
  res.json({ subscriptions: subs });
});

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Farm Fresh API on port ${PORT}`));
module.exports = app;

