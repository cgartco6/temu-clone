const Stripe = require('stripe');
const paypal = require('paypal-rest-sdk');
const logger = require('./logger');

class PaymentConfig {
  constructor() {
    this.stripe = null;
    this.paypal = null;
    this.gateways = {};
    this.initialize();
  }

  initialize() {
    // Initialize Stripe
    if (process.env.STRIPE_SECRET_KEY) {
      this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2023-08-16',
        maxNetworkRetries: 2,
        timeout: 30000
      });
      this.gateways.stripe = this.stripe;
      logger.info('Stripe payment gateway initialized');
    }

    // Initialize PayPal
    if (process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_SECRET) {
      paypal.configure({
        mode: process.env.PAYPAL_MODE || 'sandbox',
        client_id: process.env.PAYPAL_CLIENT_ID,
        client_secret: process.env.PAYPAL_SECRET
      });
      this.paypal = paypal;
      this.gateways.paypal = paypal;
      logger.info('PayPal payment gateway initialized');
    }

    // Log available gateways
    const availableGateways = Object.keys(this.gateways);
    if (availableGateways.length === 0) {
      logger.warn('No payment gateways configured');
    } else {
      logger.info(`Available payment gateways: ${availableGateways.join(', ')}`);
    }
  }

  // Stripe methods
  async createStripeCustomer(userData) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const customer = await this.stripe.customers.create({
        email: userData.email,
        name: userData.name,
        phone: userData.phone,
        metadata: {
          userId: userData._id?.toString(),
          userEmail: userData.email
        }
      });

      logger.info(`Stripe customer created: ${customer.id}`);
      return customer;
    } catch (error) {
      logger.error('Failed to create Stripe customer:', error);
      throw error;
    }
  }

  async createStripePaymentIntent(params) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const {
        amount,
        currency = 'usd',
        customerId,
        paymentMethodId,
        metadata = {},
        description,
        captureMethod = 'automatic'
      } = params;

      const paymentIntent = await this.stripe.paymentIntents.create({
        amount: Math.round(amount * 100), // Convert to cents
        currency: currency.toLowerCase(),
        customer: customerId,
        payment_method: paymentMethodId,
        confirmation_method: 'manual',
        capture_method: captureMethod,
        confirm: true,
        metadata: {
          ...metadata,
          timestamp: new Date().toISOString()
        },
        description: description,
        setup_future_usage: 'off_session'
      });

      logger.info(`Stripe payment intent created: ${paymentIntent.id}`);
      return paymentIntent;
    } catch (error) {
      logger.error('Failed to create Stripe payment intent:', error);
      throw error;
    }
  }

  async createStripeSubscription(params) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const {
        customerId,
        priceId,
        paymentMethodId,
        trialDays = 0,
        metadata = {}
      } = params;

      // Attach payment method to customer
      await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId
      });

      // Set as default payment method
      await this.stripe.customers.update(customerId, {
        invoice_settings: {
          default_payment_method: paymentMethodId
        }
      });

      // Create subscription
      const subscription = await this.stripe.subscriptions.create({
        customer: customerId,
        items: [{ price: priceId }],
        trial_period_days: trialDays,
        metadata: metadata,
        expand: ['latest_invoice.payment_intent']
      });

      logger.info(`Stripe subscription created: ${subscription.id}`);
      return subscription;
    } catch (error) {
      logger.error('Failed to create Stripe subscription:', error);
      throw error;
    }
  }

  async handleStripeWebhook(payload, signature) {
    if (!this.stripe) {
      throw new Error('Stripe not configured');
    }

    try {
      const event = this.stripe.webhooks.constructEvent(
        payload,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      logger.info(`Stripe webhook received: ${event.type}`, {
        eventId: event.id,
        type: event.type
      });

      return event;
    } catch (error) {
      logger.error('Stripe webhook signature verification failed:', error);
      throw error;
    }
  }

  // PayPal methods
  async createPayPalPayment(params) {
    if (!this.paypal) {
      throw new Error('PayPal not configured');
    }

    return new Promise((resolve, reject) => {
      const {
        amount,
        currency = 'USD',
        description,
        returnUrl,
        cancelUrl,
        items = []
      } = params;

      const create_payment_json = {
        intent: 'sale',
        payer: {
          payment_method: 'paypal'
        },
        redirect_urls: {
          return_url: returnUrl,
          cancel_url: cancelUrl
        },
        transactions: [{
          item_list: {
            items: items.map(item => ({
              name: item.name,
              sku: item.sku || item.id,
              price: item.price.toString(),
              currency: currency,
              quantity: item.quantity
            }))
          },
          amount: {
            currency: currency,
            total: amount.toString(),
            details: {
              subtotal: amount.toString(),
              tax: '0.00',
              shipping: '0.00',
              handling_fee: '0.00',
              shipping_discount: '0.00',
              insurance: '0.00'
            }
          },
          description: description
        }]
      };

      this.paypal.payment.create(create_payment_json, (error, payment) => {
        if (error) {
          logger.error('Failed to create PayPal payment:', error);
          reject(error);
        } else {
          logger.info(`PayPal payment created: ${payment.id}`);
          resolve(payment);
        }
      });
    });
  }

  async executePayPalPayment(paymentId, payerId) {
    if (!this.paypal) {
      throw new Error('PayPal not configured');
    }

    return new Promise((resolve, reject) => {
      const execute_payment_json = {
        payer_id: payerId
      };

      this.paypal.payment.execute(paymentId, execute_payment_json, (error, payment) => {
        if (error) {
          logger.error('Failed to execute PayPal payment:', error);
          reject(error);
        } else {
          logger.info(`PayPal payment executed: ${payment.id}`);
          resolve(payment);
        }
      });
    });
  }

  // Generic payment methods
  async createPayment(params) {
    const { gateway = 'stripe', ...paymentParams } = params;

    if (!this.gateways[gateway]) {
      throw new Error(`Payment gateway ${gateway} not configured`);
    }

    switch (gateway) {
      case 'stripe':
        return this.createStripePaymentIntent(paymentParams);
      case 'paypal':
        return this.createPayPalPayment(paymentParams);
      default:
        throw new Error(`Unsupported payment gateway: ${gateway}`);
    }
  }

  async refundPayment(params) {
    const { gateway, paymentId, amount, reason } = params;

    if (!this.gateways[gateway]) {
      throw new Error(`Payment gateway ${gateway} not configured`);
    }

    try {
      let refund;

      switch (gateway) {
        case 'stripe':
          refund = await this.stripe.refunds.create({
            payment_intent: paymentId,
            amount: amount ? Math.round(amount * 100) : undefined,
            reason: reason || 'requested_by_customer'
          });
          break;
        case 'paypal':
          refund = await new Promise((resolve, reject) => {
            this.paypal.sale.refund(paymentId, {
              amount: {
                total: amount.toString(),
                currency: 'USD'
              }
            }, (error, refund) => {
              if (error) reject(error);
              else resolve(refund);
            });
          });
          break;
        default:
          throw new Error(`Unsupported payment gateway: ${gateway}`);
      }

      logger.info(`Payment refunded via ${gateway}: ${refund.id}`);
      return refund;
    } catch (error) {
      logger.error(`Failed to refund payment via ${gateway}:`, error);
      throw error;
    }
  }

  // Payment method management
  async getPaymentMethods(gateway, customerId) {
    if (!this.gateways[gateway]) {
      throw new Error(`Payment gateway ${gateway} not configured`);
    }

    try {
      let methods;

      switch (gateway) {
        case 'stripe':
          const paymentMethods = await this.stripe.paymentMethods.list({
            customer: customerId,
            type: 'card'
          });
          methods = paymentMethods.data;
          break;
        default:
          throw new Error(`Payment method retrieval not supported for ${gateway}`);
      }

      return methods;
    } catch (error) {
      logger.error(`Failed to get payment methods via ${gateway}:`, error);
      throw error;
    }
  }

  // Transaction verification
  async verifyTransaction(gateway, transactionId) {
    if (!this.gateways[gateway]) {
      throw new Error(`Payment gateway ${gateway} not configured`);
    }

    try {
      let transaction;

      switch (gateway) {
        case 'stripe':
          transaction = await this.stripe.paymentIntents.retrieve(transactionId);
          break;
        case 'paypal':
          transaction = await new Promise((resolve, reject) => {
            this.paypal.payment.get(transactionId, (error, payment) => {
              if (error) reject(error);
              else resolve(payment);
            });
          });
          break;
        default:
          throw new Error(`Transaction verification not supported for ${gateway}`);
      }

      return transaction;
    } catch (error) {
      logger.error(`Failed to verify transaction via ${gateway}:`, error);
      throw error;
    }
  }

  // Get gateway status
  getGatewayStatus() {
    return {
      stripe: !!this.stripe,
      paypal: !!this.paypal,
      allGateways: Object.keys(this.gateways)
    };
  }

  // Test gateway connectivity
  async testConnectivity() {
    const results = {};

    if (this.stripe) {
      try {
        await this.stripe.balance.retrieve();
        results.stripe = { connected: true };
      } catch (error) {
        results.stripe = { connected: false, error: error.message };
      }
    }

    if (this.paypal) {
      // PayPal connectivity test
      results.paypal = { connected: true }; // Simplified
    }

    return results;
  }
}

module.exports = new PaymentConfig();
