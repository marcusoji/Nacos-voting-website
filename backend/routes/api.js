// backend/routes/api.js
// Legacy combined router — kept for backward compatibility.
// The primary routing is in authRoutes, votingRoutes, adminRoutes.
// All routes here mirror the new split routers.

const express = require('express');
const router = express.Router();
const auth = require('../controllers/authController');
const vote = require('../controllers/votingController');
const admin = require('../controllers/adminController');
// Correct middleware names from auth.js
const { verifySession, requireRole, optionalSession } = require('../middleware/auth');
const { authLimiter, paymentLimiter } = require('../middleware/rateLimiter');

// ── Auth Routes ──────────────────────────────────────────────
router.post('/auth/register', authLimiter, auth.register);
router.post('/auth/login',    authLimiter, auth.login);
router.post('/auth/logout',   auth.logout);
router.post('/auth/forgot-password', authLimiter, auth.requestPasswordReset); // fixed: was auth.forgotPassword
router.post('/auth/reset-password',  authLimiter, auth.resetPassword);
router.get('/auth/me', verifySession, auth.getMe);

// ── Voting / Public Routes ────────────────────────────────────
router.get('/categories',       vote.getCategories);
router.get('/categories/:slug', vote.getCategoryBySlug);
router.get('/leaderboard',      vote.getLeaderboard);

// ── Payment Routes ────────────────────────────────────────────
router.post('/voting/initialize', optionalSession, paymentLimiter, vote.initializePayment);
router.get('/voting/verify/:reference', optionalSession, vote.verifyPaymentEndpoint); // fixed: was vote.verifyPayment
router.post('/voting/webhook', vote.handleWebhook);

// ── Moderator + Admin Routes ──────────────────────────────────
const isMod  = [verifySession, requireRole(['admin', 'moderator'])];
const isAdmin = [verifySession, requireRole(['admin'])];

router.get('/admin/contestants',       ...isMod,  admin.getAllContestants);
router.post('/admin/contestants',      ...isMod,  admin.createContestant);
router.put('/admin/contestants/:id',   ...isMod,  admin.updateContestant);
router.delete('/admin/contestants/:id',...isAdmin, admin.deleteContestant);

router.get('/admin/users',             ...isMod,  admin.getUsers);
router.delete('/admin/users/:id',      ...isAdmin, admin.deleteUser);
router.patch('/admin/users/:id/role',  ...isAdmin, admin.updateUserRole);

router.post('/admin/categories',       ...isAdmin, admin.createCategory);
router.delete('/admin/categories/:id', ...isAdmin, admin.deleteCategory);

router.get('/admin/analytics',         ...isAdmin, admin.getSystemAnalytics);
router.get('/admin/transactions',      ...isAdmin, admin.getTransactions);

module.exports = router;