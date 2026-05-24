const { supabase }    = require('../config/db');
const paystackService = require('../services/paystackService');
const asyncHandler    = require('../utils/asyncHandler');
const crypto          = require('crypto');

// Always uppercase so the regex always matches
const makeRef = () => `VT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

const resolveEmail = (req) => {
  if (req.user?.email) return req.user.email;
  const e = req.body?.email;
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

// ── GET /api/voting/categories ───────────────────────────────
exports.getCategories = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('categories').select('*').order('name');
  if (error) throw error;
  res.json({ success: true, data });
});

// ── GET /api/voting/categories/:slug ────────────────────────
exports.getCategoryBySlug = asyncHandler(async (req, res) => {
  const { slug } = req.params;
  const { data: category, error: catErr } = await supabase
    .from('categories').select('*').eq('slug', slug).single();
  if (catErr || !category)
    return res.status(404).json({ success: false, message: 'Category not found.' });
  const { data: contestants, error: conErr } = await supabase
    .from('contestants')
    .select('id, fullname, avatar_url, bio, vote_count')
    .eq('category_id', category.id)
    .order('vote_count', { ascending: false });
  if (conErr) throw conErr;
  res.json({ success: true, category, contestants: contestants || [] });
});

// ── GET /api/voting/leaderboard ──────────────────────────────
exports.getLeaderboard = asyncHandler(async (req, res) => {
  const { data: categories, error } = await supabase
    .from('categories').select('*').order('name');
  if (error) throw error;
  const data = await Promise.all(categories.map(async (cat) => {
    const { data: contestants } = await supabase
      .from('contestants')
      .select('id, fullname, avatar_url, vote_count')
      .eq('category_id', cat.id)
      .order('vote_count', { ascending: false })
      .limit(10);
    const all = contestants || [];
    return { category: cat, podium: all.slice(0, 3), rest: all.slice(3) };
  }));
  res.json({ success: true, data });
});

// ── POST /api/voting/initialize ──────────────────────────────
exports.initializePayment = asyncHandler(async (req, res) => {
  const { contestantId, categoryId, quantity, email: guestEmail } = req.body;

  if (!contestantId || !categoryId || !quantity)
    return res.status(400).json({ message: 'contestantId, categoryId and quantity are required.' });

  const qty = parseInt(quantity, 10);
  if (isNaN(qty) || qty < 1 || qty > 1000)
    return res.status(400).json({ message: 'Quantity must be between 1 and 1000.' });

  const { data: contestant, error: conErr } = await supabase
    .from('contestants')
    .select('id, fullname, category_id')
    .eq('id', contestantId)
    .eq('category_id', categoryId)
    .single();

  if (conErr || !contestant)
    return res.status(404).json({ message: 'Contestant not found in this category.' });

  const email = resolveEmail(req) || guestEmail;
  if (!email)
    return res.status(400).json({ message: 'An email address is required to process payment.' });

  if (req.user) {
    const { data: pending } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .limit(1);
    if (pending && pending.length > 0)
      return res.status(400).json({ message: 'You have a pending transaction. Please complete or wait for it.' });
  }

  const reference    = makeRef();           // e.g. VT-3F8A1C2D4E5B6A7F (always uppercase)
  const amountInKobo = qty * 100 * 100;     // qty votes × ₦100 × 100 kobo

  const paymentData = await paystackService.initializeTx(email, amountInKobo, reference, {
    contestantId, categoryId, quantity: qty, contestantName: contestant.fullname
  });

  if (!paymentData?.data?.authorization_url)
    return res.status(502).json({ message: 'Payment gateway failed to initialize. Try again.' });

  await supabase.from('transactions').insert([{
    user_id      : req.user?.id || null,
    reference,
    amount       : qty * 100,       // store in Naira (₦)
    quantity     : qty,
    contestant_id: contestantId,
    category_id  : categoryId,
    status       : 'pending',
    metadata     : { email, userAgent: req.headers['user-agent'], ip: req.ip }
  }]);

  console.log('[PAYMENT INIT]', { reference, qty, amountKobo: amountInKobo, email });
  res.json({ success: true, authorization_url: paymentData.data.authorization_url, reference });
});

// ── GET /api/voting/verify/:reference ───────────────────────
exports.verifyPaymentEndpoint = asyncHandler(async (req, res) => {
  const { reference } = req.params;

  // FIX: Accept both upper AND lowercase hex — Paystack may return lowercase
  // Old regex: /^VT-[A-F0-9]{16}$/ — rejected lowercase references → 400 error
  if (!reference || !/^VT-[A-Fa-f0-9]{16}$/i.test(reference)) {
    console.warn('[VERIFY] Invalid reference format:', reference);
    return res.status(400).json({ message: 'Invalid transaction reference format.' });
  }

  // Normalize to uppercase for consistent DB lookup (makeRef always stores uppercase)
  const normalizedRef = reference.toUpperCase();

  const { data: tx, error: txErr } = await supabase
    .from('transactions').select('*').eq('reference', normalizedRef).single();

  if (txErr || !tx) {
    console.warn('[VERIFY] Transaction not found:', normalizedRef);
    return res.status(404).json({ message: 'Transaction not found. It may still be processing — please wait 30 seconds and refresh.' });
  }

  // Already processed — idempotent response
  if (tx.status === 'success') {
    console.log('[VERIFY] Already processed:', normalizedRef);
    return res.json({ success: true, message: 'Payment already verified.', reference: normalizedRef, quantity: tx.quantity, contestantId: tx.contestant_id });
  }

  if (tx.status === 'failed') {
    return res.status(400).json({ success: false, message: 'This transaction was marked as failed.' });
  }

  // Verify with Paystack — amount stored in Naira, convert to kobo for comparison
  const expectedKobo = tx.amount * 100;
  const result = await paystackService.verifyTx(normalizedRef, expectedKobo);

  if (!result.success) {
    await supabase.from('transactions').update({ status: 'failed' }).eq('reference', normalizedRef);
    return res.status(400).json({
      success: false,
      message: 'Payment verification failed. If money was deducted, contact support with your reference number.'
    });
  }

  // Atomically record vote via Supabase RPC
  const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
    p_tx_ref: normalizedRef,
    p_cat_id: tx.category_id,
    p_con_id: tx.contestant_id,
    p_usr_id: tx.user_id || null,
    p_qty   : tx.quantity
  });

  if (rpcErr) {
    console.error('[RPC ERROR]', rpcErr.message, { ref: normalizedRef });
    return res.status(500).json({ message: `Vote recording error. Please quote reference ${normalizedRef} to support.` });
  }

  if (!processed) {
    // RPC returned false = already processed by webhook (race condition — normal)
    return res.json({ success: true, message: 'Votes already recorded.', reference: normalizedRef, quantity: tx.quantity, contestantId: tx.contestant_id });
  }

  console.log('[VERIFY SUCCESS]', { ref: normalizedRef, qty: tx.quantity });
  res.json({ success: true, message: `${tx.quantity} vote(s) recorded!`, reference: normalizedRef, quantity: tx.quantity, contestantId: tx.contestant_id });
});

// ── POST /api/voting/webhook ─────────────────────────────────
// Register this URL in Paystack dashboard:
// https://nacos-voting-website.vercel.app/api/voting/webhook
exports.handleWebhook = asyncHandler(async (req, res) => {
  // Must acknowledge immediately so Paystack doesn't retry
  res.status(200).json({ received: true });

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) { console.warn('[WEBHOOK] No signature header'); return; }

    const rawBody = req.body instanceof Buffer
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody).digest('hex');

    if (hash !== signature) {
      console.warn('[WEBHOOK] Signature mismatch — possible spoofing attempt');
      return;
    }

    const event = JSON.parse(rawBody.toString());
    console.log('[WEBHOOK] Event received:', event.event);

    if (event.event !== 'charge.success') return;

    const reference = event.data?.reference;
    if (!reference) return;

    // Replay attack prevention
    const eventId = event.data.id?.toString() || reference;
    const { data: already } = await supabase
      .from('processed_webhooks').select('id').eq('event_id', eventId).single();
    if (already) { console.log('[WEBHOOK] Already processed:', eventId); return; }

    const { data: tx } = await supabase
      .from('transactions').select('*').eq('reference', reference.toUpperCase()).single();

    if (!tx) { console.warn('[WEBHOOK] Transaction not found:', reference); return; }
    if (tx.status !== 'pending') { console.log('[WEBHOOK] Not pending, skipping:', reference); return; }

    const { error: rpcErr } = await supabase.rpc('process_vote_transaction', {
      p_tx_ref: reference.toUpperCase(),
      p_cat_id: tx.category_id,
      p_con_id: tx.contestant_id,
      p_usr_id: tx.user_id || null,
      p_qty   : tx.quantity
    });

    if (rpcErr) {
      console.error('[WEBHOOK RPC ERROR]', rpcErr.message);
      return;
    }

    await supabase.from('processed_webhooks').insert([{ event_id: eventId }]);
    console.log('[WEBHOOK] Vote recorded via webhook:', reference, 'qty:', tx.quantity);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});