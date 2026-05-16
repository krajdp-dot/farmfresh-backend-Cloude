console.log('🔥 Farm Fresh API starting...');

const express    = require('express');
const mongoose   = require('mongoose');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const jwt        = require('jsonwebtoken');
const Razorpay   = require('razorpay');
const crypto     = require('crypto');
const admin      = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/farmfresh')
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err));

let razorpay;
try {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_SECRET) {
    razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_SECRET });
    console.log('✅ Razorpay initialized');
  }
} catch (e) { console.log('⚠️  Razorpay not configured'); }

try {
  if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    console.log('✅ Firebase Admin initialized');
  }
} catch (e) { console.log('⚠️  Firebase not configured:', e.message); }

let mailer;
if (process.env.GMAIL_USER && process.env.GMAIL_PASS) {
  mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_PASS } });
  console.log('✅ Nodemailer initialized');
}

const otpStore = new Map();

// ── SCHEMAS ───────────────────────────────────────────────────
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true, index: true },
  name: String, email: String,
  addresses: [{ label: String, fullAddress: String, pincode: String }],
  wallet: { type: Number, default: 0 },
  referralCode: { type: String, unique: true, sparse: true },
  hasUsedFirstOrderCoupon: { type: Boolean, default: false },
  totalOrders: { type: Number, default: 0 },
  isBlocked: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now },
});

const ProductSchema = new mongoose.Schema({
  name: { type: String, required: true },
  category: { type: String, enum: ['fruits', 'veggies', 'dryfruits', 'spices'], required: true },
  emoji: String, images: [String], unit: String,
  price: { type: Number, required: true }, mrp: { type: Number, required: true },
  stock: { type: Number, default: 999 }, isAvailable: { type: Boolean, default: true },
  comingSoon: { type: Boolean, default: false },
  availableIn: { type: String, default: '' },
  quantityPresets: { type: [String], default: [] }, // e.g. ["500g","1 kg","2 kg"]
  baseUnit: { type: String, default: '' },          // base unit for custom qty scaling e.g. "kg"
  tags: [String], certifications: [String],
  rating: { type: Number, default: 4.5 }, totalSold: { type: Number, default: 0 },
});

const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  customerName: String, phone: String,
  items: [{ productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' }, name: String, qty: Number, price: Number, mrp: Number, unit: String }],
  address: { fullAddress: String, pincode: String }, notes: String,
  subtotal: Number, discount: { type: Number, default: 0 },
  deliveryFee: { type: Number, default: 0 }, platformFee: { type: Number, default: 0 }, total: Number,
  paymentMethod: { type: String, enum: ['upi', 'card', 'cod', 'wallet'] },
  paymentStatus: { type: String, enum: ['pending', 'paid', 'failed', 'refunded'], default: 'pending' },
  razorpayOrderId: String, razorpayPaymentId: String,
  status: { type: String, enum: ['placed', 'confirmed', 'packing', 'dispatched', 'delivered', 'cancelled'], default: 'placed' },
  deliverySlot: String,
  timeline: [{ status: String, note: String, timestamp: { type: Date, default: Date.now } }],
  createdAt: { type: Date, default: Date.now },
});

const SubscriptionSchema = new mongoose.Schema({
  customerName: String, phone: { type: String, required: true, index: true }, email: String,
  address: { fullAddress: String, pincode: String },
  basketItems: [{ itemId: String, name: String, emoji: String, qty: Number, unit: String, price: Number }],
  frequency: { type: String, enum: ['weekly', 'monthly'], default: 'weekly' },
  deliveryDay: { type: String, default: 'Saturday' },
  payType: { type: String, enum: ['upfront', 'per_delivery'], default: 'upfront' },
  basketTotal: Number, upfrontTotal: Number,
  status: { type: String, enum: ['active', 'paused', 'cancelled'], default: 'active' },
  nextDelivery: Date, createdAt: { type: Date, default: Date.now },
});

const AnalyticsEventSchema = new mongoose.Schema({
  event: { type: String, required: true, index: true },
  sessionId: { type: String, index: true },
  path: String, device: { type: String, enum: ['mobile', 'desktop'], default: 'mobile' },
  name: String, total: String,
  createdAt: { type: Date, default: Date.now, index: true },
});

