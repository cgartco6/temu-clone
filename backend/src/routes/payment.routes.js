const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');
const { auth, authorize } = require('../middleware/auth');

// Public routes
router.post('/webhook/stripe', paymentController.handleStripeWebhook);

// Protected routes
router.post('/create-intent', auth, paymentController.createPaymentIntent);
router.post('/refund', auth, authorize('admin'), paymentController.processRefund);
router.get('/methods', auth, paymentController.getPaymentMethods);
router.post('/methods', auth, paymentController.savePaymentMethod);

// Admin routes
router.post('/manual-refund', auth, authorize('admin'), paymentController.processRefund);

module.exports = router;
