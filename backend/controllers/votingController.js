const { supabase }    = require('../config/db');
const paystackService = require('../services/paystackService');
const asyncHandler    = require('../utils/asyncHandler');
const crypto          = require('crypto');

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

// ── GET /api/voting/stats ────────────────────────────────────
// Always returns LIVE totals (used by index page counter).
// Never frozen — freeze only affects the leaderboard display.
exports.getStats = asyncHandler(async (req, res) => {
  const { data, error } = await supabase
    .from('contestants')
    .select('vote_count');
  if (error) throw error;
  const totalVotes       = (data || []).reduce((sum, c) => sum + (c.vote_count || 0), 0);
  const totalContestants = (data || []).length;
  res.json({ success: true, totalVotes, totalContestants });
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
// Helper: fetch live leaderboard data from DB
async function fetchLiveLeaderboard() {
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
  return data;
}

// ── GET /api/voting/leaderboard ──────────────────────────────
// Public: respects freeze/reveal settings
// Admin/Moderator: always sees live data
exports.getLeaderboard = asyncHandler(async (req, res) => {
  const role = req.userRole; // set by optionalSession middleware
  const isPrivileged = role === 'admin' || role === 'moderator';

  // Fetch settings
  const { data: settingRow } = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'leaderboard_mode')
    .single();

  const settings = settingRow?.value || { frozen: false, reveal_final: false };

  // Privileged users always get live data
  if (isPrivileged) {
    const data = await fetchLiveLeaderboard();
    return res.json({ success: true, data, _meta: { live: true, settings } });
  }

  // Public: if reveal_final is true, show live (voting is over, results revealed)
  if (settings.reveal_final) {
    const data = await fetchLiveLeaderboard();
    return res.json({ success: true, data, _meta: { live: true, revealed: true } });
  }

  // Public: if frozen, return snapshot
  if (settings.frozen) {
    const { data: snapRow } = await supabase
      .from('leaderboard_snapshot')
      .select('data, captured_at')
      .order('captured_at', { ascending: false })
      .limit(1)
      .single();

    if (snapRow?.data) {
      return res.json({
        success: true,
        data: snapRow.data,
        _meta: { live: false, frozen: true, captured_at: snapRow.captured_at }
      });
    }
    // No snapshot yet — fall through to live (shouldn't happen but safe fallback)
  }

  // Default: live
  const data = await fetchLiveLeaderboard();
  res.json({ success: true, data, _meta: { live: true } });
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

  // ── Auto-expire stale pending transactions ──────────────────
  // If user cancelled Paystack and hit back, their old TX stays 'pending'.
  // We auto-expire any pending TX older than 30 minutes for this user,
  // then allow a new one. This prevents the "you have a pending transaction"
  // block from firing after a simple cancel.
  if (req.user) {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    // Mark stale pending transactions as cancelled (not failed — different UX meaning)
    await supabase
      .from('transactions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .lt('created_at', thirtyMinAgo);

    // Check if there is STILL a very-recent pending TX (< 30 min old) — block those
    const { data: recentPending } = await supabase
      .from('transactions')
      .select('id, reference, batch_reference, created_at')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .gte('created_at', thirtyMinAgo)
      .limit(1);

    if (recentPending && recentPending.length > 0) {
      const age = Math.round((Date.now() - new Date(recentPending[0].created_at)) / 1000);
      // Also send back the stuck reference so frontend can cancel by ref if needed
      const stuckRef = recentPending[0].batch_reference || recentPending[0].reference || null;
      return res.status(400).json({
        message: `You have a payment in progress (started ${age}s ago). Please complete it or wait 30 minutes.`,
        canForce: true,
        pendingReference: stuckRef
      });
    }
  }

  const reference    = makeRef();
  const amountInKobo = qty * 50 * 100;   // qty × ₦50 × 100 kobo/naira
  const amountNaira  = qty * 50;          // stored in DB

  const paymentData = await paystackService.initializeTx(email, amountInKobo, reference, {
    contestantId, categoryId, quantity: qty, contestantName: contestant.fullname
  });

  if (!paymentData?.data?.authorization_url)
    return res.status(502).json({ message: 'Payment gateway failed to initialize. Please try again.' });

  const { error: insertErr } = await supabase.from('transactions').insert([{
    user_id      : req.user?.id || null,
    reference,
    amount       : amountNaira,    // ← Naira in DB (e.g. 50 for 1 vote)
    quantity     : qty,
    contestant_id: contestantId,
    category_id  : categoryId,
    status       : 'pending',
    metadata     : {
      email,
      contestantName : contestant.fullname,
      amount_naira   : amountNaira,
      amount_kobo    : amountInKobo,  // ← saved for debugging
      userAgent      : req.headers['user-agent'],
      ip             : req.ip
    }
  }]);

  if (insertErr) {
    console.error('[INIT] DB insert failed for ref:', reference, '|', insertErr.message);
    return res.status(500).json({ message: 'Failed to record transaction. Please try again.' });
  }

  console.log('[INIT] ref:', reference, '| qty:', qty, '| naira:', amountNaira, '| kobo:', amountInKobo);
  res.json({ success: true, authorization_url: paymentData.data.authorization_url, reference });
});

// ── GET /api/voting/verify/:reference ───────────────────────
exports.verifyPaymentEndpoint = asyncHandler(async (req, res) => {
  const { reference } = req.params;

  if (!reference || !/^VT-[A-Fa-f0-9]{16}$/i.test(reference))
    return res.status(400).json({ message: 'Invalid transaction reference format.' });

  const ref = reference.toUpperCase();

  const { data: tx, error: txErr } = await supabase
    .from('transactions').select('*').eq('reference', ref).single();

  if (txErr || !tx) {
    console.warn('[VERIFY] Not found:', ref, txErr?.message);
    return res.status(404).json({
      message: 'Transaction not found. Payment may still be processing — please wait 10 seconds and refresh.'
    });
  }

  // ── Already fully recorded ────────────────────────────────
  if (tx.status === 'success') {
    console.log('[VERIFY] Already processed:', ref);
    return res.json({
      success      : true,
      message      : 'Votes already recorded.',
      reference    : ref,
      quantity     : tx.quantity,
      contestantId : tx.contestant_id
    });
  }

  // ── Always ask Paystack for the true state ────────────────
  // We do this for EVERY non-success status (pending, failed, cancelled)
  // because Nigerian networks cause transactions to be marked failed/cancelled
  // locally while Paystack actually collected the money. Re-checking Paystack
  // is free and lets us recover votes in all those cases.
  const expectedKobo = Number(tx.amount) * 100;
  console.log('[VERIFY] Calling Paystack | ref:', ref, '| db_naira:', tx.amount, '| status:', tx.status);

  const result = await paystackService.verifyTx(ref, expectedKobo);

  // ── Network/timeout error — do NOT mark as failed ────────
  if (result.networkError) {
    console.warn('[VERIFY] Network error from Paystack — leaving as:', tx.status, ref);
    return res.status(503).json({
      success      : false,
      networkError : true,
      message      : 'Could not reach payment gateway. Your payment may still be processing. Check back in 30 seconds.'
    });
  }

  const paystackTx     = result.rawData;
  const paystackStatus = paystackTx?.status; // 'success', 'failed', 'abandoned', 'reversed', etc.

  // ── Paystack says payment did not succeed ────────────────
  if (!result.success) {
    console.warn('[VERIFY] Paystack non-success:', ref, { paystackStatus, dbStatus: tx.status });

    // Only overwrite status if it makes sense to do so
    // 'abandoned' = user closed Paystack popup — treat same as cancelled, not failed
    const newStatus = paystackStatus === 'abandoned' ? 'cancelled' : 'failed';

    // Don't downgrade a cancelled TX to failed — user may retry
    if (tx.status === 'pending') {
      await supabase
        .from('transactions')
        .update({ status: newStatus, updated_at: new Date().toISOString() })
        .eq('reference', ref)
        .eq('status', 'pending');
    }

    // Give the right message based on what Paystack actually said
    const isAbandoned  = paystackStatus === 'abandoned';
    const isCancelled  = tx.status === 'cancelled' || isAbandoned;

    return res.status(400).json({
      success   : false,
      abandoned : isAbandoned,
      cancelled : isCancelled,
      paystackStatus,
      message   : isCancelled
        ? 'Payment was not completed. Your cart is still saved — you can try again.'
        : 'Payment was not successful. No charge was made. Your cart is still saved.'
    });
  }

  // ── Paystack confirmed success — record votes atomically ─
  console.log('[VERIFY] Paystack confirmed success | ref:', ref);

  // Re-open cancelled/failed TXs so the RPC (which checks status='pending') can process them.
  // This covers the case where Nigerian network caused an auto-cancel but Paystack got the money.
  if (tx.status !== 'pending') {
    await supabase
      .from('transactions')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('reference', ref)
      .in('status', ['cancelled', 'failed']);
    console.log('[VERIFY] Re-opened', tx.status, 'TX for processing:', ref);
  }

  const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
    p_tx_ref: ref,
    p_cat_id: tx.category_id,
    p_con_id: tx.contestant_id,
    p_usr_id: tx.user_id || null,
    p_qty   : tx.quantity
  });

  if (rpcErr) {
    console.error('[VERIFY RPC ERROR]', rpcErr.message, '| ref:', ref);
    return res.json({
      success      : true,
      message      : `Payment confirmed! Votes are being recorded. If the leaderboard doesn't update in 1 minute, quote ref ${ref} to support.`,
      reference    : ref,
      quantity     : tx.quantity,
      contestantId : tx.contestant_id
    });
  }

  if (!processed) {
    console.log('[VERIFY] Already processed by webhook:', ref);
    return res.json({
      success      : true,
      message      : 'Votes already recorded.',
      reference    : ref,
      quantity     : tx.quantity,
      contestantId : tx.contestant_id
    });
  }

  console.log('[VERIFY] Success! Votes recorded:', ref, '| qty:', tx.quantity);
  res.json({
    success      : true,
    message      : `${tx.quantity} vote(s) recorded successfully!`,
    reference    : ref,
    quantity     : tx.quantity,
    contestantId : tx.contestant_id
  });
});