const User           = mongoose.model('User',           UserSchema);
const Product        = mongoose.model('Product',        ProductSchema);
const Order          = mongoose.model('Order',          OrderSchema);
const Subscription   = mongoose.model('Subscription',   SubscriptionSchema);
const AnalyticsEvent = mongoose.model('AnalyticsEvent', AnalyticsEventSchema);

// ── GREEN API CONFIG ──────────────────────────────────────────
const GREENAPI_ID    = process.env.GREENAPI_ID    || '7107614670';
const GREENAPI_TOKEN = process.env.GREENAPI_TOKEN || '7775f31a840e462b9174289d8d6c381c340e75cd8a48445282';
const GREENAPI_URL   = process.env.GREENAPI_URL   || 'https://7107.api.greenapi.com';
const OWNER_PHONE    = '7255020727'; // Farm Fresh WhatsApp Business number

// ── STATUS MESSAGE PRESETS ────────────────────────────────────
function getStatusMessage(status, order) {
  const shortId = 'FF' + order._id.toString().slice(-6).toUpperCase();
  const name    = order.customerName || 'Customer';
  const slot    = order.deliverySlot || '';
  const presets = {
    confirmed:  `✅ *Order Confirmed — Farm Fresh*\n\nHi ${name}! Your order *${shortId}* has been confirmed.\n\n🕐 Delivery slot: ${slot}\n📍 We'll deliver to your address.\n\nTrack: lovefarmfresh.in\nHelp: 7480062299`,
    packing:    `📦 *Your Order is Being Packed — Farm Fresh*\n\nHi ${name}! Great news — your order *${shortId}* is being packed with fresh produce right now.\n\n🌿 Quality checked & sealed fresh.\n\nTrack: lovefarmfresh.in`,
    dispatched: `🚀 *Out for Delivery — Farm Fresh*\n\nHi ${name}! Your order *${shortId}* is on its way!\n\n🕐 Expected: ${slot}\n\nPlease be available at your delivery address. Track: lovefarmfresh.in\nHelp: 7480062299`,
    delivered:  `🎉 *Order Delivered — Farm Fresh*\n\nHi ${name}! Your order *${shortId}* has been delivered.\n\n🌱 Enjoy your fresh produce!\nWe'd love your feedback — reply to this message.\n\nOrder again: lovefarmfresh.in`,
    cancelled:  `❌ *Order Cancelled — Farm Fresh*\n\nHi ${name}, your order *${shortId}* has been cancelled.\n\nIf this was a mistake or you need help, contact us:\n📞 7480062299\n🌐 lovefarmfresh.in`,
  };
  return presets[status] || null;
}

// ── NOTIFY HELPERS ────────────────────────────────────────────

// 1. Telegram
async function notifyTelegram(message) {
  const token  = process.env.TELEGRAM_TOKEN   || '8703112237:AAGK_OHusDHFZiYlpKc098XOAR1RkBKIcf4';
  const chatId = process.env.TELEGRAM_CHAT_ID || '8797240896';
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'Markdown' }),
    });
  } catch (e) { console.error('Telegram failed:', e.message); }
}

