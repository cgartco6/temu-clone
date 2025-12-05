const Wishlist = require('../models/Wishlist');
const Product = require('../models/Product');
const User = require('../models/User');
const logger = require('../config/logger');
const redis = require('../config/redis');

class WishlistController {
  // Get wishlist
  async getWishlist(req, res) {
    try {
      const userId = req.user._id;

      const wishlist = await Wishlist.findOne({ user: userId })
        .populate('items.product', 'name slug price images ratings inventory')
        .lean();

      if (!wishlist) {
        return res.json({
          success: true,
          data: {
            items: [],
            count: 0
          }
        });
      }

      // Check product availability
      const items = await Promise.all(
        wishlist.items.map(async (item) => {
          const product = item.product;
          let available = false;
          let stockLevel = 'out_of_stock';

          if (product.inventory.type === 'infinite') {
            available = true;
            stockLevel = 'infinite';
          } else {
            const totalVariantStock = product.variants?.reduce((sum, variant) => sum + variant.inventory.quantity, 0) || 0;
            const availableStock = product.inventory.quantity + totalVariantStock - product.inventory.reserved;
            
            if (availableStock > 0) {
              available = true;
              stockLevel = availableStock <= product.inventory.lowStockThreshold ? 'low' : 'in_stock';
            }
          }

          return {
            ...item,
            product: {
              ...product,
              currentPrice: this.calculateCurrentPrice(product),
              inStock: available,
              stockLevel
            }
          };
        })
      );

      res.json({
        success: true,
        data: {
          items,
          count: items.length,
          updatedAt: wishlist.updatedAt
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_wishlist',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch wishlist'
      });
    }
  }

  // Add to wishlist
  async addToWishlist(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.body;

      if (!productId) {
        return res.status(400).json({
          success: false,
          error: 'Product ID is required'
        });
      }

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Find or create wishlist
      let wishlist = await Wishlist.findOne({ user: userId });
      if (!wishlist) {
        wishlist = new Wishlist({
          user: userId,
          items: []
        });
      }

      // Check if product already in wishlist
      const existingItem = wishlist.items.find(item => 
        item.product.toString() === productId
      );

      if (existingItem) {
        return res.status(400).json({
          success: false,
          error: 'Product already in wishlist'
        });
      }

      // Add product to wishlist
      wishlist.items.push({
        product: productId,
        addedAt: new Date()
      });

      await wishlist.save();

      // Clear wishlist cache
      await redis.del(`wishlist:${userId}`);

      // Also update user's wishlist array (for quick access)
      await User.findByIdAndUpdate(userId, {
        $addToSet: { wishlist: productId }
      });

      // Log wishlist addition
      logger.auditLog('WISHLIST_ITEM_ADDED', userId, {
        productId,
        ip: req.ip
      });

      // Get updated wishlist
      const updatedWishlist = await Wishlist.findOne({ user: userId })
        .populate('items.product', 'name slug price images')
        .lean();

      res.json({
        success: true,
        message: 'Product added to wishlist',
        data: {
          items: updatedWishlist.items,
          count: updatedWishlist.items.length
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'add_to_wishlist',
        userId: req.user?._id,
        productId: req.body.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to add to wishlist: ' + error.message
      });
    }
  }

  // Remove from wishlist
  async removeFromWishlist(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.params;

      // Find wishlist
      const wishlist = await Wishlist.findOne({ user: userId });
      if (!wishlist) {
        return res.status(404).json({
          success: false,
          error: 'Wishlist not found'
        });
      }

      // Find item index
      const itemIndex = wishlist.items.findIndex(item => 
        item.product.toString() === productId
      );

      if (itemIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Product not found in wishlist'
        });
      }

      // Remove item
      wishlist.items.splice(itemIndex, 1);

      // If wishlist is empty, delete it
      if (wishlist.items.length === 0) {
        await Wishlist.findByIdAndDelete(wishlist._id);
      } else {
        await wishlist.save();
      }

