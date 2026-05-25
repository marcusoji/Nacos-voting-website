const express  = require('express');
const router   = express.Router();
const vc       = require('../controllers/votingController');
const { optionalSession } = require('../middleware/auth');
const { paymentLimiter }  = require('../middleware/rateLimiter');

router.get('/categories',         vc.getCategories);
router.get('/categories/:slug',   vc.getCategoryBySlug);
router.get('/leaderboard',        vc.getLeaderboard);

// SINGLE PAYMENT
router.post('/initialize',        optionalSession, paymentLimiter, vc.initializePayment);
router.get('/verify/:reference',  optionalSession, vc.verifyPaymentEndpoint);

// BATCH PAYMENT
router.post('/initialize-batch', optionalSession, paymentLimiter, vc.initializeBatchPayment);
router.get('/verify-batch/:batchReference', optionalSession, vc.verifyBatchPayment);

// WEBHOOK
router.post('/webhook', vc.handleWebhook);

module.exports = router;