// 2. Owner email
async function notifyOwnerEmail(order) {
  if (!mailer) return;
  const shortId = 'FF' + order._id.toString().slice(-6).toUpperCase();
  try {
    await mailer.sendMail({
      from:    `"Farm Fresh Orders" <${process.env.GMAIL_USER}>`,
      to:      [process.env.GMAIL_USER, 'krajdp@gmail.com'].filter(Boolean).join(', '),
      subject: `🛒 New Order ${shortId} — Rs.${order.total} | ${order.customerName || order.phone}`,
      html: `<div style="font-family:-apple-system,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f7f8fa;border-radius:12px">
        <div style="background:#22c55e;padding:18px 24px;border-radius:10px;margin-bottom:20px">
          <h2 style="margin:0;color:#fff;font-size:18px">🛒 New Order — Farm Fresh</h2>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:13px">${shortId}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:10px;margin-bottom:12px">
          <p style="margin:0 0 6px"><strong>Customer:</strong> ${order.customerName || '—'}</p>
          <p style="margin:0 0 6px"><strong>Phone:</strong> ${order.phone}</p>
          <p style="margin:0 0 6px"><strong>Address:</strong> ${order.address?.fullAddress || '—'}</p>
          <p style="margin:0 0 6px"><strong>Slot:</strong> ${order.deliverySlot || '—'}</p>
          <p style="margin:0"><strong>Payment:</strong> ${(order.paymentMethod || '').toUpperCase()}</p>
        </div>
        <div style="background:#fff;padding:20px;border-radius:10px;margin-bottom:12px">
          <p style="margin:0 0 10px;font-weight:600">Items</p>
          ${order.items.map(i => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0f0f0"><span style="color:#6b7280">${i.name} × ${i.qty}</span><span>Rs.${i.price * i.qty}</span></div>`).join('')}
          <div style="display:flex;justify-content:space-between;margin-top:10px;font-weight:700;font-size:16px">
            <span>Total</span><span style="color:#22c55e">Rs.${order.total}</span>
          </div>
        </div>
        <p style="text-align:center;font-size:11px;color:#9ca3af">Farm Fresh · Bhagalpur, Bihar · lovefarmfresh.in</p>
      </div>`,
    });
    console.log(`✅ Owner email sent for ${shortId}`);
  } catch (e) { console.error('Owner email failed:', e.message); }
}

// 3. Green API WhatsApp
async function sendWhatsApp(phone10digit, message) {
  const chatId = `91${phone10digit.replace(/\D/g, '').replace(/^91/, '')}@c.us`;
  const url    = `${GREENAPI_URL}/waInstance${GREENAPI_ID}/sendMessage/${GREENAPI_TOKEN}`;
  try {
    const res  = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId, message }),
    });
    const data = await res.json();
    if (data.idMessage) console.log(`✅ WhatsApp sent to ${phone10digit}`);
    else console.error('Green API error:', JSON.stringify(data));
  } catch (e) { console.error('WhatsApp failed:', e.message); }
}

// ── AUTH MIDDLEWARE ───────────────────────────────────────────
const auth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'farmfresh_super_secret_2024');
    const user = await User.findById(decoded.userId);
    if (!user || user.isBlocked) return res.status(401).json({ error: 'Unauthorized' });
    req.user = user; next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};

// ── ROUTES ────────────────────────────────────────────────────
app.get('/',         (req, res) => res.json({ success: true, message: 'Farm Fresh API' }));
app.get('/api/ping', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/health',   (req, res) => res.json({ status: 'ok', time: new Date() }));

// ── ANALYTICS ─────────────────────────────────────────────────
app.post('/api/analytics/event', async (req, res) => {
  try {
    const { event, sessionId, path, device, name, total } = req.body;
    if (!event) return res.status(400).json({ error: 'event required' });
    await AnalyticsEvent.create({ event, sessionId, path, device, name, total });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/analytics/visits', async (req, res) => {
  try {
    const { days = 7 } = req.query;
    const since = new Date(); since.setDate(since.getDate() - Number(days));
    const events = await AnalyticsEvent.find({ createdAt: { $gte: since } }).lean();
    const dailyMap = {}, dailyEvt = {};
    events.forEach(e => {
      const day = new Date(e.createdAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
      if (!dailyMap[day]) { dailyMap[day] = new Set(); dailyEvt[day] = 0; }
      if (e.sessionId) dailyMap[day].add(e.sessionId);
      dailyEvt[day]++;
    });
    const dailyVisits = Object.entries(dailyMap).map(([date, s]) => ({ date, visitors: s.size, events: dailyEvt[date] }));
    const pageCount = {};
    events.filter(e => e.event === 'pageview').forEach(e => { const p = e.path || '/'; pageCount[p] = (pageCount[p] || 0) + 1; });
    const topPages = Object.entries(pageCount).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([page,views])=>({page,views}));
    const mobile  = events.filter(e => e.device === 'mobile').length;
    const desktop = events.filter(e => e.device === 'desktop').length;
    const unique  = new Set(events.map(e => e.sessionId)).size;
    const carts   = new Set(events.filter(e => e.event === 'cart_open').map(e => e.sessionId)).size;
    const checks  = new Set(events.filter(e => e.event === 'checkout_start').map(e => e.sessionId)).size;
    const ords    = new Set(events.filter(e => e.event === 'order_placed').map(e => e.sessionId)).size;
    const prodClicks = {};
    events.filter(e => e.event === 'product_click' && e.name).forEach(e => { prodClicks[e.name] = (prodClicks[e.name]||0)+1; });
    const topProducts = Object.entries(prodClicks).sort((a,b)=>b[1]-a[1]).slice(0,6).map(([name,clicks])=>({name,clicks}));
    res.json({ totalVisitors: unique, totalEvents: events.length, dailyVisits, topPages, deviceSplit: { mobile, desktop },
      funnel: [{ step:'Visited',count:unique },{ step:'Cart Open',count:carts },{ step:'Checkout',count:checks },{ step:'Ordered',count:ords }], topProducts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AUTH ──────────────────────────────────────────────────────
app.post('/api/auth/verify-firebase-token', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'No token provided' });
    const decoded = await admin.auth().verifyIdToken(idToken);
    const phone = decoded.phone_number?.replace('+91', '');
    if (!phone) return res.status(400).json({ error: 'No phone in token' });
    let user = await User.findOne({ phone });
    if (!user) user = await User.create({ phone, referralCode: 'FF' + Math.random().toString(36).substr(2,6).toUpperCase() });
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'farmfresh_super_secret_2024', { expiresIn: '30d' });
    res.json({ success: true, token, user, isNew: !user });
  } catch (err) { res.status(401).json({ error: 'Invalid Firebase token' }); }
});

app.post('/api/auth/send-otp', async (req, res) => {
  try {
    const { phone, email } = req.body;
    if (!phone || !email) return res.status(400).json({ error: 'Phone and email required' });
    if (!/^[6-9]\d{9}$/.test(phone)) return res.status(400).json({ error: 'Invalid phone number' });
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const key = `${phone}:${email}`;
    otpStore.set(key, { otp, expires: Date.now() + 10 * 60 * 1000 });
    if (otpStore.size > 100) { const now = Date.now(); for (const [k,v] of otpStore.entries()) { if (v.expires < now) otpStore.delete(k); } }
    if (mailer) {
      await mailer.sendMail({ from: `"Farm Fresh" <${process.env.GMAIL_USER}>`, to: email, subject: 'Your Farm Fresh OTP',
        html: `<div style="font-family:sans-serif;max-width:400px;margin:0 auto;padding:24px"><h2 style="color:#16a34a">Farm Fresh</h2><p>Your verification code:</p><div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#111;padding:16px 0">${otp}</div><p style="color:#666;font-size:13px">Valid for 10 minutes.</p></div>` });
    } else { console.log(`🔑 DEV OTP for ${phone}: ${otp}`); }
    res.json({ success: true, message: `OTP sent to ${email}` });
  } catch (err) { res.status(500).json({ error: 'Failed to send OTP' }); }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { phone, email, otp } = req.body;
    if (!phone || !email || !otp) return res.status(400).json({ error: 'Phone, email and OTP required' });
    const key = `${phone}:${email}`;
    const stored = otpStore.get(key);
    if (!stored) return res.status(400).json({ error: 'OTP not found.' });
    if (Date.now() > stored.expires) { otpStore.delete(key); return res.status(400).json({ error: 'OTP expired.' }); }
    if (stored.otp !== otp.toString()) return res.status(400).json({ error: 'Wrong OTP.' });
    otpStore.delete(key);
    let user = await User.findOne({ phone });
    if (!user) user = await User.create({ phone, email, referralCode: 'FF' + Math.random().toString(36).substr(2,6).toUpperCase() });
    else if (email && !user.email) { user.email = email; await user.save(); }
    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'farmfresh_super_secret_2024', { expiresIn: '30d' });
    res.json({ success: true, token, user });
  } catch (err) { res.status(500).json({ error: 'Verification failed' }); }
});

