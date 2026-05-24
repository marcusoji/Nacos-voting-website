const express  = require('express');
const router   = express.Router();
const auth     = require('../controllers/authController');
const { verifySession }  = require('../middleware/auth');
const { authLimiter }    = require('../middleware/rateLimiter');

router.post('/register',        authLimiter, auth.register);
router.post('/login',           authLimiter, auth.login);
router.post('/logout',                       auth.logout);
router.post('/forgot-password', authLimiter, auth.requestPasswordReset);
router.post('/reset-password',  authLimiter, auth.resetPassword);
router.get('/me',               verifySession, auth.getMe);

module.exports = router;