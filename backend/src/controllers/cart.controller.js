const Cart = require('../models/Cart');
const Product = require('../models/Product');
const User = require('../models/User');
const logger = require('../config/logger');
const redis = require('../config/redis');

class CartController {
  // Get cart
  async getCart(req, res) {
    try {
      const userId = req.user._id;

      const cart = await Cart.findOne({ user: userId })
        .populate('items.product', 'name slug price images inventory variants')
        .lean();

      if (!cart) {
        return res.json({
          success: true,
          data: {
            items: [],
            totals: {
              subtotal: 0,
              tax: 0,
              shipping: 0,
              discount: 0,
              total: 0
            },
            itemCount: 0
          }
        });
      }

      // Calculate totals
      const totals = this.calculateCartTotals(cart.items);

      res.json({
        success: true,
        data: {
          _id: cart._id,
          items: cart.items,
          totals,
          itemCount: cart.items.reduce((sum, item) => sum + item.quantity, 0),
          updatedAt: cart.updatedAt
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_cart',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch cart'
      });
    }
  }

  // Add item to cart
  async addToCart(req, res) {
    try {
      const userId = req.user._id;
      const { productId, variantSku, quantity = 1 } = req.body;

      if (!productId) {
        return res.status(400).json({
          success: false,
          error: 'Product ID is required'
        });
      }

      // Validate quantity
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Quantity must be a positive integer'
        });
      }

      // Get product
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check variant if specified
      let variant = null;
      if (variantSku) {
        variant = product.variants.find(v => v.sku === variantSku);
        if (!variant) {
          return res.status(400).json({
            success: false,
            error: 'Variant not found'
          });
        }
      }

      // Check availability
      const availableStock = variant ? 
        variant.inventory.quantity - variant.inventory.reserved :
        product.inventory.quantity - product.inventory.reserved;
      
      if (availableStock < quantity) {
        if (!product.inventory.allowBackorders) {
          return res.status(400).json({
            success: false,
            error: `Insufficient stock. Available: ${availableStock}`
          });
        }
      }

      // Find or create cart
      let cart = await Cart.findOne({ user: userId });
      if (!cart) {
        cart = new Cart({
          user: userId,
          items: []
        });
      }

      // Check if item already exists in cart
      const existingItemIndex = cart.items.findIndex(item => 
        item.product.toString() === productId && 
        item.variantSku === variantSku
      );

      if (existingItemIndex > -1) {
        // Update quantity
        cart.items[existingItemIndex].quantity += quantity;
        cart.items[existingItemIndex].updatedAt = new Date();
      } else {
        // Add new item
        cart.items.push({
          product: productId,
          variantSku,
          quantity,
          price: this.calculateItemPrice(product, variant),
          addedAt: new Date(),
          updatedAt: new Date()
        });
      }

      await cart.save();

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log cart addition
      logger.auditLog('CART_ITEM_ADDED', userId, {
        productId,
        variantSku,
        quantity,
        ip: req.ip
      });

      // Get updated cart with populated data
      const updatedCart = await Cart.findById(cart._id)
        .populate('items.product', 'name slug price images')
        .lean();

      const totals = this.calculateCartTotals(updatedCart.items);

