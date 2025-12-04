const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Order = require('../models/Order');
const User = require('../models/User');

class PaymentController {
  // Create Stripe payment intent
  async createPaymentIntent(req, res) {
    try {
      const { orderId, paymentMethod, saveCard } = req.body;
      const userId = req.user.userId;

      // Get order
      const order = await Order.findOne({ orderId, user: userId });
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Check if payment already processed
      if (order.payment.status === 'completed') {
        return res.status(400).json({ error: 'Payment already completed' });
      }

      // Create Stripe customer if doesn't exist
      let customer;
      const user = await User.findById(userId);
      
      if (user.stripeCustomerId) {
        customer = await stripe.customers.retrieve(user.stripeCustomerId);
      } else {
        customer = await stripe.customers.create({
          email: user.email,
          name: user.fullName,
          metadata: {
            userId: userId.toString()
          }
        });
        user.stripeCustomerId = customer.id;
        await user.save();
      }

      // Create payment intent
      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(order.totals.grandTotal * 100), // Convert to cents
        currency: order.currency.toLowerCase(),
        customer: customer.id,
        payment_method_types: ['card'],
        metadata: {
          orderId: order.orderId,
          userId: userId.toString()
        },
        description: `Payment for order ${order.orderId}`,
        shipping: order.shippingAddress ? {
          address: {
            line1: order.shippingAddress.street,
            city: order.shippingAddress.city,
            state: order.shippingAddress.state,
            postal_code: order.shippingAddress.postalCode,
            country: order.shippingAddress.country
          },
          name: order.shippingAddress.fullName,
          phone: order.shippingAddress.phone
        } : undefined
      });

      // Update order with payment intent
      order.payment.transactionId = paymentIntent.id;
      order.payment.gateway = 'stripe';
      await order.save();

      res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        amount: paymentIntent.amount / 100,
        currency: paymentIntent.currency
      });
    } catch (error) {
      console.error('Payment intent error:', error);
      res.status(500).json({ error: 'Failed to create payment intent' });
    }
  }

  // Handle Stripe webhook
  async handleStripeWebhook(req, res) {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle the event
    switch (event.type) {
      case 'payment_intent.succeeded':
        await this.handlePaymentSuccess(event.data.object);
        break;
      case 'payment_intent.payment_failed':
        await this.handlePaymentFailure(event.data.object);
        break;
      case 'charge.refunded':
        await this.handleRefund(event.data.object);
        break;
      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.json({ received: true });
  }

  async handlePaymentSuccess(paymentIntent) {
    try {
      const order = await Order.findOne({ 
        'payment.transactionId': paymentIntent.id 
      });

      if (order) {
        order.payment.status = 'completed';
        order.payment.paidAt = new Date();
        order.status = 'confirmed';
        await order.save();

        // Trigger order confirmation email
        await this.sendOrderConfirmation(order);
        
        // Update product stock
        await this.updateProductStock(order.items);
        
        // Add loyalty points
        await this.addLoyaltyPoints(order.user, order.totals.grandTotal);
      }
    } catch (error) {
      console.error('Error handling payment success:', error);
    }
  }

  async handlePaymentFailure(paymentIntent) {
    try {
      const order = await Order.findOne({ 
        'payment.transactionId': paymentIntent.id 
      });

      if (order) {
        order.payment.status = 'failed';
        await order.save();
        
        // Send payment failure notification
        await this.sendPaymentFailureNotification(order);
      }
    } catch (error) {
      console.error('Error handling payment failure:', error);
    }
  }

  // Add loyalty points
  async addLoyaltyPoints(userId, amount) {
    try {
      const points = Math.floor(amount); // 1 point per dollar spent
      const user = await User.findById(userId);
      
      user.loyalty.points += points;
      user.loyalty.history.push({
        points,
        reason: `Purchase - $${amount}`,
        date: new Date()
      });

      // Update tier based on points
      if (user.loyalty.points >= 10000) {
        user.loyalty.tier = 'platinum';
      } else if (user.loyalty.points >= 5000) {
        user.loyalty.tier = 'gold';
      } else if (user.loyalty.points >= 1000) {
        user.loyalty.tier = 'silver';
      }

      await user.save();
    } catch (error) {
      console.error('Error adding loyalty points:', error);
    }
  }

  // Process refund
  async processRefund(req, res) {
    try {
      const { orderId, amount, reason } = req.body;
      const adminId = req.user.userId;

      const order = await Order.findOne({ orderId });
      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      if (order.payment.status !== 'completed') {
        return res.status(400).json({ error: 'Payment not completed' });
      }

      // Create Stripe refund
      const refund = await stripe.refunds.create({
        payment_intent: order.payment.transactionId,
        amount: Math.round((amount || order.totals.grandTotal) * 100),
        reason: reason || 'requested_by_customer'
      });

      // Update order status
      order.payment.status = 'refunded';
      order.status = 'refunded';
      await order.save();

      // Update user wallet if using wallet system
      if (order.payment.method === 'wallet') {
        const user = await User.findById(order.user);
        user.wallet.balance += amount || order.totals.grandTotal;
        user.wallet.transactions.push({
          type: 'refund',
          amount: amount || order.totals.grandTotal,
          description: `Refund for order ${orderId}`,
          reference: refund.id
        });
        await user.save();
      }

      res.json({
        success: true,
        refundId: refund.id,
        amount: refund.amount / 100,
        status: refund.status
      });
    } catch (error) {
      console.error('Refund error:', error);
      res.status(500).json({ error: 'Failed to process refund' });
    }
  }

  // Get payment methods
  async getPaymentMethods(req, res) {
    try {
      const userId = req.user.userId;
      const user = await User.findById(userId);

      if (!user.stripeCustomerId) {
        return res.json({ methods: [] });
      }

      const paymentMethods = await stripe.paymentMethods.list({
        customer: user.stripeCustomerId,
        type: 'card'
      });

      res.json({
        methods: paymentMethods.data.map(method => ({
          id: method.id,
          brand: method.card.brand,
          last4: method.card.last4,
          expMonth: method.card.exp_month,
          expYear: method.card.exp_year,
          isDefault: method.id === user.defaultPaymentMethod
        }))
      });
    } catch (error) {
      console.error('Get payment methods error:', error);
      res.status(500).json({ error: 'Failed to get payment methods' });
    }
  }

  // Save payment method
  async savePaymentMethod(req, res) {
    try {
      const { paymentMethodId, setAsDefault } = req.body;
      const userId = req.user.userId;

      const user = await User.findById(userId);
      if (!user.stripeCustomerId) {
        return res.status(400).json({ error: 'No Stripe customer found' });
      }

      // Attach payment method to customer
      await stripe.paymentMethods.attach(paymentMethodId, {
        customer: user.stripeCustomerId
      });

      if (setAsDefault) {
        await stripe.customers.update(user.stripeCustomerId, {
          invoice_settings: {
            default_payment_method: paymentMethodId
          }
        });
        user.defaultPaymentMethod = paymentMethodId;
        await user.save();
      }

      res.json({ success: true, message: 'Payment method saved successfully' });
    } catch (error) {
      console.error('Save payment method error:', error);
      res.status(500).json({ error: 'Failed to save payment method' });
    }
  }
}

module.exports = new PaymentController();
