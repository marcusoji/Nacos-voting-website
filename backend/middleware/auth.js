const { supabase, supabaseAuth } = require('../config/db');

/**
 * verifySession
 * Reads from BOTH standard Authorization Headers (Bearer) and signed cookies.
 */
const verifySession = async (req, res, next) => {
  try {
    let token = null;

    // 1. Check for Authorization: Bearer <token> header (Used by frontend apiFetch)
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } 
    // 2. Fallback to reading the signed cookie if headers are absent
    else if (req.signedCookies && req.signedCookies['sb-access-token']) {
      token = req.signedCookies['sb-access-token'];
    }

    if (!token) {
      return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    const { data: { user }, error } = await supabaseAuth.auth.getUser(token);
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
    return res.status(401).json({ message: 'Unauthorized.' });
  }
};

/**
 * requireRole(['admin']) or requireRole(['admin','moderator'])
 * Must be placed AFTER verifySession in the middleware chain.
 */
const requireRole = (roles = []) => (req, res, next) => {
  if (!req.userRole || !roles.includes(req.userRole)) {
    return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
  }
  next();
};

/**
 * optionalSession
 * Populates req.user if an authentication vector is passed, but does not block if absent.
 */
const optionalSession = async (req, res, next) => {
  try {
    let token = null;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.signedCookies && req.signedCookies['sb-access-token']) {
      token = req.signedCookies['sb-access-token'];
    }

    if (token) {
      const { data: { user } } = await supabaseAuth.auth.getUser(token);
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
    next();
  } catch (err) {
    next(); 
  }
};

module.exports = { verifySession, requireRole, optionalSession };