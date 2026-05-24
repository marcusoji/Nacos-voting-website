const { supabase } = require('../config/db');
const crypto       = require('crypto');
const validator    = require('validator');
const {
  COOKIE_NAME, getCookieOpts, clearCookieOpts
} = require('../middleware/auth');

// Resend is optional — graceful fallback if not installed
let resend;
try {
  const { Resend } = require('resend');
  if (process.env.RESEND_API_KEY) resend = new Resend(process.env.RESEND_API_KEY);
} catch { /* resend not installed */ }

const FRONTEND = () =>
  (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/$/, '');

const logAction = async (userId, action, target, req) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
    await supabase.from('audit_logs').insert({ user_id: userId || null, action, target, ip_address: ip });
  } catch (e) { console.error('[AUDIT]', e.message); }
};

// ── POST /api/auth/register ─────────────────────────────────
exports.register = async (req, res) => {
  try {
    let { email, password, fullname, department, matric_number } = req.body;

    if (!email || !password || !fullname)
      return res.status(400).json({ message: 'Full name, email and password are required.' });

    email    = validator.normalizeEmail(email.trim());
    fullname = validator.escape(fullname.trim());

    if (!validator.isEmail(email))
      return res.status(400).json({ message: 'Invalid email address.' });
    if (!validator.isLength(password, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { fullname, department: department || null, matric_number: matric_number || null } }
    });

    if (error) return res.status(400).json({ message: error.message });

    if (data.user) {
      await supabase.from('profiles').upsert({
        id: data.user.id, email, fullname,
        department: department || null,
        matric_number: matric_number || null,
        role: 'user'
      }, { onConflict: 'id' });
    }

    await logAction(data.user?.id, 'USER_REGISTER', email, req);
    return res.status(201).json({ message: 'Registration successful. Check your email to verify your account.' });
  } catch (err) {
    console.error('[REGISTER]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/login ────────────────────────────────────
exports.login = async (req, res) => {
  try {
    let { email, password, matric_number } = req.body;

    if (!email && matric_number) {
      const { data: profile } = await supabase
        .from('profiles').select('email').eq('matric_number', matric_number.trim()).single();
      if (!profile) return res.status(401).json({ message: 'Invalid credentials.' });
      email = profile.email;
    }

    if (!email || !password)
      return res.status(400).json({ message: 'Email/matric and password are required.' });

    email = validator.normalizeEmail(email.trim());

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ message: 'Invalid credentials.' });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, fullname, department, matric_number')
      .eq('id', data.user.id)
      .single();

    // FIX: use shared cookie options (sameSite:'none', secure:true for cross-origin)
    res.cookie(COOKIE_NAME, data.session.access_token, getCookieOpts());

    await logAction(data.user.id, 'USER_LOGIN', email, req);

    return res.status(200).json({
      message: 'Login successful.',
      user: {
        id            : data.user.id,
        email         : data.user.email,
        fullname      : profile?.fullname || data.user.user_metadata?.fullname,
        role          : profile?.role || 'user',
        department    : profile?.department,
        matric_number : profile?.matric_number
      }
    });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/logout ───────────────────────────────────
exports.logout = (_req, res) => {
  res.clearCookie(COOKIE_NAME, clearCookieOpts());
  return res.status(200).json({ message: 'Logged out successfully.' });
};

// ── GET /api/auth/me ────────────────────────────────────────
exports.getMe = async (req, res) => {
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, fullname, department, matric_number')
    .eq('id', req.user.id)
    .single();

  return res.json({
    user: {
      id            : req.user.id,
      email         : req.user.email,
      fullname      : profile?.fullname,
      role          : profile?.role || 'user',
      department    : profile?.department,
      matric_number : profile?.matric_number
    }
  });
};

// ── POST /api/auth/forgot-password ─────────────────────────
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ message: 'Valid email required.' });
    email = validator.normalizeEmail(email.trim());

    const { data: profile } = await supabase
      .from('profiles').select('id').eq('email', email).single();

    // Always return 200 — prevents email enumeration
    if (!profile) return res.status(200).json({ message: 'If that account exists, reset instructions have been sent.' });

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 3_600_000).toISOString();

    await supabase.from('password_resets').delete().eq('email', email);
    await supabase.from('password_resets').insert({ email, token: hashedToken, expires_at: expiresAt });

    const resetUrl = `${FRONTEND()}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;

    if (resend) {
      try {
        await resend.emails.send({
          from   : process.env.RESEND_FROM_EMAIL || 'noreply@nacosawards.com',
          to     : email,
          subject: 'NACOS Awards 2026 — Password Reset',
          html   : buildResetEmail(resetUrl)
        });
      } catch (emailErr) {
        console.error('[RESEND]', emailErr.message);
        console.log('[RESET URL]', resetUrl); // fallback log
      }
    } else {
      console.log('[RESET URL — Resend not configured]', resetUrl);
    }

    await logAction(null, 'PASSWORD_RESET_REQUEST', email, req);
    return res.status(200).json({ message: 'If that account exists, reset instructions have been sent.' });
  } catch (err) {
    console.error('[FORGOT PASSWORD]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/reset-password ──────────────────────────
exports.resetPassword = async (req, res) => {
  try {
    let { email, token, newPassword } = req.body;
    if (!email || !token || !newPassword)
      return res.status(400).json({ message: 'All fields are required.' });

    email = validator.normalizeEmail(email.trim());
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const { data: record, error: fetchErr } = await supabase
      .from('password_resets').select('*')
      .eq('email', email).eq('token', hashedToken).single();

    if (fetchErr || !record || new Date(record.expires_at) < new Date())
      return res.status(400).json({ message: 'Invalid or expired reset token.' });

    if (!validator.isLength(newPassword, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data: profile } = await supabase
      .from('profiles').select('id').eq('email', email).single();
    if (!profile) return res.status(404).json({ message: 'Account not found.' });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(profile.id, { password: newPassword });
    if (updateErr) return res.status(500).json({ message: 'Failed to update password.' });

    await supabase.from('password_resets').delete().eq('email', email);
    await logAction(profile.id, 'PASSWORD_RESET_COMPLETE', email, req);
    return res.status(200).json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('[RESET PASSWORD]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

function buildResetEmail(resetUrl) {
  return `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#0a0f0d;font-family:Arial,sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 16px;">
    <table width="560" cellpadding="0" cellspacing="0" style="background:#0f1712;border:1px solid rgba(201,161,74,.2);border-radius:16px;overflow:hidden;">
    <tr><td style="padding:32px 40px;border-bottom:1px solid rgba(255,255,255,.07);font-family:Georgia,serif;font-size:20px;font-weight:700;color:#c9a14a;">DELSU NACOS Awards 2026</td></tr>
    <tr><td style="padding:40px;">
      <h1 style="font-family:Georgia,serif;color:#f0f4f1;font-size:24px;margin:0 0 16px;">Password Reset</h1>
      <p style="color:#a0b09a;font-size:15px;line-height:1.7;margin:0 0 28px;">Click the button below to reset your password. This link expires in 1 hour.</p>
      <div style="text-align:center;margin:28px 0;">
        <a href="${resetUrl}" style="display:inline-block;background:#c9a14a;color:#0a0f0d;padding:14px 36px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">Reset Password</a>
      </div>
      <p style="color:#637060;font-size:13px;margin:0;">If you did not request this, ignore this email.</p>
    </td></tr>
    </table></td></tr></table></body></html>`;
}