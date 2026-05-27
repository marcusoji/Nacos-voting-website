// controllers/authController.js
const { supabase, supabaseAuth } = require('../config/db');
const crypto    = require('crypto');
const validator = require('validator');

// ── Email sender via Resend ───────────────────────────────────
async function sendResetEmail(toEmail, resetUrl) {
  const key = process.env.RESEND_API_KEY;

  if (!key) {
    console.log('[PASSWORD RESET — no Resend key] URL:', resetUrl);
    return;
  }

  // FIX: Use Resend's built-in test sender if domain isn't verified.
  // "onboarding@resend.dev" works immediately without domain verification.
  // For production: verify your domain at resend.com/domains then update RESEND_FROM_EMAIL.
  const fromAddress = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body   : JSON.stringify({
        from   : fromAddress,
        to     : [toEmail],
        subject: 'NACOS Awards 2026 — Reset Your Password',
        html   : `
          <div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0f1712;border-radius:12px;overflow:hidden;">
            <div style="background:#006b3c;padding:24px 32px;">
              <h1 style="color:#fff;margin:0;font-size:20px;">DELSU NACOS Awards 2026</h1>
            </div>
            <div style="padding:32px;">
              <h2 style="color:#f0f4f1;font-size:22px;margin:0 0 16px;">Password Reset</h2>
              <p style="color:#9db09a;line-height:1.7;margin:0 0 24px;">
                You requested a password reset. Click the button below — this link expires in <strong style="color:#c9a14a;">1 hour</strong>.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${resetUrl}"
                   style="display:inline-block;background:#c9a14a;color:#0a0f0d;padding:14px 32px;border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">
                  Reset My Password
                </a>
              </div>
              <p style="color:#637060;font-size:13px;margin:0;">
                If you did not request this, you can safely ignore this email.
              </p>
              <p style="color:#637060;font-size:12px;margin-top:12px;word-break:break-all;">
                Link: <a href="${resetUrl}" style="color:#c9a14a;">${resetUrl}</a>
              </p>
            </div>
          </div>`
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      // FIX: Log actual Resend error — previously silent, impossible to debug
      console.error('[RESEND ERROR]', response.status, errBody);
      console.log('[RESET URL — email failed, use this]', resetUrl);
    } else {
      console.log('[RESEND] Email sent to:', toEmail);
    }
  } catch (err) {
    console.error('[RESEND NETWORK ERROR]', err.message);
    console.log('[RESET URL — email failed, use this]', resetUrl);
  }
}

const logAction = async (userId, action, target, req) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    await supabase.from('audit_logs').insert({ user_id: userId || null, action, target, ip_address: ip });
  } catch (err) { console.error('[AUDIT]', err.message); }
};

// ── POST /api/auth/register ──────────────────────────────────
exports.register = async (req, res) => {
  try {
    let { email, password, fullname, department, matric_number } = req.body;
    if (!email || !password || !fullname)
      return res.status(400).json({ message: 'Full name, email and password are required.' });

    email    = validator.normalizeEmail(email.trim());
    fullname = validator.escape(fullname.trim());
    if (!validator.isEmail(email))
      return res.status(400).json({ message: 'Invalid email.' });
    if (!validator.isLength(password, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data, error } = await supabaseAuth.auth.signUp({
      email, password,
      options: { data: { fullname, department: department || null, matric_number: matric_number || null } }
    });
    if (error) return res.status(400).json({ message: error.message });

    if (data.user) {
      await supabase.from('profiles').upsert({
        id: data.user.id, email, fullname,
        department: department || null, matric_number: matric_number || null, role: 'user'
      }, { onConflict: 'id' });
    }

    await logAction(data.user?.id, 'USER_REGISTER', email, req);
    return res.status(201).json({ message: 'Registration successful! Check your email to verify your account.' });
  } catch (err) {
    console.error('[REGISTER]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/login ─────────────────────────────────────
exports.login = async (req, res) => {
  try {
    let { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({
        message: 'Email and password are required.'
      });

    email = validator.normalizeEmail(email.trim());

    const { data, error } =
      await supabaseAuth.auth.signInWithPassword({
        email,
        password
      });

    if (error)
      return res.status(401).json({
        message: 'Invalid credentials.'
      });

    const { data: profile } = await supabase
      .from('profiles')
      .select('role, fullname, department, matric_number')
      .eq('id', data.user.id)
      .single();

    await logAction(
      data.user.id,
      'USER_LOGIN',
      email,
      req
    );

    return res.status(200).json({
      message: 'Login successful.',
      access_token: data.session.access_token,
      user: {
        id: data.user.id,
        email: data.user.email,
        fullname:
          profile?.fullname ||
          data.user.user_metadata?.fullname,
        role: profile?.role || 'user',
        department: profile?.department || null,
        matric_number: profile?.matric_number || null
      }
    });

  } catch (err) {
    console.error('[LOGIN]', err.message);

    return res.status(500).json({
      message: 'Internal server error.'
    });
  }
};
// ── POST /api/auth/logout ────────────────────────────────────
exports.logout = (_req, res) => res.status(200).json({ message: 'Logged out.' });

// ── GET /api/auth/me ─────────────────────────────────────────
exports.getMe = async (req, res) => {
  const { data: profile } = await supabase.from('profiles')
    .select('role, fullname, department, matric_number').eq('id', req.user.id).single();
  return res.json({
    user: {
      id           : req.user.id,
      email        : req.user.email,
      fullname     : profile?.fullname,
      role         : profile?.role || 'user',
      department   : profile?.department,
      matric_number: profile?.matric_number
    }
  });
};

// ── POST /api/auth/forgot-password ───────────────────────────
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ message: 'Valid email required.' });
    email = validator.normalizeEmail(email.trim());

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 3_600_000).toISOString();

    await supabase.from('password_resets').delete().eq('email', email);
    await supabase.from('password_resets').insert({ email, token: hashedToken, expires_at: expiresAt });

    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/$/, '');
    const resetUrl = `${frontendBase}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;

    await sendResetEmail(email, resetUrl);
    await logAction(null, 'PASSWORD_RESET_REQUEST', email, req);

    return res.status(200).json({ message: 'If the account exists, reset instructions have been sent.' });
  } catch (err) {
    console.error('[FORGOT]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/reset-password ───────────────────────────
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

    const { data: profile } = await supabase.from('profiles')
      .select('id').eq('email', email).single();
    if (!profile) return res.status(404).json({ message: 'Account not found.' });

    const { error: updateErr } = await supabase.auth.admin.updateUserById(profile.id, { password: newPassword });
    if (updateErr) return res.status(500).json({ message: 'Failed to update password.' });

    await supabase.from('password_resets').delete().eq('email', email);
    await logAction(profile.id, 'PASSWORD_RESET_COMPLETE', email, req);

    return res.status(200).json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('[RESET]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