      // Clear wishlist cache
      await redis.del(`wishlist:${userId}`);

      // Also update user's wishlist array
      await User.findByIdAndUpdate(userId, {
        $pull: { wishlist: productId }
      });

      // Log wishlist removal
      logger.auditLog('WISHLIST_ITEM_REMOVED', userId, {
        productId,
        ip: req.ip
      });

      // Get updated wishlist
      let updatedWishlist = { items: [] };
      if (wishlist.items.length > 0) {
        updatedWishlist = await Wishlist.findOne({ user: userId })
          .populate('items.product', 'name slug price images')
          .lean();
      }

      res.json({
        success: true,
        message: 'Product removed from wishlist',
        data: {
          items: updatedWishlist.items,
          count: updatedWishlist.items.length
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'remove_from_wishlist',
        userId: req.user?._id,
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to remove from wishlist'
      });
    }
  }

  // Clear wishlist
  async clearWishlist(req, res) {
    try {
      const userId = req.user._id;

      // Delete wishlist
      await Wishlist.findOneAndDelete({ user: userId });

      // Clear user's wishlist array
      await User.findByIdAndUpdate(userId, {
        $set: { wishlist: [] }
      });

      // Clear wishlist cache
      await redis.del(`wishlist:${userId}`);

      // Log wishlist clearance
      logger.auditLog('WISHLIST_CLEARED', userId, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Wishlist cleared',
        data: {
          items: [],
          count: 0
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'clear_wishlist',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to clear wishlist'
      });
    }
  }

  // Move wishlist item to cart
  async moveToCart(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.params;
      const { quantity = 1 } = req.body;

      // Find wishlist
      const wishlist = await Wishlist.findOne({ user: userId });
      if (!wishlist) {
        return res.status(404).json({
          success: false,
          error: 'Wishlist not found'
        });
      }

      // Find item in wishlist
      const itemIndex = wishlist.items.findIndex(item => 
        item.product.toString() === productId
      );

      if (itemIndex === -1) {
        return res.status(404).json({
          success: false,
          error: 'Product not found in wishlist'
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

      // Check availability
      const availableStock = product.inventory.quantity - product.inventory.reserved;
      if (availableStock < quantity && !product.inventory.allowBackorders) {
        return res.status(400).json({
          success: false,
          error: `Insufficient stock. Available: ${availableStock}`
        });
      }

      // Remove from wishlist
      wishlist.items.splice(itemIndex, 1);

      // If wishlist is empty, delete it
      if (wishlist.items.length === 0) {
        await Wishlist.findByIdAndDelete(wishlist._id);
      } else {
        await wishlist.save();
      }

      // Update user's wishlist array
      await User.findByIdAndUpdate(userId, {
        $pull: { wishlist: productId }
      });

      // Add to cart
      const Cart = require('./cart.controller');
      const cartController = new Cart();
      
      // We'll simulate adding to cart
      // In real implementation, you would call the cart controller
      const cart = await require('../models/Cart').findOne({ user: userId });
      if (cart) {
        const cartItemIndex = cart.items.findIndex(item => 
          item.product.toString() === productId
        );

        if (cartItemIndex > -1) {
          cart.items[cartItemIndex].quantity += quantity;
        } else {
          cart.items.push({
            product: productId,
            quantity,
            addedAt: new Date(),
            updatedAt: new Date()
          });
        }
        await cart.save();
      } else {
        const newCart = new require('../models/Cart')({
          user: userId,
          items: [{
            product: productId,
            quantity,
            addedAt: new Date(),
            updatedAt: new Date()
          }]
        });
        await newCart.save();
      }

      // Clear caches
      await redis.del(`wishlist:${userId}`);
      await redis.del(`cart:${userId}`);
      await redis.del(`user:${userId}`);

      // Log move to cart
      logger.auditLog('WISHLIST_TO_CART', userId, {
        productId,
        quantity,
        ip: req.ip
      });

      // Get updated wishlist
      let updatedWishlist = { items: [] };
      if (wishlist.items.length > 0) {
        updatedWishlist = await Wishlist.findOne({ user: userId })
          .populate('items.product', 'name slug price images')
          .lean();
      }

      // Get updated cart
      const updatedCart = await require('../models/Cart').findOne({ user: userId })
        .populate('items.product', 'name slug price images')
        .lean();

      const cartTotals = wishlistController.calculateCartTotals(updatedCart?.items || []);

      res.json({
        success: true,
        message: 'Product moved to cart',
        data: {
          wishlist: {
            items: updatedWishlist.items,
            count: updatedWishlist.items.length
          },
          cart: {
            items: updatedCart?.items || [],
            totals: cartTotals,
            itemCount: updatedCart?.items.reduce((sum, item) => sum + item.quantity, 0) || 0
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'move_to_cart',
        userId: req.user?._id,
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to move to cart: ' + error.message
      });
    }
  }

  // Get wishlist count
  async getWishlistCount(req, res) {
    try {
      const userId = req.user._id;

      const cacheKey = `wishlist:count:${userId}`;
      const cachedCount = await redis.get(cacheKey);

      if (cachedCount) {
        return res.json({
          success: true,
          data: {
            count: parseInt(cachedCount)
          }
        });
      }

      const wishlist = await Wishlist.findOne({ user: userId });
      const count = wishlist ? wishlist.items.length : 0;

      // Cache for 5 minutes
      await redis.set(cacheKey, count.toString(), 300);

      res.json({
        success: true,
        data: { count }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_wishlist_count',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get wishlist count'
      });
    }
  }

  // Check if product is in wishlist
  async checkInWishlist(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.params;

      const wishlist = await Wishlist.findOne({ 
        user: userId,
        'items.product': productId
      });

      res.json({
        success: true,
        data: {
          inWishlist: !!wishlist,
          wishlistId: wishlist?._id
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'check_in_wishlist',
        userId: req.user?._id,
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to check wishlist status'
      });
    }
  }

  // Get wishlist recommendations
  async getRecommendations(req, res) {
    try {
      const userId = req.user._id;
      const { limit = 8 } = req.query;

      const cacheKey = `wishlist:recommendations:${userId}:${limit}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached)
        });
      }

      // Get user's wishlist products
      const wishlist = await Wishlist.findOne({ user: userId })
        .populate('items.product', 'category tags')
        .lean();

      if (!wishlist || wishlist.items.length === 0) {
        // If no wishlist, return trending products
        const trendingProducts = await Product.find({
          status: 'active',
          visibility: 'public'
        })
        .select('name slug price images ratings')
        .sort({ 'analytics.purchases': -1 })
        .limit(parseInt(limit))
        .lean();

        // Cache for 5 minutes
        await redis.set(cacheKey, JSON.stringify(trendingProducts), 300);

        return res.json({
          success: true,
          data: trendingProducts
        });
      }

      // Extract categories and tags from wishlist
      const categories = new Set();
      const tags = new Set();

      wishlist.items.forEach(item => {
        if (item.product.category) {
          categories.add(item.product.category.toString());
        }
        if (item.product.tags) {
          item.product.tags.forEach(tag => tags.add(tag));
        }
      });

      // Get recommended products (similar categories/tags)
      const recommendations = await Product.find({
        _id: { $nin: wishlist.items.map(item => item.product._id) },
        $or: [
          { category: { $in: Array.from(categories) } },
          { tags: { $in: Array.from(tags) } }
        ],
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings')
      .sort({ 'ratings.average': -1, 'analytics.purchases': -1 })
      .limit(parseInt(limit))
      .lean();

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(recommendations), 300);

      res.json({
        success: true,
        data: recommendations
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_wishlist_recommendations',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get recommendations'
      });
    }
  }

  // Export wishlist (email or download)
  async exportWishlist(req, res) {
    try {
      const userId = req.user._id;
      const { format = 'json', email } = req.body;

      // Get wishlist with product details
      const wishlist = await Wishlist.findOne({ user: userId })
        .populate('items.product', 'name slug price images brand')
        .lean();

      if (!wishlist || wishlist.items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Wishlist is empty'
        });
      }

      // Get user
      const user = await User.findById(userId).select('email firstName');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Format wishlist data
      const wishlistData = {
        user: {
          name: user.firstName,
          email: user.email
        },
        items: wishlist.items.map(item => ({
          name: item.product.name,
          price: this.calculateCurrentPrice(item.product),
          brand: item.product.brand,
          image: item.product.images?.[0]?.url,
          addedAt: item.addedAt
        })),
        summary: {
          totalItems: wishlist.items.length,
          totalValue: wishlist.items.reduce((sum, item) => {
            return sum + this.calculateCurrentPrice(item.product);
          }, 0),
          exportDate: new Date().toISOString()
        }
      };

      if (format === 'email' && email) {
        // Send email
        await emailService.sendEmail({
          to: email,
          subject: 'Your Wishlist',
          templateName: 'wishlist-export',
          templateData: {
            name: user.firstName,
            items: wishlistData.items,
            summary: wishlistData.summary,
            wishlistUrl: `${process.env.FRONTEND_URL}/wishlist`
          }
        });

        // Log export
        logger.auditLog('WISHLIST_EXPORTED_EMAIL', userId, {
          email,
          itemCount: wishlist.items.length,
          ip: req.ip
        });

        return res.json({
          success: true,
          message: 'Wishlist sent to email',
          data: { email }
        });
      } else if (format === 'json') {
        // Return JSON
        res.json({
          success: true,
          data: wishlistData
        });
      } else if (format === 'csv') {
        // Generate CSV
        const { Parser } = require('json2csv');
        const fields = ['name', 'price', 'brand', 'addedAt'];
        const parser = new Parser({ fields });
        const csv = parser.parse(wishlistData.items);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="wishlist_${Date.now()}.csv"`);

        // Log export
        logger.auditLog('WISHLIST_EXPORTED_CSV', userId, {
          itemCount: wishlist.items.length,
          ip: req.ip
        });

        return res.send(csv);
      } else {
        return res.status(400).json({
          success: false,
          error: 'Invalid export format'
        });
      }
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'export_wishlist',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to export wishlist'
      });
    }
  }

  // Share wishlist
  async shareWishlist(req, res) {
    try {
      const userId = req.user._id;
      const { shareWith, message } = req.body;

      if (!shareWith) {
        return res.status(400).json({
          success: false,
          error: 'Share with email or user ID is required'
        });
      }

      // Get wishlist
      const wishlist = await Wishlist.findOne({ user: userId })
        .populate('items.product', 'name price images')
        .lean();

      if (!wishlist || wishlist.items.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Wishlist is empty'
        });
      }

      // Get user
      const user = await User.findById(userId).select('firstName email');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate share token
      const crypto = require('crypto');
      const shareToken = crypto.randomBytes(32).toString('hex');
      const tokenExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

      // Store share token (in real implementation, you'd have a Share model)
      await redis.set(`wishlist:share:${shareToken}`, JSON.stringify({
        userId,
        wishlistId: wishlist._id,
        expiresAt: tokenExpiry
      }), 7 * 24 * 60 * 60); // 7 days

      // Create share URL
      const shareUrl = `${process.env.FRONTEND_URL}/shared-wishlist/${shareToken}`;

      // Send share notification
      if (shareWith.includes('@')) {
        // Email
        await emailService.sendEmail({
          to: shareWith,
          subject: `${user.firstName} shared their wishlist with you`,
          templateName: 'wishlist-share',
          templateData: {
            senderName: user.firstName,
            senderEmail: user.email,
            message: message || `${user.firstName} wants to share their wishlist with you`,
            shareUrl,
            itemCount: wishlist.items.length,
            expiryDays: 7
          }
        });
      } else {
        // User ID (internal share)
        const recipient = await User.findById(shareWith);
        if (recipient) {
          // Store notification for recipient
          // This would go to a notification system
          logger.info(`Wishlist shared from ${user.email} to ${recipient.email}`);
        }
      }

      // Log share
      logger.auditLog('WISHLIST_SHARED', userId, {
        shareWith,
        itemCount: wishlist.items.length,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Wishlist shared successfully',
        data: {
          shareUrl,
          expiresAt: tokenExpiry
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'share_wishlist',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to share wishlist: ' + error.message
      });
    }
  }

  // Get shared wishlist
  async getSharedWishlist(req, res) {
    try {
      const { token } = req.params;

      // Get share data from cache
      const shareData = await redis.get(`wishlist:share:${token}`);
      if (!shareData) {
        return res.status(404).json({
          success: false,
          error: 'Shared wishlist not found or expired'
        });
      }

      const { userId, wishlistId, expiresAt } = JSON.parse(shareData);

      // Check if token expired
      if (new Date(expiresAt) < new Date()) {
        await redis.del(`wishlist:share:${token}`);
        return res.status(410).json({
          success: false,
          error: 'Shared wishlist has expired'
        });
      }

      // Get wishlist
      const wishlist = await Wishlist.findById(wishlistId)
        .populate('items.product', 'name slug price images ratings brand category')
        .lean();

      if (!wishlist) {
        return res.status(404).json({
          success: false,
          error: 'Wishlist not found'
        });
      }

      // Get owner info
      const owner = await User.findById(userId).select('firstName email avatar');
      if (!owner) {
        return res.status(404).json({
          success: false,
          error: 'Wishlist owner not found'
        });
      }

      // Format items with current prices
      const items = wishlist.items.map(item => ({
        ...item,
        product: {
          ...item.product,
          currentPrice: this.calculateCurrentPrice(item.product),
          inStock: this.checkProductAvailability(item.product)
        }
      }));

      res.json({
        success: true,
        data: {
          owner,
          items,
          count: items.length,
          sharedAt: wishlist.updatedAt,
          expiresAt: new Date(expiresAt)
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_shared_wishlist',
        token: req.params.token,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get shared wishlist'
      });
    }
  }

  // Helper methods
  calculateCurrentPrice(product) {
    let price = product.price?.base || 0;
    
    // Apply sale price if active
    if (product.price?.sale && 
        product.price.sale.startDate <= new Date() && 
        (!product.price.sale.endDate || product.price.sale.endDate >= new Date())) {
      
      if (product.price.sale.type === 'percentage') {
        price = price * (1 - product.price.sale.amount / 100);
      } else if (product.price.sale.type === 'fixed') {
        price = Math.max(0, price - product.price.sale.amount);
      }
    }
    
    return parseFloat(price.toFixed(2));
  }

  checkProductAvailability(product) {
    if (product.inventory?.type === 'infinite') {
      return true;
    }
    
    const totalVariantStock = product.variants?.reduce((sum, variant) => sum + variant.inventory.quantity, 0) || 0;
    const availableStock = (product.inventory?.quantity || 0) + totalVariantStock - (product.inventory?.reserved || 0);
    
    return availableStock > 0;
  }

  calculateCartTotals(items) {
    const subtotal = items.reduce((sum, item) => {
      const itemPrice = item.price || this.calculateCurrentPrice(item.product);
      return sum + (itemPrice * item.quantity);
    }, 0);

    const tax = subtotal * 0.08; // 8% tax
    const shipping = subtotal >= 50 ? 0 : 5.99;
    const total = subtotal + tax + shipping;

    return {
      subtotal: parseFloat(subtotal.toFixed(2)),
      tax: parseFloat(tax.toFixed(2)),
      shipping: parseFloat(shipping.toFixed(2)),
      total: parseFloat(total.toFixed(2))
    };
  }
}

module.exports = new WishlistController();
