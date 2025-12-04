const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Cart = require('../models/Cart');
const axios = require('axios');

class OrderController {
  // Create new order
  async createOrder(req, res) {
    try {
      const userId = req.user.userId;
      const {
        items,
        shippingAddress,
        billingAddress,
        shippingMethod,
        paymentMethod,
        couponCode,
        notes
      } = req.body;

      // Validate items and calculate totals
      const orderItems = [];
      let subtotal = 0;
      let totalItems = 0;

      for (const item of items) {
        const product = await Product.findById(item.productId);
        if (!product) {
          return res.status(404).json({ 
            error: `Product ${item.productId} not found` 
          });
        }

        // Check variant availability
        let variant = null;
        if (item.variantSku) {
          variant = product.variants.find(v => v.sku === item.variantSku);
          if (!variant) {
            return res.status(400).json({ 
              error: `Variant ${item.variantSku} not found` 
            });
          }
          if (variant.stock < item.quantity) {
            return res.status(400).json({ 
              error: `Insufficient stock for variant ${item.variantSku}` 
            });
          }
        } else {
          if (product.totalStock < item.quantity) {
            return res.status(400).json({ 
              error: `Insufficient stock for product ${product.name}` 
            });
          }
        }

        // Calculate price
        const basePrice = variant ? 
          (product.price.original + (variant.priceAdjustment || 0)) : 
          product.price.original;
        
        const discount = product.discount?.percentage ? 
          basePrice * (product.discount.percentage / 100) : 
          (product.discount?.amount || 0);
        
        const finalPrice = Math.max(0, basePrice - discount);
        const itemSubtotal = finalPrice * item.quantity;

        orderItems.push({
          product: product._id,
          variant: variant ? {
            sku: variant.sku,
            color: variant.attributes.color,
            size: variant.attributes.size
          } : null,
          quantity: item.quantity,
          price: finalPrice,
          subtotal: itemSubtotal
        });

        subtotal += itemSubtotal;
        totalItems += item.quantity;
      }

      // Calculate shipping cost
      const shippingCost = await this.calculateShipping(
        shippingAddress,
        shippingMethod,
        totalItems
      );

      // Calculate tax
      const tax = await this.calculateTax(
        shippingAddress,
        subtotal,
        orderItems
      );

      // Apply coupon if provided
      let discount = 0;
      if (couponCode) {
        discount = await this.applyCoupon(couponCode, userId, subtotal);
      }

      // Calculate grand total
      const grandTotal = subtotal + shippingCost + tax - discount;

      // Create order
      const order = new Order({
        user: userId,
        items: orderItems,
        shippingAddress,
        billingAddress: billingAddress || shippingAddress,
        shipping: {
          method: shippingMethod,
          cost: shippingCost,
          estimatedDelivery: await this.getDeliveryEstimate(shippingAddress)
        },
        payment: {
          method: paymentMethod,
          amount: {
            subtotal,
            shipping: shippingCost,
            tax,
            discount,
            total: grandTotal
          }
        },
        notes,
        metadata: {
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          device: this.detectDevice(req.headers['user-agent']),
          referrer: req.headers.referer
        },
        totals: {
          items: subtotal,
          shipping: shippingCost,
          tax,
          discount,
          grandTotal
        },
        currency: 'USD'
      });

      // Reserve stock
      await this.reserveStock(orderItems);

      // Save order
      await order.save();

      // Clear user's cart
      await Cart.findOneAndDelete({ user: userId });

      // Send order confirmation email
      await this.sendOrderConfirmation(order, req.user.email);

      res.status(201).json({
        success: true,
        orderId: order.orderId,
        total: grandTotal,
        paymentRequired: paymentMethod !== 'cod'
      });
    } catch (error) {
      console.error('Create order error:', error);
      res.status(500).json({ error: 'Failed to create order' });
    }
  }

  // Get user orders
  async getUserOrders(req, res) {
    try {
      const userId = req.user.userId;
      const { page = 1, limit = 10, status } = req.query;

      const query = { user: userId };
      if (status) {
        query.status = status;
      }

      const orders = await Order.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('items.product', 'name images price');

      const total = await Order.countDocuments(query);

      res.json({
        orders,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      });
    } catch (error) {
      console.error('Get orders error:', error);
      res.status(500).json({ error: 'Failed to get orders' });
    }
  }