      res.json({
        success: true,
        message: 'Item added to cart',
        data: {
          items: updatedCart.items,
          totals,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'add_to_cart',
        userId: req.user?._id,
        productId: req.body.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to add item to cart: ' + error.message
      });
    }
  }

  // Update cart item quantity
  async updateCartItem(req, res) {
    try {
      const userId = req.user._id;
      const { itemId } = req.params;
      const { quantity } = req.body;

      if (!quantity || quantity <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Valid quantity is required'
        });
      }

      // Find cart
      const cart = await Cart.findOne({ user: userId });
      if (!cart) {
        return res.status(404).json({
          success: false,
          error: 'Cart not found'
        });
      }

      // Find item in cart
      const itemIndex = cart.items.findIndex(item => item._id.toString() === itemId);
      if (itemIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Item not found in cart'
        });
      }

      const item = cart.items[itemIndex];
      
      // Get product for stock check
      const product = await Product.findById(item.product);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check variant if exists
      let variant = null;
      if (item.variantSku) {
        variant = product.variants.find(v => v.sku === item.variantSku);
      }

      // Check availability
      const availableStock = variant ? 
        variant.inventory.quantity - variant.inventory.reserved :
        product.inventory.quantity - product.inventory.reserved;
      
      if (availableStock < quantity) {
        if (!product.inventory.allowBackorders) {
          return res.status(400).json({
            success: false,
            error: `Insufficient stock. Available: ${availableStock}`
          });
        }
      }

      // Update quantity
      cart.items[itemIndex].quantity = quantity;
      cart.items[itemIndex].updatedAt = new Date();

      await cart.save();

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log cart update
      logger.auditLog('CART_ITEM_UPDATED', userId, {
        itemId,
        oldQuantity: item.quantity,
        newQuantity: quantity,
        ip: req.ip
      });

      // Get updated cart with populated data
      const updatedCart = await Cart.findById(cart._id)
        .populate('items.product', 'name slug price images')
        .lean();

      const totals = this.calculateCartTotals(updatedCart.items);

      res.json({
        success: true,
        message: 'Cart updated',
        data: {
          items: updatedCart.items,
          totals,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_cart_item',
        userId: req.user?._id,
        itemId: req.params.itemId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update cart item'
      });
    }
  }

  // Remove item from cart
  async removeFromCart(req, res) {
    try {
      const userId = req.user._id;
      const { itemId } = req.params;

      // Find cart
      const cart = await Cart.findOne({ user: userId });
      if (!cart) {
        return res.status(404).json({
          success: false,
          error: 'Cart not found'
        });
      }

      // Find item in cart
      const itemIndex = cart.items.findIndex(item => item._id.toString() === itemId);
      if (itemIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Item not found in cart'
        });
      }

      const removedItem = cart.items[itemIndex];
      
      // Remove item
      cart.items.splice(itemIndex, 1);

      // If cart is empty, delete it
      if (cart.items.length === 0) {
        await Cart.findByIdAndDelete(cart._id);
      } else {
        await cart.save();
      }

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log cart removal
      logger.auditLog('CART_ITEM_REMOVED', userId, {
        itemId,
        productId: removedItem.product,
        quantity: removedItem.quantity,
        ip: req.ip
      });

      // Get updated cart with populated data
      let updatedCart;
      if (cart.items.length > 0) {
        updatedCart = await Cart.findById(cart._id)
          .populate('items.product', 'name slug price images')
          .lean();
      } else {
        updatedCart = { items: [] };
      }

      const totals = this.calculateCartTotals(updatedCart.items);

      res.json({
        success: true,
        message: 'Item removed from cart',
        data: {
          items: updatedCart.items,
          totals,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'remove_from_cart',
        userId: req.user?._id,
        itemId: req.params.itemId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to remove item from cart'
      });
    }
  }

  // Clear cart
  async clearCart(req, res) {
    try {
      const userId = req.user._id;

      // Delete cart
      await Cart.findOneAndDelete({ user: userId });

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log cart clearance
      logger.auditLog('CART_CLEARED', userId, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Cart cleared',
        data: {
          items: [],
          totals: {
            subtotal: 0,
            tax: 0,
            shipping: 0,
            discount: 0,
            total: 0
          },
          itemCount: 0
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'clear_cart',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to clear cart'
      });
    }
  }

  // Get cart summary
  async getCartSummary(req, res) {
    try {
      const userId = req.user._id;

      const cart = await Cart.findOne({ user: userId })
        .populate('items.product', 'price inventory')
        .lean();

      if (!cart || cart.items.length === 0) {
        return res.json({
          success: true,
          data: {
            itemCount: 0,
            subtotal: 0,
            estimatedTax: 0,
            estimatedShipping: 0,
            estimatedTotal: 0
          }
        });
      }

      const totals = this.calculateCartTotals(cart.items);
      const itemCount = cart.items.reduce((sum, item) => sum + item.quantity, 0);

      // Check stock availability
      const availability = await this.checkCartAvailability(cart.items);

      res.json({
        success: true,
        data: {
          itemCount,
          ...totals,
          availability
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_cart_summary',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get cart summary'
      });
    }
  }

  // Merge guest cart with user cart
  async mergeGuestCart(req, res) {
    try {
      const userId = req.user._id;
      const { guestCart } = req.body;

      if (!guestCart || !guestCart.items || !Array.isArray(guestCart.items)) {
        return res.status(400).json({
          success: false,
          error: 'Invalid guest cart data'
        });
      }

      // Get user cart
      let userCart = await Cart.findOne({ user: userId });
      if (!userCart) {
        userCart = new Cart({
          user: userId,
          items: []
        });
      }

      // Merge guest cart items
      for (const guestItem of guestCart.items) {
        const { productId, variantSku, quantity } = guestItem;

        if (!productId || !quantity) continue;

        // Check if item exists in user cart
        const existingItemIndex = userCart.items.findIndex(item => 
          item.product.toString() === productId && 
          item.variantSku === variantSku
        );

        if (existingItemIndex > -1) {
          // Update quantity
          userCart.items[existingItemIndex].quantity += quantity;
          userCart.items[existingItemIndex].updatedAt = new Date();
        } else {
          // Add new item
          userCart.items.push({
            product: productId,
            variantSku,
            quantity,
            addedAt: new Date(),
            updatedAt: new Date()
          });
        }
      }

      await userCart.save();

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log cart merge
      logger.auditLog('CART_MERGED', userId, {
        guestItems: guestCart.items.length,
        ip: req.ip
      });

      // Get updated cart with populated data
      const updatedCart = await Cart.findById(userCart._id)
        .populate('items.product', 'name slug price images')
        .lean();

      const totals = this.calculateCartTotals(updatedCart.items);

      res.json({
        success: true,
        message: 'Cart merged successfully',
        data: {
          items: updatedCart.items,
          totals,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'merge_guest_cart',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to merge cart: ' + error.message
      });
    }
  }

  // Save cart for later (move to wishlist)
  async saveForLater(req, res) {
    try {
      const userId = req.user._id;
      const { itemId } = req.params;

      // Find cart
      const cart = await Cart.findOne({ user: userId });
      if (!cart) {
        return res.status(404).json({
          success: false,
          error: 'Cart not found'
        });
      }

      // Find item in cart
      const itemIndex = cart.items.findIndex(item => item._id.toString() === itemId);
      if (itemIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Item not found in cart'
        });
      }

      const item = cart.items[itemIndex];
      
      // Add to user's wishlist
      const user = await User.findById(userId);
      if (user) {
        user.addToWishlist(item.product);
        await user.save();
      }

      // Remove from cart
      cart.items.splice(itemIndex, 1);

      // If cart is empty, delete it
      if (cart.items.length === 0) {
        await Cart.findByIdAndDelete(cart._id);
      } else {
        await cart.save();
      }

      // Clear caches
      await redis.del(`cart:${userId}`);
      await redis.del(`user:${userId}`);

      // Log save for later
      logger.auditLog('CART_ITEM_SAVED_FOR_LATER', userId, {
        itemId,
        productId: item.product,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Item saved for later and moved to wishlist'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'save_for_later',
        userId: req.user?._id,
        itemId: req.params.itemId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to save item for later'
      });
    }
  }

  // Apply coupon to cart
  async applyCoupon(req, res) {
    try {
      const userId = req.user._id;
      const { couponCode } = req.body;

      if (!couponCode) {
        return res.status(400).json({
          success: false,
          error: 'Coupon code is required'
        });
      }

      // Find cart
      const cart = await Cart.findOne({ user: userId });
      if (!cart || cart.items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Cart is empty'
        });
      }

      // Get coupon (this would be from Coupon model)
      // For now, implement simple coupon logic
      const coupon = await this.validateCoupon(couponCode, userId);
      if (!coupon) {
        return res.status(400).json({
          success: false,
          error: 'Invalid or expired coupon'
        });
      }

      // Calculate discount
      const totals = this.calculateCartTotals(cart.items);
      const discount = this.calculateDiscount(coupon, totals.subtotal);

      // Apply coupon to cart
      cart.coupon = {
        code: coupon.code,
        discount,
        type: coupon.discountType,
        appliedAt: new Date()
      };

      await cart.save();

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log coupon application
      logger.auditLog('COUPON_APPLIED', userId, {
        couponCode,
        discount,
        ip: req.ip
      });

      // Get updated cart with populated data
      const updatedCart = await Cart.findById(cart._id)
        .populate('items.product', 'name slug price images')
        .lean();

      const updatedTotals = this.calculateCartTotals(updatedCart.items, discount);

      res.json({
        success: true,
        message: 'Coupon applied successfully',
        data: {
          items: updatedCart.items,
          totals: updatedTotals,
          coupon: cart.coupon,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'apply_coupon',
        userId: req.user?._id,
        couponCode: req.body.couponCode,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to apply coupon: ' + error.message
      });
    }
  }

  // Remove coupon from cart
  async removeCoupon(req, res) {
    try {
      const userId = req.user._id;

      // Find cart
      const cart = await Cart.findOne({ user: userId });
      if (!cart) {
        return res.status(404).json({
          success: false,
          error: 'Cart not found'
        });
      }

      if (!cart.coupon) {
        return res.status(400).json({
          success: false,
          error: 'No coupon applied'
        });
      }

      // Remove coupon
      const removedCoupon = cart.coupon;
      cart.coupon = undefined;

      await cart.save();

      // Clear cart cache
      await redis.del(`cart:${userId}`);

      // Log coupon removal
      logger.auditLog('COUPON_REMOVED', userId, {
        couponCode: removedCoupon.code,
        ip: req.ip
      });

      // Get updated cart with populated data
      const updatedCart = await Cart.findById(cart._id)
        .populate('items.product', 'name slug price images')
        .lean();

      const totals = this.calculateCartTotals(updatedCart.items);

      res.json({
        success: true,
        message: 'Coupon removed',
        data: {
          items: updatedCart.items,
          totals,
          itemCount: updatedCart.items.reduce((sum, item) => sum + item.quantity, 0)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'remove_coupon',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to remove coupon'
      });
    }
  }

  // Helper methods
  calculateItemPrice(product, variant) {
    let price = product.price.base;
    
    // Apply variant price adjustment
    if (variant && variant.priceAdjustment) {
      price += variant.priceAdjustment;
    }
    
    // Apply sale price if active
    if (product.price.sale && 
        product.price.sale.startDate <= new Date() && 
        (!product.price.sale.endDate || product.price.sale.endDate >= new Date())) {
      
      if (product.price.sale.type === 'percentage') {
        price = price * (1 - product.price.sale.amount / 100);
      } else if (product.price.sale.type === 'fixed') {
        price = Math.max(0, price - product.price.sale.amount);
      }
    }
    
    return price;
  }

  calculateCartTotals(items, discount = 0) {
    const subtotal = items.reduce((sum, item) => {
      const itemPrice = item.price || this.calculateItemPrice(item.product, item.variant);
      return sum + (itemPrice * item.quantity);
    }, 0);

    // Calculate tax (simplified - 8% for example)
    const taxRate = 0.08;
    const tax = subtotal * taxRate;

    // Calculate shipping (simplified - free over $50, otherwise $5.99)
    const shipping = subtotal >= 50 ? 0 : 5.99;

    // Apply discount
    const totalDiscount = discount || 0;

    const total = subtotal + tax + shipping - totalDiscount;

    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax: parseFloat(tax.toFixed(2)),
      shipping: parseFloat(shipping.toFixed(2)),
      discount: parseFloat(totalDiscount.toFixed(2)),
      total: parseFloat(total.toFixed(2))
    };
  }

  async checkCartAvailability(items) {
    const availability = {
      allAvailable: true,
      outOfStock: [],
      lowStock: []
    };

    for (const item of items) {
      const product = await Product.findById(item.product);
      if (!product) continue;

      let availableStock;
      if (item.variantSku) {
        const variant = product.variants.find(v => v.sku === item.variantSku);
        availableStock = variant ? variant.inventory.quantity - variant.inventory.reserved : 0;
      } else {
        availableStock = product.inventory.quantity - product.inventory.reserved;
      }

      if (availableStock <= 0) {
        availability.allAvailable = false;
        availability.outOfStock.push({
          productId: product._id,
          name: product.name,
          variant: item.variantSku,
          requested: item.quantity,
          available: 0
        });
      } else if (availableStock < item.quantity) {
        availability.allAvailable = false;
        availability.lowStock.push({
          productId: product._id,
          name: product.name,
          variant: item.variantSku,
          requested: item.quantity,
          available: availableStock
        });
      }
    }

    return availability;
  }

  async validateCoupon(code, userId) {
    // This would query the Coupon model
    // For now, implement simple validation
    const coupons = {
      'WELCOME10': { code: 'WELCOME10', discountType: 'percentage', value: 10, minPurchase: 0 },
      'SAVE20': { code: 'SAVE20', discountType: 'fixed', value: 20, minPurchase: 100 },
      'FREESHIP': { code: 'FREESHIP', discountType: 'shipping', value: 100, minPurchase: 0 }
    };

    const coupon = coupons[code.toUpperCase()];
    if (!coupon) return null;

    // Check if coupon is expired (simplified)
    // In real implementation, check coupon.expiryDate

    return coupon;
  }

  calculateDiscount(coupon, subtotal) {
    if (subtotal < coupon.minPurchase) {
      return 0;
    }

    if (coupon.discountType === 'percentage') {
      return subtotal * (coupon.value / 100);
    } else if (coupon.discountType === 'fixed') {
      return Math.min(coupon.value, subtotal);
    } else if (coupon.discountType === 'shipping') {
      // This would be handled separately in shipping calculation
      return 0;
    }

    return 0;
  }
}

module.exports = new CartController();
