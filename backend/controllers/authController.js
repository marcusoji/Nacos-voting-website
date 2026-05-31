// controllers/authController.js
const { supabase, supabaseAuth } = require('../config/db');
const validator = require('validator');

const logAction = async (userId, action, target, req) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress;
    await supabase.from('audit_logs').insert({ user_id: userId || null, action, target, ip_address: ip });
  } catch (err) { console.error('[AUDIT]', err.message); }
};

// ── POST /api/auth/register ──────────────────────────────────
exports.register = async (req, res) => {
  try {
    let {
  email,
  password,
  fullname,
  department = null,
  matric_number = null
} = req.body;
    if (!email || !password || !fullname)
      return res.status(400).json({ message: 'Full name, email and password are required.' });

    email    = validator.normalizeEmail(email.trim());
    fullname = validator.escape(fullname.trim());

department =
  department?.trim()
    ? validator.escape(department.trim())
    : null;

matric_number =
  matric_number?.trim()
    ? matric_number.trim().toLowerCase()
    : null;
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
      refresh_token: data.session.refresh_token,
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

// POST /api/auth/refresh — exchange a refresh_token for a new access_token
exports.refresh = async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token)
    return res.status(400).json({ message: 'refresh_token is required.' });
  try {
    const { data, error } = await supabaseAuth.auth.refreshSession({ refresh_token });
    if (error || !data?.session)
      return res.status(401).json({ message: 'Refresh token invalid or expired. Please log in again.' });
    return res.status(200).json({
      access_token : data.session.access_token,
      refresh_token: data.session.refresh_token
    });
  } catch (err) {
    console.error('[REFRESH]', err.message);
    return res.status(500).json({ message: 'Server error during token refresh.' });
  }
};

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
// Delegates entirely to Supabase — no custom token, no Resend.
// Supabase will send its own branded reset email.
// The redirect URL must be configured in your Supabase project:
//   Authentication → URL Configuration → Redirect URLs
//   Add: https://your-frontend.com/reset-password.html
exports.requestPasswordReset = async (req, res) => {
  try {
    let { email } = req.body;
    if (!email || !validator.isEmail(email))
      return res.status(400).json({ message: 'Valid email required.' });
    email = validator.normalizeEmail(email.trim());

    const frontendBase = (process.env.FRONTEND_URL || '')
      .split(',')[0].trim().replace(/\/$/, '');
    const redirectTo = `${frontendBase}/reset-password.html`;

    // Supabase sends the email; we do not handle delivery here.
    // Error is intentionally swallowed so we never reveal whether
    // an account exists (same security posture as before).
    const { error } = await supabaseAuth.auth.resetPasswordForEmail(email, {
      redirectTo
    });

    if (error) {
      // Log for debugging but return generic message to client
      console.error('[FORGOT-PASSWORD] Supabase error:', error.message);
    }

    await logAction(null, 'PASSWORD_RESET_REQUEST', email, req);

    // Always return 200 so attackers can't enumerate accounts
    return res.status(200).json({ message: 'If the account exists, reset instructions have been sent.' });
  } catch (err) {
    console.error('[FORGOT]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};

// ── POST /api/auth/reset-password ───────────────────────────
// Accepts the access_token Supabase embedded in the recovery link.
// Flow:
//   1. User clicks Supabase email link → lands on reset-password.html
//      with #access_token=...&type=recovery in the URL hash.
//   2. Frontend extracts the token and POSTs it here along with the
//      new password.
//   3. We set a session for that token, then call updateUser to change
//      the password, then immediately sign out.
exports.resetPassword = async (req, res) => {
  try {
    const { access_token, newPassword } = req.body;

    if (!access_token || !newPassword)
      return res.status(400).json({ message: 'access_token and newPassword are required.' });

    if (!validator.isLength(newPassword, { min: 8 }))
      return res.status(400).json({ message: 'Password must be at least 8 characters.' });

    // Establish a session from the recovery token so we can call updateUser
    const { data: sessionData, error: sessionErr } =
      await supabaseAuth.auth.setSession({
        access_token,
        refresh_token: access_token   // Supabase recovery tokens double as refresh tokens
      });

    if (sessionErr || !sessionData?.user) {
      console.error('[RESET] setSession error:', sessionErr?.message);
      return res.status(400).json({ message: 'Invalid or expired reset link. Please request a new one.' });
    }

    // Update the password while authenticated as this user
    const { error: updateErr } = await supabaseAuth.auth.updateUser({ password: newPassword });

    if (updateErr) {
      console.error('[RESET] updateUser error:', updateErr.message);
      return res.status(400).json({ message: updateErr.message || 'Failed to update password.' });
    }

    // Sign out this ephemeral session so the recovery token can't be reused
    await supabaseAuth.auth.signOut();

    await logAction(sessionData.user.id, 'PASSWORD_RESET_COMPLETE', sessionData.user.email, req);

    return res.status(200).json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('[RESET]', err.message);
    return res.status(500).json({ message: 'Internal server error.' });
  }
};
