// middleware/auth.js
// Uses Bearer token from Authorization header ONLY.
// No cookies — eliminates all sameSite/cross-origin cookie issues on Vercel.
const { supabase } = require('../config/db');

const extractToken = (req) => {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
};

const verifySession = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }

    const { data: profile } = await supabase
      .from('profiles').select('role').eq('id', user.id).single();

    req.user     = user;
    req.userRole = profile?.role || 'user';
    next();
  } catch (err) {
    console.error('[verifySession]', err.message);
    return res.status(401).json({ message: 'Unauthorized.' });
  }
};

const requireRole = (roles = []) => (req, res, next) => {
  if (!req.userRole || !roles.includes(req.userRole)) {
    return res.status(403).json({ message: 'Access denied. Insufficient permissions.' });
  }
  next();
};

const optionalSession = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const { data: { user } } = await supabase.auth.getUser(token);
      if (user) {
        const { data: profile } = await supabase
          .from('profiles').select('role').eq('id', user.id).single();
        req.user     = user;
        req.userRole = profile?.role || 'user';
      }
    }
  } catch { /* silent */ }
  next();
};

module.exports = { verifySession, requireRole, optionalSession };
