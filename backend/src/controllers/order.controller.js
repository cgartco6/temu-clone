const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const Cart = require('../models/Cart');
const Coupon = require('../models/Coupon');
const logger = require('../config/logger');
const emailService = require('../config/email');
const paymentService = require('../config/payment');
const shippingService = require('../services/shipping.service');
const redis = require('../config/redis');
const mongoose = require('mongoose');

class OrderController {
  // Create new order
  async createOrder(req, res) {
    try {
      const userId = req.user._id;
      const {
        items,
        shippingAddress,
        billingAddress,
        shippingMethod,
        paymentMethod,
        couponCode,
        customerNotes,
        giftMessage,
        giftWrap
      } = req.body;

      // Validate required fields
      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Order must contain at least one item'
        });
      }

      if (!shippingAddress) {
        return res.status(400).json({
          success: false,
          error: 'Shipping address is required'
        });
      }

      if (!shippingMethod) {
        return res.status(400).json({
          success: false,
          error: 'Shipping method is required'
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          success: false,
          error: 'Payment method is required'
        });
      }

      // Get user
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Validate and process items
      const orderItems = [];
      let subtotal = 0;
      let totalWeight = 0;
      let totalItems = 0;
      const productUpdates = [];

      for (const item of items) {
        const product = await Product.findById(item.productId);
        if (!product) {
          return res.status(404).json({
            success: false,
            error: `Product ${item.productId} not found`
          });
        }

        // Check variant if specified
        let variant = null;
        if (item.variantSku) {
          variant = product.variants.find(v => v.sku === item.variantSku);
          if (!variant) {
            return res.status(400).json({
              success: false,
              error: `Variant ${item.variantSku} not found`
            });
          }
        }

        // Check availability
        const availableStock = variant ? 
          variant.inventory.quantity - variant.inventory.reserved :
          product.inventory.quantity - product.inventory.reserved;
        
        if (availableStock < item.quantity) {
          if (!product.inventory.allowBackorders) {
            return res.status(400).json({
              success: false,
              error: `Insufficient stock for ${product.name}. Available: ${availableStock}, Requested: ${item.quantity}`
            });
          }
        }

        // Calculate price
        const basePrice = variant ? 
          (product.price.base + (variant.priceAdjustment || 0)) : 
          product.price.base;
        
        // Apply sale price if active
        let finalPrice = basePrice;
        if (product.price.sale && 
            product.price.sale.startDate <= new Date() && 
            (!product.price.sale.endDate || product.price.sale.endDate >= new Date())) {
          
          if (product.price.sale.type === 'percentage') {
            finalPrice = basePrice * (1 - product.price.sale.amount / 100);
          } else if (product.price.sale.type === 'fixed') {
            finalPrice = Math.max(0, basePrice - product.price.sale.amount);
          }
        }

        // Calculate tax
        const taxRate = product.tax.rate || 0;
        const taxAmount = finalPrice * (taxRate / 100) * item.quantity;

        // Calculate item total
        const itemTotal = finalPrice * item.quantity;
        subtotal += itemTotal;

        // Add to order items
        orderItems.push({
          product: product._id,
          variantSku: item.variantSku,
          name: product.name,
          quantity: item.quantity,
          price: finalPrice,
          originalPrice: basePrice,
          discount: {
            amount: (basePrice - finalPrice) * item.quantity,
            type: product.price.sale ? product.price.sale.type : 'none'
          },
          tax: {
            rate: taxRate,
            amount: taxAmount
          },
          total: itemTotal + taxAmount,
          image: product.images.find(img => img.isPrimary)?.url || product.images[0]?.url,
          weight: product.shipping.weight,
          dimensions: product.shipping.dimensions,
          digitalContent: product.digital
        });

        // Track total weight and items
        totalWeight += (product.shipping.weight?.value || 0) * item.quantity;
        totalItems += item.quantity;

        // Reserve inventory
        productUpdates.push({
          productId: product._id,
          variantSku: item.variantSku,
          quantity: item.quantity
        });
      }

      // Apply coupon if provided
      let couponDiscount = 0;
      let coupon = null;
      if (couponCode) {
        coupon = await Coupon.findOne({
          code: couponCode.toUpperCase(),
          isActive: true,
          startDate: { $lte: new Date() },
          $or: [
            { endDate: { $exists: false } },
            { endDate: null },
            { endDate: { $gte: new Date() } }
          ]
        });

        if (coupon) {
          // Check usage limits
          if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
            return res.status(400).json({
              success: false,
              error: 'Coupon usage limit exceeded'
            });
          }

          if (coupon.userUsageLimit) {
            const userUsageCount = await Order.countDocuments({
              user: userId,
              'discounts.code': couponCode.toUpperCase()
            });
            
            if (userUsageCount >= coupon.userUsageLimit) {
              return res.status(400).json({
                success: false,
                error: 'You have exceeded the usage limit for this coupon'
              });
            }
          }

          // Check minimum purchase
          if (coupon.minimumPurchase && subtotal < coupon.minimumPurchase) {
            return res.status(400).json({
              success: false,
              error: `Minimum purchase of $${coupon.minimumPurchase} required for this coupon`
            });
          }

          // Calculate discount
          if (coupon.discountType === 'percentage') {
            couponDiscount = subtotal * (coupon.discountValue / 100);
            if (coupon.maxDiscountAmount) {
              couponDiscount = Math.min(couponDiscount, coupon.maxDiscountAmount);
            }
          } else if (coupon.discountType === 'fixed') {
            couponDiscount = coupon.discountValue;
          }

          // Apply to subtotal or shipping
          if (coupon.appliesTo === 'shipping') {
            // Will be applied to shipping cost later
          } else {
            subtotal = Math.max(0, subtotal - couponDiscount);
          }
        }
      }

      // Calculate shipping cost
      const shippingCost = await shippingService.calculateShipping({
        address: shippingAddress,
        weight: totalWeight,
        dimensions: {
          length: 10, // Default dimensions
          width: 10,
          height: 10,
          unit: 'cm'
        },
        items: totalItems,
        shippingMethod
      });

      // Apply shipping discount if coupon applies to shipping
      let shippingDiscount = 0;
      if (coupon && coupon.appliesTo === 'shipping') {
        if (coupon.discountType === 'percentage') {
          shippingDiscount = shippingCost * (coupon.discountValue / 100);
        } else if (coupon.discountType === 'fixed') {
          shippingDiscount = Math.min(coupon.discountValue, shippingCost);
        }
      }

      const finalShippingCost = Math.max(0, shippingCost - shippingDiscount);

      // Calculate tax (simplified - in reality would use tax service)
      const taxRate = 0.08; // 8% tax rate for example
      const taxAmount = subtotal * taxRate;

      // Calculate total
      const total = subtotal + finalShippingCost + taxAmount;

      // Create order
      const order = new Order({
        user: userId,
        email: user.email,
        items: orderItems,
        shipping: {
          method: shippingMethod,
          cost: finalShippingCost,
          originalCost: shippingCost,
          discount: shippingDiscount,
          tax: {
            rate: taxRate,
            amount: taxAmount
          },
          address: shippingAddress,
          estimatedDelivery: await shippingService.getDeliveryEstimate(shippingAddress, shippingMethod)
        },
        billing: {
          address: billingAddress || shippingAddress,
          sameAsShipping: !billingAddress
        },
        payment: {
          method: paymentMethod,
          status: paymentMethod === 'cod' ? 'pending' : 'processing',
          amount: {
            subtotal,
            shipping: finalShippingCost,
            tax: taxAmount,
            discount: couponDiscount + shippingDiscount,
            total,
            currency: 'USD'
          }
        },
        customerNotes,
        discounts: coupon ? [{
          type: 'coupon',
          code: coupon.code,
          name: coupon.name,
          amount: couponDiscount + shippingDiscount,
          appliedTo: coupon.appliesTo
        }] : [],
        metadata: {
          isGift: !!giftMessage,
          giftMessage,
          giftWrap: giftWrap || false
        },
        analytics: {
          source: req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'web',
          device: this.getDeviceType(req.headers['user-agent']),
          browser: this.getBrowser(req.headers['user-agent']),
          os: this.getOS(req.headers['user-agent']),
          ip: req.ip,
          location: {
            country: req.headers['cf-ipcountry'],
            city: req.headers['cf-ipcity'],
            region: req.headers['cf-region']
          }
        },
        createdBy: userId
      });

      // Save order
      await order.save();

      // Update inventory (reserve items)
      for (const update of productUpdates) {
        const product = await Product.findById(update.productId);
        if (product) {
          product.updateInventory(update.quantity, update.variantSku, 'reserve');
          await product.save();
        }
      }

      // Update coupon usage
      if (coupon) {
        coupon.usedCount += 1;
        coupon.usageHistory.push({
          user: userId,
          order: order._id,
          discountAmount: couponDiscount + shippingDiscount,
          usedAt: new Date()
        });
        await coupon.save();
      }

      // Clear user's cart
      await Cart.findOneAndDelete({ user: userId });

      // Create payment intent if not COD
      let paymentIntent = null;
      if (paymentMethod !== 'cod') {
        paymentIntent = await paymentService.createPayment({
          gateway: paymentMethod === 'paypal' ? 'paypal' : 'stripe',
          amount: total,
          currency: 'usd',
          customerId: user.stripeCustomerId,
          metadata: {
            orderId: order.orderId,
            userId: userId.toString()
          },
          description: `Order #${order.orderId}`
        });

        // Update order with payment intent
        order.payment.transactionId = paymentIntent.id;
        order.payment.gateway = paymentMethod === 'paypal' ? 'paypal' : 'stripe';
        await order.save();
      }

      // Send order confirmation email
      await emailService.sendOrderConfirmation(order, user);

      // Log order creation
      logger.auditLog('ORDER_CREATED', userId, {
        orderId: order.orderId,
        total: total,
        items: orderItems.length,
        paymentMethod
      });

      res.status(201).json({
        success: true,
        message: 'Order created successfully',
        data: {
          order: {
            _id: order._id,
            orderId: order.orderId,
            shortId: order.shortId,
            status: order.status,
            total: order.payment.amount.total,
            paymentRequired: paymentMethod !== 'cod',
            paymentIntent: paymentIntent ? {
              id: paymentIntent.id,
              clientSecret: paymentIntent.client_secret
            } : null
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'create_order',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to create order: ' + error.message
      });
    }
  }

  // Get order by ID
  async getOrder(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRole = req.user.role;

      // Build query based on user role
      let query;
      if (userRole === 'admin' || userRole === 'superadmin') {
        query = { _id: id };
      } else {
        query = { _id: id, user: userId };
      }

      const order = await Order.findOne(query)
        .populate('user', 'firstName lastName email phone')
        .populate('items.product', 'name slug images')
        .populate('vendors.vendor', 'firstName lastName email')
        .lean();

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      res.json({
        success: true,
        data: { order }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_order',
        orderId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch order'
      });
    }
  }

  // Get order by short ID
  async getOrderByShortId(req, res) {
    try {
      const { shortId } = req.params;

      const order = await Order.findOne({ shortId })
        .populate('items.product', 'name slug images')
        .lean();

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      res.json({
        success: true,
        data: { order }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_order_by_short_id',
        shortId: req.params.shortId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch order'
      });
    }
  }

  // Get user orders
  async getUserOrders(req, res) {
    try {
      const userId = req.user._id;
      const {
        page = 1,
        limit = 10,
        status,
        startDate,
        endDate,
        sort = '-timeline.placedAt'
      } = req.query;

      // Build query
      const query = { user: userId };

      if (status) {
        query.status = status;
      }

      if (startDate || endDate) {
        query['timeline.placedAt'] = {};
        if (startDate) query['timeline.placedAt'].$gte = new Date(startDate);
        if (endDate) query['timeline.placedAt'].$lte = new Date(endDate);
      }

      // Parse sort options
      let sortOptions = { 'timeline.placedAt': -1 };
      if (sort === 'oldest') {
        sortOptions = { 'timeline.placedAt': 1 };
      } else if (sort === 'total_desc') {
        sortOptions = { 'payment.amount.total': -1 };
      } else if (sort === 'total_asc') {
        sortOptions = { 'payment.amount.total': 1 };
      }

      // Get orders with pagination
      const orders = await Order.paginate(query, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: sortOptions,
        populate: {
          path: 'items.product',
          select: 'name slug images'
        },
        lean: true
      });

      res.json({
        success: true,
        data: orders
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_user_orders',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch orders'
      });
    }
  }

  // Update order status (admin only)
  async updateOrderStatus(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRole = req.user.role;
      const { status, notes } = req.body;

      // Check permissions
      if (userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'Only admins can update order status'
        });
      }

      // Find order
      const order = await Order.findById(id);
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      // Validate status transition
      const validTransitions = {
        pending: ['confirmed', 'cancelled'],
        confirmed: ['processing', 'cancelled'],
        processing: ['ready_for_shipment', 'cancelled'],
        ready_for_shipment: ['shipped'],
        shipped: ['out_for_delivery', 'delivered'],
        out_for_delivery: ['delivered'],
        delivered: ['refunded'],
        cancelled: [],
        refunded: []
      };

      if (!validTransitions[order.status]?.includes(status)) {
        return res.status(400).json({
          success: false,
          error: `Cannot transition from ${order.status} to ${status}`
        });
      }

      // Update status
      order.status = status;
      order.updatedBy = userId;

      // Add internal note
      if (notes) {
        order.internalNotes.push({
          note: `Status changed to ${status}: ${notes}`,
          createdBy: userId,
          isPrivate: true
        });
      }

      // Handle status-specific actions
      if (status === 'cancelled') {
        // Restock items
        for (const item of order.items) {
          const product = await Product.findById(item.product);
          if (product) {
            product.updateInventory(item.quantity, item.variantSku, 'release');
            await product.save();
          }
        }

        // Refund payment if already captured
        if (order.payment.status === 'captured') {
          await paymentService.refundPayment({
            gateway: order.payment.gateway,
            paymentId: order.payment.transactionId,
            amount: order.payment.amount.total,
            reason: 'order_cancelled'
          });

          order.payment.status = 'refunded';
        }
      } else if (status === 'shipped') {
        // Generate tracking if not exists
        if (!order.shipping.tracking?.number) {
          order.shipping.tracking = {
            number: `TRK${Date.now()}${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
            carrier: shippingService.getDefaultCarrier(),
            url: `https://tracking.example.com/${order.shipping.tracking.number}`
          };
        }

        // Send shipping notification
        await emailService.sendShippingNotification(order, order.shipping.tracking);
      } else if (status === 'delivered') {
        order.timeline.deliveredAt = new Date();
        order.shipping.deliveredAt = new Date();

        // Release inventory reservations
        for (const item of order.items) {
          const product = await Product.findById(item.product);
          if (product) {
            product.updateInventory(item.quantity, item.variantSku, 'sell');
            await product.save();
          }
        }

        // Update user loyalty points
        const user = await User.findById(order.user);
        if (user) {
          const points = Math.floor(order.payment.amount.total); // 1 point per dollar
          user.updateLoyaltyPoints(points, 'add');
          await user.save();
        }
      }

      await order.save();

      // Send status update email to customer
      await emailService.sendEmail({
        to: order.email,
        subject: `Order #${order.orderId} Status Update`,
        templateName: 'order-status-update',
        templateData: {
          name: order.user?.firstName || 'Customer',
          orderId: order.orderId,
          status: status,
          trackingNumber: order.shipping.tracking?.number,
          trackingUrl: order.shipping.tracking?.url,
          notes: notes
        }
      });

      // Log status update
      logger.auditLog('ORDER_STATUS_UPDATED', userId, {
        orderId: order.orderId,
        from: order.status,
        to: status,
        notes
      });

      res.json({
        success: true,
        message: 'Order status updated successfully',
        data: { order }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_order_status',
        orderId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update order status'
      });
    }
  }

  // Cancel order
  async cancelOrder(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const { reason } = req.body;

      // Find order
      const order = await Order.findOne({ _id: id, user: userId });
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      // Check if order can be cancelled
      if (!order.canCancel) {
        return res.status(400).json({
          success: false,
          error: 'Order cannot be cancelled at this stage'
        });
      }

      // Update status
      order.status = 'cancelled';
      order.timeline.cancelledAt = new Date();
      order.internalNotes.push({
        note: `Order cancelled by customer: ${reason}`,
        createdBy: userId,
        isPrivate: false
      });

      // Restock items
      for (const item of order.items) {
        const product = await Product.findById(item.product);
        if (product) {
          product.updateInventory(item.quantity, item.variantSku, 'release');
          await product.save();
        }
      }

      // Refund payment if already captured
      if (order.payment.status === 'captured') {
        await paymentService.refundPayment({
          gateway: order.payment.gateway,
          paymentId: order.payment.transactionId,
          amount: order.payment.amount.total,
          reason: 'customer_cancelled'
        });

        order.payment.status = 'refunded';
      }

      await order.save();

      // Send cancellation email
      await emailService.sendEmail({
        to: order.email,
        subject: `Order #${order.orderId} Cancelled`,
        templateName: 'order-cancelled',
        templateData: {
          name: order.user?.firstName || 'Customer',
          orderId: order.orderId,
          reason: reason,
          refundAmount: order.payment.status === 'refunded' ? order.payment.amount.total : 0
        }
      });

      // Log cancellation
      logger.auditLog('ORDER_CANCELLED', userId, {
        orderId: order.orderId,
        reason: reason
      });

      res.json({
        success: true,
        message: 'Order cancelled successfully',
        data: { order }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'cancel_order',
        orderId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to cancel order'
      });
    }
  }

  // Track order
  async trackOrder(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;

      // Find order
      const order = await Order.findOne({ _id: id, user: userId })
        .select('orderId status shipping.tracking timeline')
        .lean();

      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      // Get tracking information from shipping service
      let trackingInfo = null;
      if (order.shipping.tracking?.number) {
        trackingInfo = await shippingService.getTrackingInfo(
          order.shipping.tracking.carrier,
          order.shipping.tracking.number
        );
      }

      res.json({
        success: true,
        data: {
          orderId: order.orderId,
          status: order.status,
          tracking: {
            ...order.shipping.tracking,
            events: trackingInfo?.events || []
          },
          timeline: order.timeline,
          estimatedDelivery: order.shipping.estimatedDelivery
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'track_order',
        orderId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to track order'
      });
    }
  }

  // Request return
  async requestReturn(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const { items, reason, notes } = req.body;

      if (!items || items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'At least one item must be selected for return'
        });
      }

      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Return reason is required'
        });
      }

      // Find order
      const order = await Order.findOne({ _id: id, user: userId });
      if (!order) {
        return res.status(404).json({
          success: false,
          error: 'Order not found'
        });
      }

      // Check if order can be returned
      if (!order.canReturn) {
        return res.status(400).json({
          success: false,
          error: 'Order cannot be returned at this stage'
        });
      }

      // Validate items
      for (const returnItem of items) {
        const orderItem = order.items.id(returnItem.itemId);
        if (!orderItem) {
          return res.status(400).json({
            success: false,
            error: `Item ${returnItem.itemId} not found in order`
          });
        }

        // Check if item is already returned
        const existingReturn = order.returns.find(r => 
          r.itemId.toString() === returnItem.itemId && 
          r.status !== 'rejected'
        );

        if (existingReturn) {
          return res.status(400).json({
            success: false,
            error: `Item ${orderItem.name} has already been returned`
          });
        }

        if (returnItem.quantity > orderItem.quantity) {
          return res.status(400).json({
            success: false,
            error: `Cannot return more than purchased quantity for ${orderItem.name}`
          });
        }
      }

      // Create return requests
      for (const returnItem of items) {
        order.returns.push({
          itemId: returnItem.itemId,
          quantity: returnItem.quantity,
          reason: reason,
          status: 'requested',
          requestedAt: new Date(),
          notes: notes
        });
      }

      await order.save();

      // Send return request notification
      await emailService.sendEmail({
        to: order.email,
        subject: `Return Request for Order #${order.orderId}`,
        templateName: 'return-requested',
        templateData: {
          name: order.user?.firstName || 'Customer',
          orderId: order.orderId,
          items: items.map(item => ({
            name: order.items.id(item.itemId).name,
            quantity: item.quantity
          })),
          reason: reason,
          notes: notes
        }
      });

      // Log return request
      logger.auditLog('RETURN_REQUESTED', userId, {
        orderId: order.orderId,
        items: items.length,
        reason: reason
      });

      res.json({
        success: true,
        message: 'Return request submitted successfully',
        data: { returns: order.returns }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'request_return',
        orderId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to submit return request'
      });
    }
  }

  // Get order statistics
  async getOrderStats(req, res) {
    try {
      const userId = req.user._id;
      const userRole = req.user.role;

      // Build query based on user role
      let query = {};
      if (userRole === 'vendor') {
        // For vendors, only include orders with their products
        const vendorProducts = await Product.find({ vendor: userId }).select('_id');
        const productIds = vendorProducts.map(p => p._id);
        
        query['items.product'] = { $in: productIds };
      } else if (userRole === 'customer') {
        query.user = userId;
      }

      const stats = await Order.aggregate([
        { $match: query },
        {
          $facet: {
            totalOrders: [
              { $count: 'count' }
            ],
            ordersByStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            revenueStats: [
              {
                $group: {
                  _id: null,
                  totalRevenue: { $sum: '$payment.amount.total' },
                  avgOrderValue: { $avg: '$payment.amount.total' },
                  minOrderValue: { $min: '$payment.amount.total' },
                  maxOrderValue: { $max: '$payment.amount.total' }
                }
              }
            ],
            ordersOverTime: [
              {
                $group: {
                  _id: { $dateToString: { format: '%Y-%m-%d', date: '$timeline.placedAt' } },
                  count: { $sum: 1 },
                  revenue: { $sum: '$payment.amount.total' }
                }
              },
              { $sort: { _id: 1 } },
              { $limit: 30 }
            ],
            topProducts: [
              { $unwind: '$items' },
              {
                $group: {
                  _id: '$items.product',
                  quantity: { $sum: '$items.quantity' },
                  revenue: { $sum: '$items.total' }
                }
              },
              { $sort: { revenue: -1 } },
              { $limit: 10 }
            ]
          }
        }
      ]);

      res.json({
        success: true,
        data: stats[0]
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_order_stats',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch order statistics'
      });
    }
  }

  // Export orders (admin only)
  async exportOrders(req, res) {
    try {
      const userRole = req.user.role;
      
      if (userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'Only admins can export orders'
        });
      }

      const { format = 'csv', startDate, endDate, status } = req.query;

      // Build query
      const query = {};
      
      if (startDate || endDate) {
        query['timeline.placedAt'] = {};
        if (startDate) query['timeline.placedAt'].$gte = new Date(startDate);
        if (endDate) query['timeline.placedAt'].$lte = new Date(endDate);
      }
      
      if (status) {
        query.status = status;
      }

      // Get orders
      const orders = await Order.find(query)
        .populate('user', 'email firstName lastName')
        .populate('items.product', 'name sku')
        .sort({ 'timeline.placedAt': -1 })
        .lean();

      // Format data based on requested format
      let exportData;
      let filename;
      let contentType;

      if (format === 'json') {
        exportData = JSON.stringify(orders, null, 2);
        filename = `orders_${Date.now()}.json`;
        contentType = 'application/json';
      } else if (format === 'csv') {
        const { Parser } = require('json2csv');
        const fields = [
          'orderId',
          'status',
          'user.email',
          'user.firstName',
          'user.lastName',
          'payment.amount.total',
          'timeline.placedAt',
          'shipping.address.country',
          'shipping.address.city'
        ];
        
        const parser = new Parser({ fields });
        exportData = parser.parse(orders);
        filename = `orders_${Date.now()}.csv`;
        contentType = 'text/csv';
      } else {
        return res.status(400).json({
          success: false,
          error: 'Unsupported export format'
        });
      }

      // Set response headers
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

      // Log export
      logger.auditLog('ORDERS_EXPORTED', req.user._id, {
        format: format,
        count: orders.length
      });

      res.send(exportData);
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'export_orders',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to export orders'
      });
    }
  }

  // Helper methods for device detection
  getDeviceType(userAgent) {
    if (!userAgent) return 'unknown';
    
    if (/mobile/i.test(userAgent)) return 'mobile';
    if (/tablet/i.test(userAgent)) return 'tablet';
    return 'desktop';
  }

  getBrowser(userAgent) {
    if (!userAgent) return 'unknown';
    
    if (/chrome/i.test(userAgent)) return 'chrome';
    if (/firefox/i.test(userAgent)) return 'firefox';
    if (/safari/i.test(userAgent)) return 'safari';
    if (/edge/i.test(userAgent)) return 'edge';
    if (/opera/i.test(userAgent)) return 'opera';
    return 'other';
  }

  getOS(userAgent) {
    if (!userAgent) return 'unknown';
    
    if (/windows/i.test(userAgent)) return 'windows';
    if (/mac os/i.test(userAgent)) return 'macos';
    if (/linux/i.test(userAgent)) return 'linux';
    if (/android/i.test(userAgent)) return 'android';
    if (/ios|iphone|ipad|ipod/i.test(userAgent)) return 'ios';
    return 'other';
  }
}

module.exports = new OrderController();
