const express = require('express');
const router  = express.Router();
const admin   = require('../controllers/adminController');
const { verifySession, requireRole } = require('../middleware/auth');

const isAdmin = [verifySession, requireRole(['admin'])];
const isMod   = [verifySession, requireRole(['admin', 'moderator'])];

// Image upload (multipart — no JSON content-type middleware)
router.post('/upload-image', ...isMod, admin.uploadImage);

// Analytics
router.get('/analytics', ...isAdmin, admin.getSystemAnalytics);

// Users
router.get('/users',             ...isMod,   admin.getUsers);
router.delete('/users/:id',      ...isAdmin, admin.deleteUser);
router.patch('/users/:id/role',  ...isAdmin, admin.updateUserRole);

// Categories
router.post('/categories',        ...isAdmin, admin.createCategory);
router.delete('/categories/:id',  ...isAdmin, admin.deleteCategory);

// Contestants
router.get('/contestants',        ...isMod,   admin.getAllContestants);
router.post('/contestants',       ...isMod,   admin.createContestant);
router.put('/contestants/:id',    ...isMod,   admin.updateContestant);
router.delete('/contestants/:id', ...isAdmin, admin.deleteContestant);

// Transactions
router.get('/transactions', ...isAdmin, admin.getTransactions);
router.post('/transactions/:ref/force-approve', ...isAdmin, admin.forceApproveTransaction);

module.exports = router;