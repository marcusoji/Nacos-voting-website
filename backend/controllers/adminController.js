const { supabase } = require('../config/db');
const multer = require('multer');
const path   = require('path');

const BUCKET = 'contestant-photos'; // ← BUG-01 FIX: was 'contestants'

// Multer memory storage (files never touch disk — safe for serverless)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter(req, file, cb) {
    const allowed = ['.jpg','.jpeg','.png','.webp','.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    allowed.includes(ext) ? cb(null, true) : cb(new Error('Only images are allowed (jpg, png, webp, gif).'));
  }
}).single('file');

// POST /api/admin/upload-image  — uploads to Supabase Storage, returns public URL
exports.uploadImage = (req, res) => {
  upload(req, res, async (err) => {
    if (err) return res.status(400).json({ message: err.message });
    if (!req.file) return res.status(400).json({ message: 'No file provided.' });

    const ext      = path.extname(req.file.originalname).toLowerCase() || '.jpg';
    const filename = `contestants/${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from(BUCKET)  // ← BUG-01 FIX
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (uploadErr) {
      console.error('[UPLOAD]', uploadErr.message);
      return res.status(500).json({ message: 'Image upload failed: ' + uploadErr.message });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename); // ← BUG-01 FIX
    return res.status(201).json({ url: urlData.publicUrl });
  });
};

// ── Categories ──────────────────────────────────────────────
exports.createCategory = async (req, res) => {
  try {
    const { name, slug, description } = req.body;
    if (!name || !slug) return res.status(400).json({ message: 'Name and slug are required.' });
    const cleanSlug = slug.toLowerCase().replace(/\s+/g,'-').replace(/[^a-z0-9-]/g,'');
    const { data, error } = await supabase.from('categories')
      .insert([{ name: name.trim(), slug: cleanSlug, description: description||'' }]).select().single();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ message: 'Category name or slug already exists.' });
      throw error;
    }
    return res.status(201).json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteCategory = async (req, res) => {
  try {
    const { error } = await supabase.from('categories').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Category deleted.' });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── Contestants ─────────────────────────────────────────────
exports.getAllContestants = async (req, res) => {
  try {
    const { data, error } = await supabase.from('contestants')
      .select('*, categories(name, slug)').order('vote_count', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.createContestant = async (req, res) => {
  try {
    const { category_id, fullname, avatar_url, bio } = req.body;
    if (!category_id || !fullname || !avatar_url)
      return res.status(400).json({ message: 'category_id, fullname and avatar_url are required.' });

    // Validate avatar_url is a Supabase Storage URL (basic check)
    if (!avatar_url.includes('supabase.co/storage')) {
      return res.status(400).json({ message: 'avatar_url must be a Supabase Storage URL.' });
    }

    const { data, error } = await supabase.from('contestants')
      .insert([{ category_id, fullname: fullname.trim(), avatar_url, bio: bio||'' }]).select().single();
    if (error) throw error;
    return res.status(201).json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.updateContestant = async (req, res) => {
  try {
    const { fullname, avatar_url, bio, vote_count } = req.body;
    const payload = {};
    if (fullname   !== undefined) payload.fullname   = String(fullname).trim();
    if (avatar_url !== undefined) payload.avatar_url = avatar_url;
    if (bio        !== undefined) payload.bio        = String(bio).trim();
    if (req.userRole === 'admin' && vote_count !== undefined) {
      const vc = parseInt(vote_count, 10);
      if (!isNaN(vc) && vc >= 0) payload.vote_count = vc;
    }
    if (Object.keys(payload).length === 0)
      return res.status(400).json({ message: 'No valid fields to update.' });
    const { data, error } = await supabase.from('contestants')
      .update(payload).eq('id', req.params.id).select().single();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteContestant = async (req, res) => {
  try {
    const { error } = await supabase.from('contestants').delete().eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'Contestant deleted.' });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── Users ────────────────────────────────────────────────────
exports.getUsers = async (req, res) => {
  try {
    const { data, error } = await supabase.from('profiles')
      .select('id, fullname, email, department, matric_number, role, created_at')
      .order('created_at', { ascending: false });
    if (error) throw error;
    return res.json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.deleteUser = async (req, res) => {
  try {
    // Prevent self-deletion
    if (req.params.id === req.user?.id)
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'User deleted.' });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

// BUG-06 FIX: Removed broken single-admin guard; allow multiple admins
exports.updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user','moderator','admin'].includes(role))
      return res.status(400).json({ message: 'Invalid role. Must be user, moderator, or admin.' });
    // Prevent changing own role
    if (req.params.id === req.user?.id)
      return res.status(400).json({ message: 'You cannot change your own role.' });
    const { data, error } = await supabase.from('profiles')
      .update({ role }).eq('id', req.params.id).select().single();
    if (error) throw error;
    return res.json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── Analytics ────────────────────────────────────────────────
exports.getSystemAnalytics = async (req, res) => {
  try {
    const [
      { count: totalUsers },
      { count: totalVotes },
      { data: revenue },
      { data: recentTx }
    ] = await Promise.all([
      supabase.from('profiles').select('*', { count:'exact', head:true }),
      supabase.from('votes').select('*', { count:'exact', head:true }),
      supabase.rpc('get_total_revenue'),
      supabase.from('transactions')
        .select('reference, amount, quantity, status, created_at, metadata, contestants(fullname)')
        .order('created_at', { ascending: false }).limit(20)
    ]);
    return res.json({
      success: true,
      metrics: { users: totalUsers||0, votes: totalVotes||0, revenue: revenue||0 },
      recentTransactions: recentTx||[]
    });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

// ── Transactions ─────────────────────────────────────────────
exports.getTransactions = async (req, res) => {
  try {
    const { data, error } = await supabase.from('transactions')
      .select('*, contestants(fullname), categories(name)')
      .order('created_at', { ascending: false }).limit(200);
    if (error) throw error;
    return res.json({ success: true, data });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};


// ── POST /api/admin/transactions/:ref/force-approve ──────────
// Admin manually credits votes after confirming payment was received.
// Handles VT- single refs, BT-xxx-uuid individual batch rows, and pure BT- batch refs.
exports.forceApproveTransaction = async (req, res) => {
  try {
    const ref = String(req.params.ref || '').toUpperCase().trim();
    if (!ref) return res.status(400).json({ message: 'Reference required.' });

    // ── Step 1: always try exact reference match first ───────────
    const { data: exactTx } = await supabase
      .from('transactions').select('*').eq('reference', ref).maybeSingle();

    if (exactTx) {
      // Found a single row by exact reference — approve it directly
      if (exactTx.status === 'success')
        return res.json({ success: true, message: 'Already recorded — votes are already credited.' });

      // Re-open cancelled/failed TX to 'pending' so the RPC (which checks status='pending') can process it.
      if (exactTx.status !== 'pending') {
        const { error: reopenErr } = await supabase
          .from('transactions')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
          .eq('reference', ref)
          .in('status', ['cancelled', 'failed']);
        if (reopenErr) {
          console.error('[FORCE APPROVE REOPEN]', reopenErr.message);
          return res.status(500).json({ message: `Failed to re-open transaction: ${reopenErr.message}` });
        }
        console.log(`[FORCE APPROVE] Re-opened ${exactTx.status} TX for processing: ${ref}`);
      }

     // IMPORTANT:
// Re-open cancelled/failed transaction before processing
// because the SQL RPC only processes pending rows.
if (['cancelled', 'failed'].includes(exactTx.status)) {
  const { error: reopenErr } = await supabase
    .from('transactions')
    .update({
      status: 'pending',
      updated_at: new Date().toISOString(),
      admin_override: true
    })
    .eq('reference', ref);

  if (reopenErr) {
    console.error('[FORCE APPROVE REOPEN]', reopenErr);

    return res.status(500).json({
      message: 'Could not reopen transaction.'
    });
  }
}

// NOW process the votes
const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
  p_tx_ref: ref,
  p_cat_id: exactTx.category_id,
  p_con_id: exactTx.contestant_id,
  p_usr_id: exactTx.user_id || null,
  p_qty   : exactTx.quantity
});

if (rpcErr) {
  console.error('[FORCE APPROVE RPC]', rpcErr);

  return res.status(500).json({
    message: rpcErr.message || 'Vote processing failed.'
  });
}

if (!processed) {
  return res.status(400).json({
    message: 'Transaction already processed or could not be approved.'
  });
}

      if (rpcErr) {
        console.error('[FORCE APPROVE RPC]', rpcErr.message);
        return res.status(500).json({ message: `RPC error: ${rpcErr.message}` });
      }

      await supabase.from('audit_logs').insert({
        user_id   : req.user?.id,
        action    : 'FORCE_APPROVE_TRANSACTION',
        target    : ref,
        ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.ip
      }).catch(() => {});

      console.log(`[FORCE APPROVE] ref:${ref} by admin:${req.user?.id} qty:${exactTx.quantity}`);
      return res.json({
        success  : true,
        message  : `✓ ${exactTx.quantity} vote(s) credited for ${ref}.`,
        quantity : exactTx.quantity,
        reference: ref
      });
    }

    // ── Step 2: no exact match — try batch_reference (pure BT- ref) ──
    if (ref.startsWith('BT-')) {
      const { data: txRows, error: txErr } = await supabase
        .from('transactions').select('*').eq('batch_reference', ref);

      if (txErr || !txRows || txRows.length === 0)
        return res.status(404).json({ message: 'Transaction not found. The reference may belong to a payment that was never saved to the database.' });

      const pending = txRows.filter(t => t.status !== 'success');
      if (pending.length === 0)
        return res.json({ success: true, message: 'Already recorded — all votes in this batch are already credited.' });

      // Re-open any cancelled/failed rows to 'pending' so the RPC can process them.
      const nonPending = pending.filter(t => t.status !== 'pending');
      if (nonPending.length > 0) {
        const { error: reopenErr } = await supabase
          .from('transactions')
          .update({ status: 'pending', updated_at: new Date().toISOString() })
          .eq('batch_reference', ref)
          .in('status', ['cancelled', 'failed']);
        if (reopenErr) {
          console.error('[FORCE APPROVE BATCH REOPEN]', reopenErr.message);
          return res.status(500).json({ message: `Failed to re-open batch transactions: ${reopenErr.message}` });
        }
        console.log(`[FORCE APPROVE BATCH] Re-opened ${nonPending.length} non-pending rows for: ${ref}`);
      }

      const errors = [];
      let totalQty = 0;

      for (const tx of pending) {
        const { error: rpcErr } = await supabase.rpc('process_vote_transaction', {
          p_tx_ref: tx.reference,
          p_cat_id: tx.category_id,
          p_con_id: tx.contestant_id,
          p_usr_id: tx.user_id || null,
          p_qty   : tx.quantity
        });
        if (rpcErr) {
          console.error('[FORCE APPROVE BATCH RPC]', tx.reference, rpcErr.message);
          errors.push(`${tx.reference}: ${rpcErr.message}`);
        } else {
          totalQty += tx.quantity;
        }
      }

      await supabase.from('audit_logs').insert({
        user_id   : req.user?.id,
        action    : 'FORCE_APPROVE_BATCH',
        target    : ref,
        ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.ip
      }).catch(() => {});

      console.log(`[FORCE APPROVE BATCH] ref:${ref} by admin:${req.user?.id} qty:${totalQty} errors:${errors.length}`);

      if (errors.length > 0)
        return res.status(207).json({ success: false, message: `Partial approval — ${errors.length} row(s) failed.`, errors });

      return res.json({
        success  : true,
        message  : `✓ ${totalQty} vote(s) credited for batch ${ref}.`,
        quantity : totalQty,
        reference: ref
      });
    }

    // ── Step 3: nothing found at all ─────────────────────────────
    return res.status(404).json({ message: 'Transaction not found. The reference may belong to a payment that was never saved to the database.' });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ── DELETE /api/admin/transactions/:ref ──────────────────────
// Admin deletes a transaction record (cancelled, failed, or erroneous ones).
// Does NOT reverse votes if already credited — use with caution.
exports.deleteTransaction = async (req, res) => {
  try {
    const ref = String(req.params.ref || '').toUpperCase().trim();
    if (!ref) return res.status(400).json({ message: 'Reference required.' });

    const { data: tx } = await supabase
      .from('transactions').select('status').eq('reference', ref).single();

    if (!tx) return res.status(404).json({ message: 'Transaction not found.' });

    if (tx.status === 'success') {
      return res.status(400).json({
        message: 'Cannot delete a successful transaction — it has credited votes. Use force-approve to fix errors instead.'
      });
    }

    const { error } = await supabase
      .from('transactions').delete().eq('reference', ref);

    if (error) return res.status(500).json({ message: error.message });

    await supabase.from('audit_logs').insert({
      user_id   : req.user?.id,
      action    : 'DELETE_TRANSACTION',
      target    : ref,
      ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.ip
    }).catch(() => {});

    console.log(`[DELETE TX] ref:${ref} deleted by admin:${req.user?.id}`);
    res.json({ success: true, message: `Transaction ${ref} deleted.` });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};