// ── POST /api/voting/initialize-batch ───────────────────────
// Accepts: { items: [{contestantId, categoryId, quantity}], email }
// Initialises ONE Paystack payment for the full cart total.
exports.initializeBatchPayment = asyncHandler(async (req, res) => {
  const { items, email: guestEmail } = req.body;

  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: 'items array is required and must not be empty.' });

  if (items.length > 20)
    return res.status(400).json({ message: 'Maximum 20 contestants per batch.' });

  const email = resolveEmail(req) || guestEmail;
  if (!email)
    return res.status(400).json({ message: 'An email address is required.' });
  if (req.user) {
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    await supabase
      .from('transactions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .lt('created_at', thirtyMinAgo);

    const { data: recentPending } = await supabase
      .from('transactions')
      .select('id, reference, batch_reference, created_at')
      .eq('user_id', req.user.id)
      .eq('status', 'pending')
      .gte('created_at', thirtyMinAgo)
      .limit(1);

    if (recentPending && recentPending.length > 0) {
      const age = Math.round((Date.now() - new Date(recentPending[0].created_at)) / 1000);
      const stuckRef = recentPending[0].batch_reference || recentPending[0].reference || null;
      return res.status(400).json({
        message: `You have a payment in progress (started ${age}s ago). Please complete it or wait 30 minutes.`,
        canForce: true,
        pendingReference: stuckRef
      });
    }
  }

  // Validate every contestant
  const resolved = [];
  for (const it of items) {
    const { contestantId, categoryId, quantity } = it;
    if (!contestantId || !categoryId || !quantity)
      return res.status(400).json({ message: 'Each item needs contestantId, categoryId, and quantity.' });

    const qty = parseInt(quantity, 10);
    if (isNaN(qty) || qty < 1 || qty > 1000)
      return res.status(400).json({ message: `Quantity for item must be 1–1000 (got ${quantity}).` });

    const { data: contestant, error } = await supabase
      .from('contestants')
      .select('id, fullname, category_id')
      .eq('id', contestantId)
      .eq('category_id', categoryId)
      .single();
    if (error || !contestant)
      return res.status(404).json({ message: `Contestant ${contestantId} not found in category ${categoryId}.` });

    resolved.push({ contestantId, categoryId, qty, contestantName: contestant.fullname });
  }

  // Build one batch reference (BT- prefix so verify logic can distinguish)
  const batchReference = `BT-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;

  const PRICE_NAIRA = 50;
  const totalNaira  = resolved.reduce((s, i) => s + i.qty * PRICE_NAIRA, 0);
  const totalKobo   = totalNaira * 100;

  const paymentData = await paystackService.initializeTx(email, totalKobo, batchReference, {
    batch      : true,
    itemCount  : resolved.length,
    batchItems : resolved.map(i => ({ contestantId: i.contestantId, qty: i.qty, name: i.contestantName }))
  });

  if (!paymentData?.data?.authorization_url)
    return res.status(502).json({ message: 'Payment gateway failed to initialize. Please try again.' });

  // Insert one transaction row per contestant (each pending, same batch ref)
  const txRows = resolved.map(i => ({
    user_id        : req.user?.id || null,
    reference      : `${batchReference}-${i.contestantId}`,  // unique per row
    batch_reference: batchReference,                          // shared across batch
    amount         : i.qty * PRICE_NAIRA,
    quantity       : i.qty,
    contestant_id  : i.contestantId,
    category_id    : i.categoryId,
    status         : 'pending',
    metadata       : {
      email,
      contestantName : i.contestantName,
      amount_naira   : i.qty * PRICE_NAIRA,
      amount_kobo    : i.qty * PRICE_NAIRA * 100,
      batch_reference: batchReference,
      userAgent      : req.headers['user-agent'],
      ip             : req.ip
    }
  }));

  const { error: insertErr } = await supabase.from('transactions').insert(txRows);
  if (insertErr) {
    console.error('[BATCH INIT] DB insert error:', insertErr.message);
    return res.status(500).json({ message: 'Failed to save transaction records.' });
  }

  console.log('[BATCH INIT] ref:', batchReference, '| items:', resolved.length, '| total naira:', totalNaira);
  res.json({
    success          : true,
    authorization_url: paymentData.data.authorization_url,
    batchReference,
    totalNaira,
    items            : resolved
  });
});

// ── GET /api/voting/verify-batch/:batchReference ─────────────
exports.verifyBatchPayment = asyncHandler(async (req, res) => {
  const { batchReference } = req.params;

 if (!batchReference || !/^BT-[A-Z0-9-]+$/i.test(batchReference)) {
  return res.status(400).json({
    success: false,
    message: 'Invalid batch reference format.'
  });
}
  const batchRef = batchReference.toUpperCase();

  // Fetch all transaction rows for this batch
  const { data: txRows, error: txErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('batch_reference', batchRef);

  if (txErr || !txRows || txRows.length === 0) {
    console.warn('[BATCH VERIFY] Not found:', batchRef, txErr?.message);
    return res.status(404).json({
      message: 'Batch not found. Payment may still be processing — please wait and refresh.'
    });
  }

  // Idempotent — all already processed
  if (txRows.every(tx => tx.status === 'success')) {
    return res.json({
      success       : true,
      message       : 'All votes already recorded.',
      batchReference: batchRef,
      items         : txRows.map(tx => ({
        contestantId  : tx.contestant_id,
        contestantName: tx.metadata?.contestantName || '',
        categoryId    : tx.category_id,
        quantity      : tx.quantity,
        status        : 'success'
      }))
    });
  }

  // Verify against Paystack once (use the batch reference as Paystack reference)
  // Always call Paystack regardless of DB status (pending/cancelled/failed) because
  // Nigerian network drops can cause local cancellation while Paystack has the money.
  const expectedKobo = txRows.reduce(
    (s, tx) => s + Math.round(Number(tx.amount) * 100),
    0
  );
  const dbStatuses = [...new Set(txRows.map(t => t.status))].join(',');
  console.log('[BATCH VERIFY] Calling Paystack | batchRef:', batchRef, '| expected_kobo:', expectedKobo, '| db statuses:', dbStatuses);

  const result = await paystackService.verifyTx(batchRef, expectedKobo);

  if (result.networkError) {
    return res.status(503).json({
      success      : false,
      networkError : true,
      message      : 'Could not reach payment gateway. Your payment may still be processing. Check back in 30 seconds.'
    });
  }

  if (!result.success) {
    const paystackStatus = result.rawData?.status;
    const isAbandoned = paystackStatus === 'abandoned';
    const newStatus   = isAbandoned ? 'cancelled' : 'failed';

    // Only overwrite rows that are still pending — don't stomp already-cancelled rows
    await supabase
      .from('transactions')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('batch_reference', batchRef)
      .eq('status', 'pending');

    return res.status(400).json({
      success       : false,
      abandoned     : isAbandoned,
      paystackStatus,
      message       : isAbandoned
        ? 'Payment was not completed. Your cart is still saved — you can try again.'
        : 'Payment was not successful according to Paystack. No charge was made. Your cart is still saved.'
    });
  }

  // Re-open any cancelled/failed rows so the RPC can process them.
  // Paystack confirmed the money arrived — we must credit those votes.
  const nonPending = txRows.filter(tx => tx.status !== 'success' && tx.status !== 'pending');
  if (nonPending.length > 0) {
    await supabase
      .from('transactions')
      .update({ status: 'pending', updated_at: new Date().toISOString() })
      .eq('batch_reference', batchRef)
      .in('status', ['cancelled', 'failed']);
    console.log('[BATCH VERIFY] Re-opened', nonPending.length, 'non-pending rows for:', batchRef);
  }

  // Re-fetch rows after re-open so we have fresh statuses
  const { data: freshRows } = await supabase
    .from('transactions').select('*').eq('batch_reference', batchRef);
  const rowsToProcess = freshRows || txRows;

  // Paystack confirmed — process votes for each contestant individually
  const results = [];
  for (const tx of rowsToProcess) {
    const name = tx.metadata?.contestantName || tx.contestant_id;

    // Already done — idempotent skip
    if (tx.status === 'success') {
      results.push({ contestantId: tx.contestant_id, contestantName: name, quantity: tx.quantity, status: 'already_recorded' });
      continue;
    }

    const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
      p_tx_ref: tx.reference,
      p_cat_id: tx.category_id,
      p_con_id: tx.contestant_id,
      p_usr_id: tx.user_id || null,
      p_qty   : tx.quantity
    });

    if (rpcErr) {
      console.error('[BATCH VERIFY RPC]', rpcErr.message, '| ref:', tx.reference);
      results.push({ contestantId: tx.contestant_id, contestantName: name, quantity: tx.quantity, status: 'rpc_error' });
    } else {
      results.push({ contestantId: tx.contestant_id, contestantName: name, quantity: tx.quantity, status: processed ? 'success' : 'already_recorded' });
    }
  }

  const totalVotes = results.reduce((s, r) => s + r.quantity, 0);
  console.log('[BATCH VERIFY] Done | batchRef:', batchRef, '| total votes:', totalVotes);

  res.json({
    success       : true,
    message       : `${totalVotes} vote(s) recorded across ${results.length} contestant(s)!`,
    batchReference: batchRef,
    items         : results
  });
});
exports.handleWebhook = asyncHandler(async (req, res) => {
  res.status(200).json({ received: true });

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

    const ref = reference.toUpperCase();
    const { data: tx } = await supabase
      .from('transactions').select('*').eq('reference', ref).single();
    if (!tx) { console.warn('[WEBHOOK] TX not found:', ref); return; }

    // Paystack says charge.success — this is authoritative.
    // If our DB says cancelled/failed (common with Nigerian network drops),
    // re-open to pending so the RPC can credit the votes.
    if (tx.status === 'success') { console.log('[WEBHOOK] Already processed:', ref); return; }
    if (tx.status === 'cancelled' || tx.status === 'failed') {
      console.log('[WEBHOOK] Re-opening', tx.status, 'TX — Paystack confirms payment:', ref);
      await supabase
        .from('transactions')
        .update({ status: 'pending', updated_at: new Date().toISOString() })
        .eq('reference', ref);
    }

    const { error: rpcErr } = await supabase.rpc('process_vote_transaction', {
      p_tx_ref : ref,
      p_cat_id : tx.category_id,
      p_con_id : tx.contestant_id,
      p_usr_id : tx.user_id || null,
      p_qty    : tx.quantity
    });

    if (rpcErr) { console.error('[WEBHOOK RPC]', rpcErr.message); return; }

    await supabase.from('processed_webhooks').insert([{ event_id: eventId }]);
    console.log('[WEBHOOK] Votes recorded:', reference, '| qty:', tx.quantity);

  } catch (err) {
    console.error('[WEBHOOK ERROR]', err.message);
  }
});

// ── POST /api/voting/cancel/:reference ───────────────────────
// Marks a pending transaction as cancelled so the pending-guard unblocks.
// Called when user explicitly wants to abandon a stuck payment.
exports.cancelPayment = asyncHandler(async (req, res) => {
  const ref = String(req.params.reference || '').toUpperCase().trim();
  if (!ref) return res.status(400).json({ message: 'Reference required.' });

  // Batch references (BT-...) are stored in batch_reference column, not reference column
  const isBatch = ref.startsWith('BT-');

  if (isBatch) {
    // Look up any row with this batch_reference to check existence/status
    const { data: rows } = await supabase
      .from('transactions')
      .select('status')
      .eq('batch_reference', ref)
      .eq('status', 'pending')
      .limit(1);

    if (!rows || rows.length === 0) {
      // Check if it exists at all (might already be cancelled/completed)
      const { data: anyRows } = await supabase
        .from('transactions').select('status').eq('batch_reference', ref).limit(1);
      if (!anyRows || anyRows.length === 0)
        return res.status(404).json({ message: 'Transaction not found.' });
      return res.json({ success: true, message: `Transaction is already ${anyRows[0].status}.` });
    }

    await supabase
      .from('transactions')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('batch_reference', ref)
      .eq('status', 'pending');

    console.log('[CANCEL] Batch cancelled by user:', ref);
    return res.json({ success: true, message: 'Transaction cancelled. You can vote again.' });
  }

  // Single reference (VT-...)
  const { data: tx } = await supabase
    .from('transactions').select('status, user_id').eq('reference', ref).single();

  if (!tx) return res.status(404).json({ message: 'Transaction not found.' });
  if (tx.status !== 'pending')
    return res.json({ success: true, message: `Transaction is already ${tx.status}.` });

  await supabase
    .from('transactions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('reference', ref)
    .eq('status', 'pending');

  console.log('[CANCEL] Cancelled by user:', ref);
  res.json({ success: true, message: 'Transaction cancelled. You can vote again.' });
});

// ── POST /api/voting/cancel-pending ──────────────────────────
// Cancels ALL pending transactions for the authenticated user.
// Called when user clicks "Cancel old payment & try again".
exports.cancelAllPending = asyncHandler(async (req, res) => {
  if (!req.user) {
    // Guest users — nothing to cancel server-side (no user_id link),
    // return success so the frontend doesn't show a false error.
    return res.json({ success: false, guest: true, message: 'Not logged in — use reference cancel instead.' });
  }

  const { error } = await supabase
    .from('transactions')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('user_id', req.user.id)
    .eq('status', 'pending');

  if (error) return res.status(500).json({ message: error.message });

  console.log('[CANCEL ALL] Cleared pending for user:', req.user.id);
  res.json({ success: true, message: 'Pending transactions cleared. You can now vote again.' });
});