  // Get order details
  async getOrderDetails(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user.userId;

      const order = await Order.findOne({ 
        orderId, 
        user: userId 
      })
      .populate('items.product')
      .populate('user', 'email profile');

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      res.json(order);
    } catch (error) {
      console.error('Get order details error:', error);
      res.status(500).json({ error: 'Failed to get order details' });
    }
  }

  // Cancel order
  async cancelOrder(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user.userId;

      const order = await Order.findOne({ 
        orderId, 
        user: userId 
      });

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Check if order can be cancelled
      if (!['pending', 'confirmed'].includes(order.status)) {
        return res.status(400).json({ 
          error: 'Order cannot be cancelled at this stage' 
        });
      }

      // Update order status
      order.status = 'cancelled';
      order.payment.status = 'cancelled';
      await order.save();

      // Restock items
      await this.restockItems(order.items);

      // Process refund if payment was made
      if (order.payment.status === 'completed') {
        await this.processRefund(order);
      }

      res.json({ 
        success: true, 
        message: 'Order cancelled successfully' 
      });
    } catch (error) {
      console.error('Cancel order error:', error);
      res.status(500).json({ error: 'Failed to cancel order' });
    }
  }

  // Track order
  async trackOrder(req, res) {
    try {
      const { orderId } = req.params;
      const userId = req.user.userId;

      const order = await Order.findOne({ 
        orderId, 
        user: userId 
      }).select('shipping status');

      if (!order) {
        return res.status(404).json({ error: 'Order not found' });
      }

      // Get tracking info from shipping provider
      let trackingInfo = null;
      if (order.shipping.tracking?.number) {
        trackingInfo = await this.getTrackingInfo(
          order.shipping.tracking.carrier,
          order.shipping.tracking.number
        );
      }

      res.json({
        orderId,
        status: order.status,
        shipping: order.shipping,
        tracking: trackingInfo,
        estimatedDelivery: order.shipping.estimatedDelivery
      });
    } catch (error) {
      console.error('Track order error:', error);
      res.status(500).json({ error: 'Failed to track order' });
    }
  }

  // Helper methods
  async calculateShipping(address, method, itemCount) {
    // Implement your shipping logic here
    // This could integrate with shipping APIs like Shippo, EasyPost, etc.
    
    const baseRates = {
      standard: 5.99,
      express: 12.99,
      overnight: 24.99
    };

    // Simple calculation for demo
    let cost = baseRates[method] || baseRates.standard;
    
    // Additional cost for international shipping
    if (address.country !== 'US') {
      cost += 15.99;
    }

    // Add per-item cost
    cost += (itemCount - 1) * 1.50;

    return Math.round(cost * 100) / 100;
  }

  async calculateTax(address, subtotal, items) {
    // Implement tax calculation based on address
    // This could use tax APIs like TaxJar, Avalara
    
    // Simple tax calculation for demo
    const taxRates = {
      'US': 0.08, // 8% average sales tax
      'CA': 0.13, // 13% HST in Ontario
      'EU': 0.21, // 21% VAT
      'UK': 0.20  // 20% VAT
    };

    const rate = taxRates[address.country] || 0;
    return Math.round(subtotal * rate * 100) / 100;
  }

  async applyCoupon(code, userId, subtotal) {
    // Implement coupon validation and application
    // Check database for valid coupons
    
    // Demo logic
    const coupons = {
      'WELCOME10': { type: 'percentage', value: 10, minPurchase: 0 },
      'SAVE20': { type: 'fixed', value: 20, minPurchase: 100 },
      'FREESHIP': { type: 'shipping', value: 100 }
    };

    const coupon = coupons[code];
    if (!coupon) {
      return 0;
    }

    if (subtotal < coupon.minPurchase) {
      return 0;
    }

    if (coupon.type === 'percentage') {
      return Math.round(subtotal * (coupon.value / 100) * 100) / 100;
    } else if (coupon.type === 'fixed') {
      return Math.min(coupon.value, subtotal);
    }

    return 0;
  }

  async reserveStock(items) {
    for (const item of items) {
      if (item.variant?.sku) {
        await Product.findOneAndUpdate(
          { 
            _id: item.product,
            'variants.sku': item.variant.sku 
          },
          { 
            $inc: { 'variants.$.stock': -item.quantity } 
          }
        );
      } else {
        await Product.findByIdAndUpdate(
          item.product,
          { 
            $inc: { 
              'metadata.stock': -item.quantity,
              'metadata.reserved': item.quantity 
            } 
          }
        );
      }
    }
  }

  async restockItems(items) {
    for (const item of items) {
      if (item.variant?.sku) {
        await Product.findOneAndUpdate(
          { 
            _id: item.product,
            'variants.sku': item.variant.sku 
          },
          { 
            $inc: { 'variants.$.stock': item.quantity } 
          }
        );
      } else {
        await Product.findByIdAndUpdate(
          item.product,
          { 
            $inc: { 
              'metadata.stock': item.quantity,
              'metadata.reserved': -item.quantity 
            } 
          }
        );
      }
    }
  }

  async sendOrderConfirmation(order, email) {
    // Implement email sending logic
    // Use nodemailer, SendGrid, etc.
    console.log(`Order confirmation sent to ${email} for order ${order.orderId}`);
  }

  detectDevice(userAgent) {
    const ua = userAgent.toLowerCase();
    if (ua.includes('mobile')) return 'mobile';
    if (ua.includes('tablet')) return 'tablet';
    return 'desktop';
  }
}

module.exports = new OrderController();