app.patch('/api/auth/profile', auth, async (req, res) => {
  const { name, email } = req.body;
  const updated = await User.findByIdAndUpdate(req.user._id, { name, email }, { new: true });
  res.json({ user: updated });
});

// ── PRODUCTS ──────────────────────────────────────────────────
app.get('/api/products', async (req, res) => {
  try {
    const { category, search, sort = 'default', limit = 50, skip = 0 } = req.query;
    const query = { isAvailable: true };
    if (category) query.category = category;
    if (search) query.name = { $regex: search, $options: 'i' };
    const sortMap = { price_asc: { price: 1 }, price_desc: { price: -1 }, default: { totalSold: -1 } };
    const [products, total] = await Promise.all([
      Product.find(query).sort(sortMap[sort] || sortMap.default).limit(parseInt(limit)).skip(parseInt(skip)).lean(),
      Product.countDocuments(query),
    ]);
    res.json({ products, total });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch products' }); }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await Product.findById(req.params.id).lean();
    if (!product) return res.status(404).json({ error: 'Not found' });
    res.json({ product });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch product' }); }
});

// ── ORDERS ────────────────────────────────────────────────────
app.post('/api/orders', async (req, res) => {
  try {
    const { items, address, phone, customerName, notes, deliverySlot, paymentMethod, couponCode } = req.body;
    if (!items?.length) return res.status(400).json({ error: 'Cart is empty' });
    if (!phone || !address?.fullAddress) return res.status(400).json({ error: 'Phone and address required' });

    let user = await User.findOne({ phone });
    if (!user) user = await User.create({ phone, name: customerName, referralCode: 'FF' + Math.random().toString(36).substr(2,6).toUpperCase() });
    else if (customerName && !user.name) { user.name = customerName; await user.save(); }

    let subtotal = 0;
    const validatedItems = [];
    for (const item of items) {
      const product = await Product.findById(item.productId);
      if (!product || !product.isAvailable) return res.status(400).json({ error: `${product?.name || 'Item'} is unavailable` });
      subtotal += product.price * item.qty;
      validatedItems.push({ productId: product._id, name: product.name, qty: item.qty, price: product.price, mrp: product.mrp, unit: product.unit });
      await Product.findByIdAndUpdate(product._id, { $inc: { totalSold: item.qty } });
    }

    let discount = 0;
    if (couponCode === 'KISAN80' && !user.hasUsedFirstOrderCoupon && subtotal >= 199) {
      discount = 80; user.hasUsedFirstOrderCoupon = true; await user.save();
    }

    const deliveryFee = subtotal >= 299 ? 0 : 29;
    const total = Math.max(0, subtotal - discount + deliveryFee);

    let razorpayOrderId = null;
    if (paymentMethod !== 'cod' && razorpay) {
      const rzOrder = await razorpay.orders.create({ amount: total * 100, currency: 'INR', receipt: `ff_${Date.now()}` });
      razorpayOrderId = rzOrder.id;
    }

    const order = await Order.create({
      userId: user._id, customerName: customerName || user.name, phone,
      items: validatedItems, address, notes, subtotal, discount,
      deliveryFee, platformFee: 0, total,
      paymentMethod: paymentMethod || 'cod', paymentStatus: 'pending',
      razorpayOrderId, deliverySlot: deliverySlot || 'Today, 6–9 PM',
      status: 'placed', timeline: [{ status: 'placed', note: 'Order received', timestamp: new Date() }],
    });

    await User.findByIdAndUpdate(user._id, { $inc: { totalOrders: 1 } });

    const shortId   = 'FF' + order._id.toString().slice(-6).toUpperCase();
    const itemsList = validatedItems.map(i => `  - ${i.name} x${i.qty} — Rs.${i.price * i.qty}`).join('\n');

    const ownerMsg =
      `🛒 *New Order — Farm Fresh*\n\n*${order.customerName}*\n📱 ${order.phone}\n📍 ${order.address?.fullAddress}\n\n` +
      `*Items:*\n${itemsList}\n\n*Total: Rs.${order.total}* (${(order.paymentMethod||'').toUpperCase()})\n🕐 ${order.deliverySlot}\n🆔 ${shortId}`;

    const customerMsg =
      `✅ *Order Placed — Farm Fresh*\n\nHi ${customerName}! Your order *${shortId}* has been placed.\n\n` +
      `💰 Total: Rs.${total}\n🕐 Slot: ${deliverySlot || 'As scheduled'}\n\nWe'll confirm shortly.\nTrack: lovefarmfresh.in\nHelp: 7480062299`;

    Promise.all([
      notifyTelegram(ownerMsg).catch(console.error),
      notifyOwnerEmail(order).catch(console.error),
      sendWhatsApp(OWNER_PHONE, ownerMsg).catch(console.error),
      sendWhatsApp(phone, customerMsg).catch(console.error),
    ]);

    res.status(201).json({ success: true, order, razorpayOrderId, total });
  } catch (err) {
    console.error('Order error:', err.message);
    res.status(500).json({ error: 'Order failed. Please try again.' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).select('-userId -razorpayPaymentId').lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    res.json({ order });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch order' }); }
});

app.get('/api/orders', auth, async (req, res) => {
  try {
    const orders = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json({ orders });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch orders' }); }
});

// ── PAYMENTS ──────────────────────────────────────────────────
app.post('/api/payments/verify', async (req, res) => {
  try {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const expectedSig = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
    if (expectedSig !== razorpaySignature) return res.status(400).json({ error: 'Payment verification failed' });
    await Order.findOneAndUpdate({ razorpayOrderId }, {
      paymentStatus: 'paid', razorpayPaymentId, status: 'confirmed',
      $push: { timeline: { status: 'confirmed', note: 'Payment received', timestamp: new Date() } },
    });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Verification error' }); }
});

// ── SUBSCRIPTIONS ─────────────────────────────────────────────
app.post('/api/subscriptions', async (req, res) => {
  try {
    const { customerName, phone, email, address, basketItems, frequency, deliveryDay, payType, basketTotal, upfrontTotal } = req.body;
    if (!phone || !address?.fullAddress || !basketItems?.length) return res.status(400).json({ error: 'Missing required fields' });
    const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    const targetDay = days.indexOf(deliveryDay?.split(' ')[0] || deliveryDay);
    const now = new Date();
    const daysUntil = targetDay >= 0 ? (targetDay - now.getDay() + 7) % 7 || 7 : 7;
    const nextDelivery = new Date(now); nextDelivery.setDate(now.getDate() + daysUntil);
    const subscription = await Subscription.create({ customerName, phone, email, address, basketItems, frequency, deliveryDay: deliveryDay || 'Saturday', payType, basketTotal, upfrontTotal, nextDelivery, status: 'active' });
    const itemsList = basketItems.map(i => `  - ${i.name} x${i.qty} ${i.unit}`).join('\n');
    const goldOwnerMsg = `👑 *New Gold Subscription — Farm Fresh*\n\n*${customerName}*\n📱 ${phone}\n📍 ${address.fullAddress}\n\n*Basket:*\n${itemsList}\n\n*${frequency}* every ${deliveryDay}\n💰 Rs.${basketTotal}/delivery\n📅 First: ${nextDelivery.toDateString()}`;
    const goldCustomerMsg = `👑 *Gold Subscription Confirmed — Farm Fresh*\n\nHi ${customerName}! Your Gold subscription is active.\n\n📅 ${frequency} delivery every ${deliveryDay}\n💰 Rs.${upfrontTotal}\n🗓 First delivery: ${nextDelivery.toDateString()}\n\nQuestions? 7480062299`;
    Promise.all([
      notifyTelegram(goldOwnerMsg).catch(console.error),
      sendWhatsApp(OWNER_PHONE, goldOwnerMsg).catch(console.error),
      sendWhatsApp(phone, goldCustomerMsg).catch(console.error),
      mailer ? mailer.sendMail({ from: `"Farm Fresh Gold" <${process.env.GMAIL_USER}>`, to: [process.env.GMAIL_USER, 'krajdp@gmail.com'].filter(Boolean).join(', '), subject: `👑 New Gold Subscription — ${customerName} | ${frequency}`, html: `<div style="font-family:sans-serif;padding:24px;max-width:520px"><h2 style="color:#C9A227">👑 New Gold Subscription</h2><p><b>Customer:</b> ${customerName}</p><p><b>Phone:</b> ${phone}</p><p><b>Address:</b> ${address.fullAddress}</p><p><b>Frequency:</b> ${frequency} — ${deliveryDay}</p><p><b>Total:</b> Rs.${upfrontTotal}</p><pre style="background:#f9f9f9;padding:12px;border-radius:8px">${itemsList}</pre></div>` }).catch(console.error) : Promise.resolve(),
    ]);
    res.status(201).json({ success: true, subscription });
  } catch (err) { console.error('Subscription error:', err.message); res.status(500).json({ error: 'Failed to create subscription' }); }
});

app.get('/api/subscriptions/:phone', async (req, res) => {
  try { const subs = await Subscription.find({ phone: req.params.phone, status: { $ne: 'cancelled' } }).sort({ createdAt: -1 }).lean(); res.json({ subscriptions: subs }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch subscriptions' }); }
});

app.patch('/api/subscriptions/:id/pause',  async (req, res) => { const s = await Subscription.findByIdAndUpdate(req.params.id, { status: 'paused' },  { new: true }); res.json({ success: true, subscription: s }); });
app.patch('/api/subscriptions/:id/resume', async (req, res) => { const s = await Subscription.findByIdAndUpdate(req.params.id, { status: 'active' }, { new: true }); res.json({ success: true, subscription: s }); });
app.delete('/api/subscriptions/:id',       async (req, res) => { await Subscription.findByIdAndUpdate(req.params.id, { status: 'cancelled' }); res.json({ success: true }); });

// ── ADMIN ─────────────────────────────────────────────────────
app.post('/api/admin/products',       async (req, res) => { try { const p = await Product.create(req.body); res.status(201).json({ product: p }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.patch('/api/admin/products/:id',  async (req, res) => { try { const p = await Product.findByIdAndUpdate(req.params.id, req.body, { new: true }); res.json({ product: p }); } catch (e) { res.status(500).json({ error: e.message }); } });
app.delete('/api/admin/products/:id', async (req, res) => { try { await Product.findByIdAndDelete(req.params.id); res.json({ success: true }); } catch (e) { res.status(500).json({ error: e.message }); } });

app.get('/api/admin/orders', async (req, res) => {
  try { const orders = await Order.find().sort({ createdAt: -1 }).limit(100).lean(); res.json({ orders }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch orders' }); }
});

// ── STATUS UPDATE + AUTO WhatsApp notify ──────────────────────
app.patch('/api/admin/orders/:id/status', async (req, res) => {
  try {
    const { status, note, sendWhatsAppNotify = true } = req.body;
    const order = await Order.findByIdAndUpdate(req.params.id,
      { status, $push: { timeline: { status, note: note || `Updated to ${status}`, timestamp: new Date() } } },
      { new: true });

    // Auto-send WhatsApp to customer on status change
    if (sendWhatsAppNotify && order?.phone) {
      const msg = getStatusMessage(status, order);
      if (msg) {
        sendWhatsApp(order.phone, msg).catch(console.error);
        // Also notify owner on their business number
        const ownerNotif = `📋 Order *FF${order._id.toString().slice(-6).toUpperCase()}* → *${status.toUpperCase()}*\nCustomer: ${order.customerName} (${order.phone})`;
        sendWhatsApp(OWNER_PHONE, ownerNotif).catch(console.error);
      }
    }

    res.json({ success: true, order });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Manual WhatsApp send from admin ──────────────────────────
app.post('/api/admin/orders/:id/whatsapp', async (req, res) => {
  try {
    const { message } = req.body;
    const order = await Order.findById(req.params.id).lean();
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (!message) return res.status(400).json({ error: 'message required' });
    await sendWhatsApp(order.phone, message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/analytics', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [todayOrders, totalOrders, totalUsers, totalSubs] = await Promise.all([
      Order.find({ createdAt: { $gte: today } }).lean(),
      Order.countDocuments(), User.countDocuments(),
      Subscription.countDocuments({ status: 'active' }),
    ]);
    res.json({ todayOrders: todayOrders.length, todayGMV: todayOrders.reduce((s,o) => s+(o.total||0), 0), totalOrders, totalUsers, totalSubs });
  } catch (err) { res.status(500).json({ error: 'Failed to fetch analytics' }); }
});

app.get('/api/admin/subscriptions', async (req, res) => {
  try { const subs = await Subscription.find().sort({ createdAt: -1 }).limit(100).lean(); res.json({ subscriptions: subs }); }
  catch (err) { res.status(500).json({ error: 'Failed to fetch subscriptions' }); }
});

// ── START ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Farm Fresh API running on port ${PORT}`));
require('./keepalive');
module.exports = app;
