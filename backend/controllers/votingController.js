const { supabase }    = require('../config/db');
const paystackService = require('../services/paystackService');
const asyncHandler    = require('../utils/asyncHandler'); // FIX: was '../app' (circular dep)
const crypto          = require('crypto');

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
      return res.status(400).json({ message: 'You have a pending transaction. Please wait for it to complete.' });
  }

  const reference    = makeRef();
  const amountInKobo = qty * 100 * 100;

  const paymentData = await paystackService.initializeTx(email, amountInKobo, reference, {
    contestantId, categoryId, quantity: qty, contestantName: contestant.fullname
  });

  if (!paymentData?.data?.authorization_url)
    return res.status(502).json({ message: 'Payment gateway failed to initialize. Try again.' });

  await supabase.from('transactions').insert([{
    user_id      : req.user?.id || null,
    reference,
    amount       : qty * 100,
    quantity     : qty,
    contestant_id: contestantId,
    category_id  : categoryId,
    status       : 'pending',
    metadata     : { email, userAgent: req.headers['user-agent'], ip: req.ip }
  }]);

  res.json({ success: true, authorization_url: paymentData.data.authorization_url, reference });
});

// ── GET /api/voting/verify/:reference ───────────────────────
exports.verifyPaymentEndpoint = asyncHandler(async (req, res) => {
  const { reference } = req.params;
  if (!reference || !/^VT-[A-F0-9]{16}$/.test(reference))
    return res.status(400).json({ message: 'Invalid transaction reference.' });

  const { data: tx, error: txErr } = await supabase
    .from('transactions').select('*').eq('reference', reference).single();

  if (txErr || !tx) return res.status(404).json({ message: 'Transaction not found.' });
  if (tx.status === 'success') return res.json({ success: true, message: 'Already verified.', reference, quantity: tx.quantity, contestantId: tx.contestant_id });
  if (tx.status === 'failed')  return res.status(400).json({ success: false, message: 'This transaction failed.' });

  const result = await paystackService.verifyTx(reference, tx.amount * 100);
  if (!result.success) {
    await supabase.from('transactions').update({ status: 'failed' }).eq('reference', reference);
    return res.status(400).json({ success: false, message: 'Payment verification failed.' });
  }

  const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
    p_tx_ref: reference,
    p_cat_id: tx.category_id,
    p_con_id: tx.contestant_id,
    p_usr_id: tx.user_id || null,
    p_qty   : tx.quantity
  });

  if (rpcErr) {
    console.error('[RPC ERROR]', rpcErr.message);
    return res.status(500).json({ message: `Vote recording error. Quote ref ${reference} to support.` });
  }

  if (!processed)
    return res.json({ success: true, message: 'Already processed.', reference, quantity: tx.quantity, contestantId: tx.contestant_id });

  res.json({ success: true, message: `${tx.quantity} vote(s) recorded!`, reference, quantity: tx.quantity, contestantId: tx.contestant_id });
});

// ── POST /api/voting/webhook ─────────────────────────────────
exports.handleWebhook = asyncHandler(async (req, res) => {
  res.status(200).json({ received: true });

  try {
    const signature = req.headers['x-paystack-signature'];
    if (!signature) return;

    const rawBody = req.body instanceof Buffer
      ? req.body
      : Buffer.from(JSON.stringify(req.body));

    const hash = crypto
      .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(rawBody).digest('hex');

    if (hash !== signature) { console.warn('[WEBHOOK] Invalid signature — ignored.'); return; }

    const event = JSON.parse(rawBody.toString());
    if (event.event !== 'charge.success') return;

    const reference = event.data?.reference;
    if (!reference) return;

    const eventId = event.data.id?.toString() || reference;
    const { data: already } = await supabase
      .from('processed_webhooks').select('id').eq('event_id', eventId).single();
    if (already) return;

    const { data: tx } = await supabase
      .from('transactions').select('*').eq('reference', reference).single();
    if (!tx || tx.status !== 'pending') return;

    await supabase.rpc('process_vote_transaction', {
      p_tx_ref: reference,
      p_cat_id: tx.category_id,
      p_con_id: tx.contestant_id,
      p_usr_id: tx.user_id || null,
      p_qty   : tx.quantity
    });

    await supabase.from('processed_webhooks').insert([{ event_id: eventId }]);
  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});