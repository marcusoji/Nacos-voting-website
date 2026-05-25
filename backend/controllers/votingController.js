const { supabase }    = require('../config/db');
const paystackService = require('../services/paystackService');
const asyncHandler    = require('../utils/asyncHandler');
const crypto          = require('crypto');

// Always uppercase — consistent with DB storage and regex
const makeRef = () => `VT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

const resolveEmail = (req) => {
  if (req.user?.email) return req.user.email;
  const e = req.body?.email;
  return e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
};

// ── GET /api/voting/categories ───────────────────────────────
exports.getCategories = asyncHandler(async (req, res) => {
  const { data, error } = await supabase.from('categories').select('*').order('name');
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
  const { data: categories, error } = await supabase.from('categories').select('*').order('name');
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
    return res.status(400).json({ message: 'An email address is required.' });

  if (req.user) {
    const { data: pending } = await supabase
      .from('transactions')
      .select('id')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .limit(1);
    if (pending && pending.length > 0)
      return res.status(400).json({ message: 'You have a pending transaction. Please wait for it to complete.' });
  }

  const reference    = makeRef();
  const amountInKobo = qty * 100 * 100;   // qty × ₦100 × 100 kobo/naira

  const paymentData = await paystackService.initializeTx(email, amountInKobo, reference, {
    contestantId, categoryId, quantity: qty, contestantName: contestant.fullname
  });

  if (!paymentData?.data?.authorization_url)
    return res.status(502).json({ message: 'Payment gateway failed to initialize. Please try again.' });

  await supabase.from('transactions').insert([{
    user_id      : req.user?.id || null,
    reference,
    amount       : qty * 100,   // store in Naira
    quantity     : qty,
    contestant_id: contestantId,
    category_id  : categoryId,
    status       : 'pending',
    metadata     : { email, userAgent: req.headers['user-agent'], ip: req.ip }
  }]);

  console.log('[INIT] Transaction created:', reference, '| qty:', qty, '| kobo:', amountInKobo);
  res.json({ success: true, authorization_url: paymentData.data.authorization_url, reference });
});

// ── GET /api/voting/verify/:reference ───────────────────────
exports.verifyPaymentEndpoint = asyncHandler(async (req, res) => {
  const { reference } = req.params;

  // Accept both upper and lower case hex
  if (!reference || !/^VT-[A-Fa-f0-9]{16}$/i.test(reference))
    return res.status(400).json({ message: 'Invalid transaction reference format.' });

  // Normalize to uppercase — DB always stores uppercase (makeRef uses toUpperCase)
  const ref = reference.toUpperCase();

  const { data: tx, error: txErr } = await supabase
    .from('transactions').select('*').eq('reference', ref).single();

  if (txErr || !tx) {
    console.warn('[VERIFY] Not found:', ref, txErr?.message);
    return res.status(404).json({
      message: 'Transaction not found. Payment may still be processing — please wait 10 seconds and refresh.'
    });
  }

  // Already done — return cached result (idempotent)
  if (tx.status === 'success') {
    console.log('[VERIFY] Already processed:', ref);
    return res.json({
      success: true,
      message: 'Votes already recorded.',
      reference: ref,
      quantity: tx.quantity,
      contestantId: tx.contestant_id
    });
  }

  if (tx.status === 'failed') {
    return res.status(400).json({ success: false, message: 'This transaction previously failed.' });
  }

  // Call Paystack to verify — amount in DB is Naira, multiply by 100 for kobo
  const expectedKobo = tx.amount * 100;
  const result = await paystackService.verifyTx(ref, expectedKobo);

  // KEY FIX: If verification failed due to network/timeout — do NOT mark as failed.
  // The payment may be genuine; the webhook will record it when Paystack retries.
  if (!result.success) {
    if (result.networkError) {
      console.warn('[VERIFY] Network error talking to Paystack — leaving as pending:', ref);
      return res.status(503).json({
        success: false,
        networkError: true,
        message: 'Could not reach payment gateway. Your payment may still be processing. Check back in 30 seconds.'
      });
    }

    // Genuine payment failure (status !== 'success' from Paystack)
    console.warn('[VERIFY] Paystack says payment failed:', ref);
    await supabase.from('transactions').update({ status: 'failed', updated_at: new Date().toISOString() })
      .eq('reference', ref);
    return res.status(400).json({
      success: false,
      message: 'Payment was not successful according to Paystack. No charge was made.'
    });
  }

  // Payment verified — record votes atomically via RPC
  const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
    p_tx_ref: ref,
    p_cat_id: tx.category_id,
    p_con_id: tx.contestant_id,
    p_usr_id: tx.user_id || null,
    p_qty   : tx.quantity
  });

  if (rpcErr) {
    console.error('[VERIFY RPC ERROR]', rpcErr.message, '| ref:', ref);
    // Don't mark as failed — the payment succeeded, we just had a DB issue
    return res.status(500).json({
      message: `Payment confirmed but vote recording hit an error. Quote ref ${ref} to support.`
    });
  }

  if (!processed) {
    // RPC returned false = webhook already processed this (race condition — fine)
    console.log('[VERIFY] Already processed by webhook:', ref);
    return res.json({
      success: true,
      message: 'Votes already recorded.',
      reference: ref,
      quantity: tx.quantity,
      contestantId: tx.contestant_id
    });
  }

  console.log('[VERIFY] Success! Votes recorded:', ref, '| qty:', tx.quantity);
  res.json({
    success: true,
    message: `${tx.quantity} vote(s) recorded successfully!`,
    reference: ref,
    quantity: tx.quantity,
    contestantId: tx.contestant_id
  });
});

// ── POST /api/voting/webhook ─────────────────────────────────
// Register in Paystack dashboard → Settings → Webhooks:
// URL: https://nacos-voting-website.vercel.app/api/voting/webhook
exports.handleWebhook = asyncHandler(async (req, res) => {
  res.status(200).json({ received: true }); // acknowledge immediately

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) { console.warn('[WEBHOOK] Missing signature'); return; }

    const rawBody = req.body instanceof Buffer
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody).digest('hex');

    if (hash !== signature) { console.warn('[WEBHOOK] Bad signature — ignored'); return; }

    const event = JSON.parse(rawBody.toString());
    console.log('[WEBHOOK] Event:', event.event);
    if (event.event !== 'charge.success') return;

    const reference = event.data?.reference;
    if (!reference) return;

    const eventId = event.data.id?.toString() || reference;
    const { data: already } = await supabase
      .from('processed_webhooks').select('id').eq('event_id', eventId).single();
    if (already) { console.log('[WEBHOOK] Replay prevented:', eventId); return; }

    const { data: tx } = await supabase
      .from('transactions').select('*').eq('reference', reference.toUpperCase()).single();
    if (!tx) { console.warn('[WEBHOOK] TX not found:', reference); return; }
    if (tx.status !== 'pending') { console.log('[WEBHOOK] Not pending, skip:', reference); return; }

    const { error: rpcErr } = await supabase.rpc('process_vote_transaction', {
      p_tx_ref: reference.toUpperCase(),
      p_cat_id: tx.category_id,
      p_con_id: tx.contestant_id,
      p_usr_id: tx.user_id || null,
      p_qty   : tx.quantity
    });

    if (rpcErr) { console.error('[WEBHOOK RPC]', rpcErr.message); return; }

    await supabase.from('processed_webhooks').insert([{ event_id: eventId }]);
    console.log('[WEBHOOK] Votes recorded:', reference, '| qty:', tx.quantity);

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});
