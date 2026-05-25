// controllers/authController.js
const { supabase } = require('../config/db');  // FIX 1: one client only — supabase has service_role,
                                                // which can do both admin ops AND anon-equivalent ops.
                                                // supabaseAuth was redundant and may not be exported.
const crypto    = require('crypto');
const validator = require('validator');

// ── Email sender via Resend ───────────────────────────────────
async function sendResetEmail(toEmail, resetUrl) {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.log('[RESET EMAIL — no RESEND_API_KEY] Use this URL:', resetUrl);
    return;
  }

  const fromAddress = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';

  // FIX 5: Add 10s timeout so a Resend API hang doesn't block the request for 2 minutes
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method : 'POST',
      signal : controller.signal,
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
                You requested a password reset. Click the button below — this link expires in
                <strong style="color:#c9a14a;">1 hour</strong>.
              </p>
              <div style="text-align:center;margin:28px 0;">
                <a href="${resetUrl}"
                   style="display:inline-block;background:#c9a14a;color:#0a0f0d;padding:14px 32px;
                          border-radius:8px;font-weight:700;font-size:16px;text-decoration:none;">
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

    clearTimeout(timer);

    if (!response.ok) {
      const errBody = await response.text();
      console.error('[RESEND ERROR]', response.status, errBody);
      console.log('[RESET URL — email failed, use this]', resetUrl);
    } else {
      console.log('[RESEND] Email sent to:', toEmail);
    }
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      console.error('[RESEND TIMEOUT] Request took >10s — skipped');
    } else {
      console.error('[RESEND NETWORK ERROR]', err.message);
    }
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
    // FIX 4: Do NOT use validator.escape() on names — it HTML-encodes apostrophes and
    // special characters, storing "O&#x27;Brien" in the DB instead of "O'Brien".
    // Just trim and length-check instead.
    fullname = fullname.trim();

    if (!validator.isEmail(email))
      return res.status(400).json({ message: 'Invalid email.' });
    if (!validator.isLength(password, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });
    if (!validator.isLength(fullname, { min: 2, max: 100 }))
      return res.status(400).json({ message: 'Full name must be 2–100 characters.' });

    // FIX 1: Use supabase (service role) for signUp — works identically to anon client for this
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { fullname, department: department || null, matric_number: matric_number || null } }
    });
    if (error) return res.status(400).json({ message: error.message });

    if (data.user) {
      await supabase.from('profiles').upsert({
        id           : data.user.id,
        email,
        fullname,
        department   : department    ? String(department).trim()    : null,
        matric_number: matric_number ? String(matric_number).trim() : null,
        role         : 'user'
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
    let { email, password, matric_number } = req.body;

    // Matric number login — look up email first
    if (!email && matric_number) {
      const { data: p } = await supabase.from('profiles')
        .select('email').eq('matric_number', String(matric_number).trim()).single();
      if (!p) return res.status(401).json({ message: 'Invalid credentials.' });
      email = p.email;
    }

    if (!email || !password)
      return res.status(400).json({ message: 'Email/matric and password are required.' });

    email = validator.normalizeEmail(email.trim());

    // FIX 1: Use supabase (service role client) for signInWithPassword
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return res.status(401).json({ message: 'Invalid credentials.' });

    const { data: profile } = await supabase.from('profiles')
      .select('role, fullname, department, matric_number').eq('id', data.user.id).single();

    await logAction(data.user.id, 'USER_LOGIN', email, req);

    return res.status(200).json({
      message     : 'Login successful.',
      access_token: data.session.access_token,
      user: {
        id           : data.user.id,
        email        : data.user.email,
        fullname     : profile?.fullname || data.user.user_metadata?.fullname,
        role         : profile?.role || 'user',
        department   : profile?.department,
        matric_number: profile?.matric_number
      }
    });
  } catch (err) {
    console.error('[LOGIN]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/logout ────────────────────────────────────
// FIX 2: Actually invalidate the Supabase session so the JWT stops working on the backend.
// Previously this just returned 200 without touching the token — the JWT stayed valid.
exports.logout = async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '').trim();
    if (token) {
      // admin.signOut invalidates the specific session server-side
      const { error } = await supabase.auth.admin.signOut(token);
      if (error) console.warn('[LOGOUT] signOut error (non-fatal):', error.message);
    }
  } catch (err) {
    console.warn('[LOGOUT] Error (non-fatal):', err.message);
  }
  return res.status(200).json({ message: 'Logged out.' });
};

// ── GET /api/auth/me ─────────────────────────────────────────
// FIX 3: Add try/catch — previously this had none, so any DB error would
// crash with an unhandled exception and expose a stack trace.
exports.getMe = async (req, res) => {
  try {
    const { data: profile, error } = await supabase.from('profiles')
      .select('role, fullname, department, matric_number').eq('id', req.user.id).single();

    if (error) throw error;

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
  } catch (err) {
    console.error('[GET ME]', err.message);
    return res.status(500).json({ message: 'Failed to load profile.' });
  }
};

// ── POST /api/auth/forgot-password ───────────────────────────
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;
    if (!email || !validator.isEmail(email.trim()))
      return res.status(400).json({ message: 'Valid email required.' });

    email = validator.normalizeEmail(email.trim());

    // FIX 6: Check if email exists before inserting reset token — avoids wasted DB
    // writes for non-existent accounts while keeping the response identical (no enumeration).
    const { data: profile } = await supabase.from('profiles')
      .select('id').eq('email', email).single();

    if (!profile) {
      // Respond identically whether account exists or not — prevents email enumeration
      return res.status(200).json({ message: 'If the account exists, reset instructions have been sent.' });
    }

    const rawToken    = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 3_600_000).toISOString();

    // Invalidate any existing tokens for this email first
    await supabase.from('password_resets').delete().eq('email', email);
    await supabase.from('password_resets').insert({ email, token: hashedToken, expires_at: expiresAt });

    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/$/, '');
    const resetUrl = `${frontendBase}/reset-password.html?token=${rawToken}&email=${encodeURIComponent(email)}`;

    // Non-blocking — don't await (so a slow Resend API doesn't hold up the response)
    sendResetEmail(email, resetUrl).catch(err => console.error('[SEND EMAIL]', err.message));

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
    const hashedToken = crypto.createHash('sha256').update(String(token)).digest('hex');

    const { data: record, error: fetchErr } = await supabase.from('password_resets')
      .select('*').eq('email', email).eq('token', hashedToken).single();

    if (fetchErr || !record || new Date(record.expires_at) < new Date())
      return res.status(400).json({ message: 'Invalid or expired reset token.' });

    if (!validator.isLength(String(newPassword), { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    const { data: profile } = await supabase.from('profiles')
      .select('id').eq('email', email).single();
    if (!profile) return res.status(404).json({ message: 'Account not found.' });

    // FIX 1: supabase (service role) is correct for admin.updateUserById — no change needed
    const { error: updateErr } = await supabase.auth.admin.updateUserById(
      profile.id, { password: newPassword }
    );
    if (updateErr) {
      console.error('[RESET PASSWORD UPDATE]', updateErr.message);
      return res.status(500).json({ message: 'Failed to update password. Try again.' });
    }

    // Delete token after use — one-time use only
    await supabase.from('password_resets').delete().eq('email', email);
    await logAction(profile.id, 'PASSWORD_RESET_COMPLETE', email, req);

    return res.status(200).json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('[RESET]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
