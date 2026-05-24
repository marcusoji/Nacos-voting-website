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
