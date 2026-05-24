const express  = require('express');
const router   = express.Router();
const vc       = require('../controllers/votingController');
const { optionalSession } = require('../middleware/auth');
const { paymentLimiter }  = require('../middleware/rateLimiter');

router.get('/categories',         vc.getCategories);
router.get('/categories/:slug',   vc.getCategoryBySlug);
router.get('/leaderboard',        vc.getLeaderboard);

router.post('/initialize',        optionalSession, paymentLimiter, vc.initializePayment);
router.get('/verify/:reference',  optionalSession, vc.verifyPaymentEndpoint);
router.post('/webhook',                            vc.handleWebhook);

module.exports = router;