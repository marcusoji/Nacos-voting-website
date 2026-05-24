// controllers/authController.js
// No cookies. Token is returned in the response body and stored in localStorage.
// This is the only reliable approach for cross-origin Vercel deployments.
const { supabase, supabaseAuth } = require('../config/db');
const crypto    = require('crypto');
const validator = require('validator');

async function sendResetEmail(toEmail, resetUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key) { console.log(`[PASSWORD RESET URL] ${resetUrl}`); return; }
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    process.env.RESEND_FROM_EMAIL || 'noreply@nacos-awards.com',
      to:      [toEmail],
      subject: 'NACOS Awards — Reset Your Password',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;">
        <h2 style="color:#006b3c;">NACOS Awards 2026</h2>
        <p>You requested a password reset. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;margin:24px 0;padding:14px 28px;background:#006b3c;color:#fff;border-radius:8px;text-decoration:none;font-weight:700;">Reset Password</a>
        <p style="color:#888;font-size:13px;">If you didn't request this, ignore this email.</p>
      </div>`
    })
  });
}

const logAction = async (userId, action, target, req) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    await supabase.from('audit_logs').insert({ user_id: userId||null, action, target, ip_address: ip });
  } catch(err) { console.error('[AUDIT]', err.message); }
};

// POST /api/auth/register
exports.register = async (req, res) => {
  try {
    let { email, password, fullname, department, matric_number } = req.body;
    if (!email || !password || !fullname)
      return res.status(400).json({ message: 'Full name, email and password are required.' });

    email    = validator.normalizeEmail(email.trim());
    fullname = validator.escape(fullname.trim());
    if (!validator.isEmail(email))             return res.status(400).json({ message: 'Invalid email.' });
    if (!validator.isLength(password,{min:8})) return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data, error } = await supabaseAuth.auth.signUp({
      email, password,
      options: { data: { fullname, department: department||null, matric_number: matric_number||null } }
    });
    if (error) return res.status(400).json({ message: error.message });

    if (data.user) {
      await supabase.from('profiles').upsert({
        id: data.user.id, email, fullname,
        department: department||null, matric_number: matric_number||null, role: 'user'
      }, { onConflict: 'id' });
    }

    await logAction(data.user?.id, 'USER_REGISTER', email, req);
    return res.status(201).json({ message: 'Registration successful! Check your email to verify your account.' });
  } catch(err) {
    console.error('[REGISTER]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// POST /api/auth/login
exports.login = async (req, res) => {
  try {
    let { email, password, matric_number } = req.body;

    if (!email && matric_number) {
      const { data: p } = await supabase.from('profiles').select('email').eq('matric_number', matric_number.trim()).single();
      if (!p) return res.status(401).json({ message: 'Invalid credentials.' });
      email = p.email;
    }
    if (!email || !password) return res.status(400).json({ message: 'Email/matric and password are required.' });
    email = validator.normalizeEmail(email.trim());

    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ message: 'Invalid credentials.' });

    const { data: profile } = await supabase.from('profiles')
      .select('role, fullname, department, matric_number').eq('id', data.user.id).single();

    await logAction(data.user.id, 'USER_LOGIN', email, req);

    // Return token in body — frontend stores it in localStorage and sends as Bearer header
    return res.status(200).json({
      message:      'Login successful.',
      access_token: data.session.access_token,
      user: {
        id:            data.user.id,
        email:         data.user.email,
        fullname:      profile?.fullname || data.user.user_metadata?.fullname,
        role:          profile?.role || 'user',
        department:    profile?.department,
        matric_number: profile?.matric_number
      }
    });
  } catch(err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// POST /api/auth/logout — stateless, just tells client to clear token
exports.logout = (_req, res) => {
  return res.status(200).json({ message: 'Logged out.' });
};

// GET /api/auth/me — token read by verifySession middleware via Bearer header
exports.getMe = async (req, res) => {
  const { data: profile } = await supabase.from('profiles')
    .select('role, fullname, department, matric_number').eq('id', req.user.id).single();
  return res.json({
    user: {
      id:            req.user.id,
      email:         req.user.email,
      fullname:      profile?.fullname,
      role:          profile?.role || 'user',
      department:    profile?.department,
      matric_number: profile?.matric_number
    }
  });
};

// POST /api/auth/forgot-password
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ message: 'Valid email required.' });
    email = validator.normalizeEmail(email.trim());

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 3600000).toISOString();

    await supabase.from('password_resets').delete().eq('email', email);
    await supabase.from('password_resets').insert({ email, token: hashedToken, expires_at: expiresAt });

    const frontendBase = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');
    const resetUrl = `${frontendBase}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;

    await sendResetEmail(email, resetUrl);
    await logAction(null, 'PASSWORD_RESET_REQUEST', email, req);

    return res.status(200).json({ message: 'If the account exists, reset instructions have been sent.' });
  } catch(err) {
    console.error('[FORGOT]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// POST /api/auth/reset-password
exports.resetPassword = async (req, res) => {
  try {
    let { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword)
      return res.status(400).json({ message: 'All fields are required.' });

    email = validator.normalizeEmail(email.trim());
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const { data: record, error: fetchErr } = await supabase.from('password_resets')
      .select('*').eq('email', email).eq('token', hashedToken).single();

    if (fetchErr || !record || new Date(record.expires_at) < new Date())
      return res.status(400).json({ message: 'Invalid or expired reset token.' });
    if (!validator.isLength(newPassword, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data: profile } = await supabase.from('profiles').select('id').eq('email', email).single();
    if (!profile) return res.status(404).json({ message: 'Account not found.' });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(profile.id, { password: newPassword });
    if (updateErr) return res.status(500).json({ message: 'Failed to update password.' });

    await supabase.from('password_resets').delete().eq('email', email);
    await logAction(profile.id, 'PASSWORD_RESET_COMPLETE', email, req);

    return res.status(200).json({ message: 'Password updated. You can now log in.' });
  } catch(err) {
    console.error('[RESET]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
