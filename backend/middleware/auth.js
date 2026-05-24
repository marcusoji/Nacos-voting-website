const { supabase } = require('../config/db');

// ── Cookie options ─────────────────────────────────────────────
// FIX: Cross-origin cookies (frontend on one Vercel URL, backend on another)
// REQUIRE sameSite:'none' + secure:true. Without this, the browser drops the
// cookie and every authenticated request fails with 401.
const COOKIE_NAME = 'sb-access-token';

const getCookieOpts = () => ({
  httpOnly : true,
  secure   : true,                      // always true — both Vercel URLs are HTTPS
  signed   : true,
  sameSite : 'none',                    // required for cross-site cookie sending
  maxAge   : 24 * 60 * 60 * 1000,      // 24 hours
  path     : '/'
});

const clearCookieOpts = () => ({
  httpOnly : true,
  secure   : true,
  sameSite : 'none',
  path     : '/'
});

// Export so authController can use them without duplicating
module.exports.COOKIE_NAME    = COOKIE_NAME;
module.exports.getCookieOpts  = getCookieOpts;
module.exports.clearCookieOpts = clearCookieOpts;

// ── verifySession middleware ────────────────────────────────────
module.exports.verifySession = async (req, res, next) => {
  try {
    const token = req.signedCookies[COOKIE_NAME];

    if (!token) {
      return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();

    req.user     = user;
    req.userRole = profile?.role || 'user';
    next();
  } catch (err) {
    console.error('[verifySession]', err.message);
    return res.status(401).json({ message: 'Unauthorized.' });
  }
};

// ── requireRole middleware factory ─────────────────────────────
module.exports.requireRole = (roles = []) => (req, res, next) => {
  if (!req.userRole || !roles.includes(req.userRole)) {
    return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
  }
  next();
};

// ── optionalSession middleware ─────────────────────────────────
module.exports.optionalSession = async (req, res, next) => {
  try {
    const token = req.signedCookies[COOKIE_NAME];
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role')
          .eq('id', user.id)
          .single();
        req.user     = user;
        req.userRole = profile?.role || 'user';
      }
    }
  } catch { /* silent */ }
  next();
};