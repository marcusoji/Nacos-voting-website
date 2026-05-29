const { supabase } = require('../config/db');
const multer = require('multer');
const path   = require('path');

const BUCKET = 'contestant-photos'; 

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
      .from(BUCKET)  
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });

    if (uploadErr) {
      console.error('[UPLOAD]', uploadErr.message);
      return res.status(500).json({ message: 'Image upload failed: ' + uploadErr.message });
    }

    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(filename); 
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
    if (req.params.id === req.user?.id)
      return res.status(400).json({ message: 'You cannot delete your own account.' });
    const { error } = await supabase.auth.admin.deleteUser(req.params.id);
    if (error) throw error;
    return res.json({ success: true, message: 'User deleted.' });
  } catch(err) { return res.status(500).json({ success: false, message: err.message }); }
};

exports.updateUserRole = async (req, res) => {
  try {
    const { role } = req.body;
    if (!['user','moderator','admin'].includes(role))
      return res.status(400).json({ message: 'Invalid role. Must be user, moderator, or admin.' });
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
// ── POST /api/admin/transactions/:ref/force-approve ──────────
// Upgraded to dynamically create missing transactions on the fly
// ── POST /api/admin/transactions/:ref/force-approve ──────────
// Upgraded to dynamically create missing transactions on the fly
exports.forceApproveTransaction = async (req, res) => {
  try {
    const ref = String(req.params.ref || '').toUpperCase().trim();
    if (!ref) return res.status(400).json({ message: 'Reference required.' });

    // Grab extra payload fields from body in case we need to create a missing row
    const { category_id, contestant_id, quantity, amount, user_id } = req.body;

    console.log('[FORCE APPROVE] Starting for ref:', ref, 'body:', req.body);

    // ── Step 1: Try exact reference match ───────────
    let { data: exactTx } = await supabase
      .from('transactions').select('*').eq('reference', ref).maybeSingle();

    // ── CRITICAL FIX: Row does not exist ──
    if (!exactTx) {
      console.log(`[FORCE APPROVE] Ref ${ref} not found. Attempting on-the-fly creation...`);
      
      // Validate that the admin passed the required voting details
      if (!category_id || !contestant_id || !quantity) {
        return res.status(400).json({ 
          success: false,
          message: 'Transaction row not found. To force-create, provide: category_id, contestant_id, quantity in request body.' 
        });
      }

      // Get contestant info to verify existence
      const { data: contestant, error: conErr } = await supabase
        .from('contestants')
        .select('id, category_id')
        .eq('id', contestant_id)
        .single();
        
      if (conErr || !contestant) {
        return res.status(404).json({
          success: false,
          message: `Contestant ${contestant_id} not found.`
        });
      }

      const qtyNum = parseInt(quantity, 10);
      if (isNaN(qtyNum) || qtyNum < 1 || qtyNum > 1000) {
        return res.status(400).json({
          success: false,
          message: 'Quantity must be between 1 and 1000.'
        });
      }

      const amountNum = amount || (qtyNum * 50); // ₦50 per vote default

      // Insert the missing transaction row as 'pending' first
      const { data: newTx, error: createErr } = await supabase
        .from('transactions')
        .insert([{
          reference: ref,
          category_id: category_id,
          contestant_id: contestant_id,
          user_id: user_id || null,
          quantity: qtyNum,
          amount: amountNum,
          status: 'pending',
          admin_override: true,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {
            admin_created: true,
            created_by: req.user?.id,
            original_ref: ref
          }
        }])
        .select()
        .single();

      if (createErr) {
        console.error('[FORCE APPROVE CREATION FAILED]', createErr.message);
        return res.status(500).json({ 
          success: false,
          message: `Failed to create missing transaction row: ${createErr.message}` 
        });
      }

      exactTx = newTx;
      console.log('[FORCE APPROVE] Created new transaction row:', exactTx.reference);
    }

    // ── Step 2: Process the transaction ──
    if (exactTx.status === 'success') {
      return res.json({ 
        success: true, 
        message: 'Already recorded — votes are already credited.' 
      });
    }

    // Re-open cancelled/failed TX to 'pending' so the RPC can catch it
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
        console.error('[FORCE APPROVE REOPEN]', reopenErr.message);
        return res.status(500).json({ 
          success: false,
          message: `Failed to re-open transaction: ${reopenErr.message}` 
        });
      }
      console.log('[FORCE APPROVE] Re-opened transaction:', ref);
    }

    // Process the database RPC function
    const { data: processed, error: rpcErr } = await supabase.rpc('process_vote_transaction', {
      p_tx_ref: ref,
      p_cat_id: exactTx.category_id,
      p_con_id: exactTx.contestant_id,
      p_usr_id: exactTx.user_id || null,
      p_qty   : exactTx.quantity
    });

    if (rpcErr) {
      console.error('[FORCE APPROVE RPC]', rpcErr.message);
      return res.status(500).json({ 
        success: false,
        message: `Vote processing failed: ${rpcErr.message}` 
      });
    }

    if (!processed) {
      return res.status(400).json({ 
        success: false,
        message: 'Transaction already processed or could not be approved.' 
      });
    }

    // Write to audit log
    await supabase.from('audit_logs').insert({
      user_id   : req.user?.id,
      action    : 'FORCE_APPROVE_TRANSACTION',
      target    : ref,
      ip_address: req.headers['x-forwarded-for']?.split(',')[0] || req.ip
    }).catch(() => {});

    return res.json({
      success  : true,
      message  : `✓ ${exactTx.quantity} vote(s) credited for ${ref}.`,
      quantity : exactTx.quantity,
      reference: ref
    });

  } catch (err) {
    console.error('[FORCE APPROVE ERROR]', err);
    return res.status(500).json({ 
      success: false,
      message: err.message 
    });
  }
};
// ── DELETE /api/admin/transactions/:ref ──────────────────────
exports.deleteTransaction = async (req, res) => {
  try {
    const ref = String(req.params.ref || '').toUpperCase().trim();
    if (!ref) return res.status(400).json({ message: 'Reference required.' });

    const { data: tx } = await supabase
      .from('transactions').select('status').eq('reference', ref).maybeSingle();

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

    return res.json({ success: true, message: `Transaction ${ref} deleted.` });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};