const User = require('../models/User');
const Order = require('../models/Order');
const Review = require('../models/Review');
const Product = require('../models/Product');
const logger = require('../config/logger');
const emailService = require('../config/email');
const uploadService = require('../config/upload');
const redis = require('../config/redis');
const mongoose = require('mongoose');

class UserController {
  // Get user profile
  async getProfile(req, res) {
    try {
      const userId = req.user._id;
      
      const user = await User.findById(userId)
        .select('-password -twoFactorSecret -loginAttempts -lockUntil')
        .populate('addresses')
        .populate('cart.items.product')
        .populate('wishlist.product')
        .populate('recentlyViewed.product')
        .populate('referrals.user')
        .lean();

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Get user stats
      const stats = await this.getUserStats(userId);

      res.json({
        success: true,
        data: {
          user,
          stats
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_profile',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch profile'
      });
    }
  }

  // Update user profile
  async updateProfile(req, res) {
    try {
      const userId = req.user._id;
      const updates = req.body;

      // Remove restricted fields
      const restrictedFields = [
        'email',
        'password',
        'role',
        'status',
        'twoFactorSecret',
        'loginAttempts',
        'lockUntil',
        'stripeCustomerId',
        'referralCode',
        'referredBy',
        'loyaltyPoints',
        'loyaltyTier',
        'wallet.balance',
        'metadata.registrationSource'
      ];

      restrictedFields.forEach(field => {
        delete updates[field];
      });

      // Handle nested updates
      const updateObject = {};
      Object.keys(updates).forEach(key => {
        if (updates[key] !== undefined && updates[key] !== null) {
          // Handle nested objects
          if (typeof updates[key] === 'object' && !Array.isArray(updates[key])) {
            Object.keys(updates[key]).forEach(subKey => {
              updateObject[`${key}.${subKey}`] = updates[key][subKey];
            });
          } else {
            updateObject[key] = updates[key];
          }
        }
      });

      // Find and update user
      const user = await User.findByIdAndUpdate(
        userId,
        { $set: updateObject },
        { 
          new: true, 
          runValidators: true,
          context: 'query'
        }
      ).select('-password -twoFactorSecret -loginAttempts -lockUntil');

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Log profile update
      logger.auditLog('PROFILE_UPDATED', userId, {
        updatedFields: Object.keys(updates),
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: { user }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_profile',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update profile: ' + error.message
      });
    }
  }

  // Update user email
  async updateEmail(req, res) {
    try {
      const userId = req.user._id;
      const { email, password } = req.body;

      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Email and password are required'
        });
      }

      // Validate email
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please provide a valid email address'
        });
      }

      // Find user with password
      const user = await User.findById(userId).select('+password');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Verify password
      const isPasswordValid = await user.correctPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Incorrect password'
        });
      }

      // Check if email already exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser && existingUser._id.toString() !== userId.toString()) {
        return res.status(409).json({
          success: false,
          error: 'Email is already in use'
        });
      }

      // Update email
      user.email = email.toLowerCase();
      user.isEmailVerified = false;
      
      // Generate verification token
      const verificationToken = user.createEmailVerificationToken();
      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Send verification email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Verify your new email address',
        templateName: 'email-verification',
        templateData: {
          name: user.firstName,
          verificationUrl: `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`,
          expiryHours: 24
        }
      });

      // Log email update
      logger.auditLog('EMAIL_UPDATED', userId, {
        oldEmail: req.user.email,
        newEmail: email,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Email updated successfully. Please verify your new email address.',
        data: {
          user: {
            email: user.email,
            isEmailVerified: user.isEmailVerified
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_email',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update email'
      });
    }
  }

  // Upload profile picture
  async uploadProfilePicture(req, res) {
    try {
      const userId = req.user._id;
      
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded'
        });
      }

      // Find user
      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Optimize image
      const optimized = await uploadService.optimizeImage(req.file.path, {
        width: 500,
        height: 500,
        quality: 80,
        format: 'webp'
      });

      // Generate thumbnails
      const thumbnails = await uploadService.generateThumbnails(optimized.path, [
        { width: 150, height: 150, suffix: '_thumb' },
        { width: 300, height: 300, suffix: '_small' }
      ]);

      // Get image info
      const imageInfo = uploadService.getFileInfo(optimized.path);

      // Delete old profile picture if exists
      if (user.avatar?.url) {
        await uploadService.deleteFile(user.avatar.url.replace('/uploads/', 'uploads/'));
        if (user.avatar.thumbnailUrl) {
          await uploadService.deleteFile(user.avatar.thumbnailUrl.replace('/uploads/', 'uploads/'));
        }
      }

      // Update user avatar
      user.avatar = {
        url: `/uploads/${path.basename(optimized.path)}`,
        publicId: req.file.filename,
        thumbnailUrl: thumbnails[0]?.path ? `/uploads/${path.basename(thumbnails[0].path)}` : null
      };

      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Log profile picture upload
      logger.auditLog('PROFILE_PICTURE_UPLOADED', userId, {
        fileSize: req.file.size,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Profile picture uploaded successfully',
        data: {
          avatar: user.avatar
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'upload_profile_picture',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to upload profile picture'
      });
    }
  }

  // Manage addresses
  async manageAddresses(req, res) {
    try {
      const userId = req.user._id;
      const { action, address, addressId } = req.body;

      if (!action) {
        return res.status(400).json({
          success: false,
          error: 'Action is required'
        });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      let result;

      switch (action) {
        case 'add':
          if (!address) {
            return res.status(400).json({
              success: false,
              error: 'Address data is required'
            });
          }
          result = await this.addAddress(user, address);
          break;

        case 'update':
          if (!addressId || !address) {
            return res.status(400).json({
              success: false,
              error: 'Address ID and data are required'
            });
          }
          result = await this.updateAddress(user, addressId, address);
          break;

        case 'delete':
          if (!addressId) {
            return res.status(400).json({
              success: false,
              error: 'Address ID is required'
            });
          }
          result = await this.deleteAddress(user, addressId);
          break;

        case 'set-default':
          if (!addressId) {
            return res.status(400).json({
              success: false,
              error: 'Address ID is required'
            });
          }
          result = await this.setDefaultAddress(user, addressId);
          break;

        default:
          return res.status(400).json({
            success: false,
            error: 'Invalid action'
          });
      }

      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Log address management
      logger.auditLog('ADDRESS_MANAGED', userId, {
        action,
        addressId,
        ip: req.ip
      });

      res.json({
        success: true,
        message: `Address ${action}ed successfully`,
        data: {
          addresses: user.addresses
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'manage_addresses',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: `Failed to ${req.body.action} address: ${error.message}`
      });
    }
  }

  // Add address helper
  async addAddress(user, addressData) {
    // Validate address data
    const requiredFields = ['street1', 'city', 'state', 'country', 'postalCode'];
    for (const field of requiredFields) {
      if (!addressData[field]) {
        throw new Error(`${field} is required`);
      }
    }

    // Set isDefault to true if this is the first address
    const isFirstAddress = user.addresses.length === 0;
    
    const newAddress = {
      ...addressData,
      isDefault: addressData.isDefault || isFirstAddress
    };

    // If setting as default, unset other defaults
    if (newAddress.isDefault) {
      user.addresses.forEach(addr => {
        addr.isDefault = false;
      });
    }

    user.addresses.push(newAddress);
    return newAddress;
  }

  // Update address helper
  async updateAddress(user, addressId, updates) {
    const address = user.addresses.id(addressId);
    if (!address) {
      throw new Error('Address not found');
    }

    Object.keys(updates).forEach(key => {
      if (updates[key] !== undefined && key !== '_id') {
        address[key] = updates[key];
      }
    });

    return address;
  }

  // Delete address helper
  async deleteAddress(user, addressId) {
    const addressIndex = user.addresses.findIndex(addr => addr._id.toString() === addressId);
    if (addressIndex === -1) {
      throw new Error('Address not found');
    }

    const wasDefault = user.addresses[addressIndex].isDefault;
    
    user.addresses.splice(addressIndex, 1);

    // If we deleted the default address and there are other addresses, set a new default
    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }

    return { deleted: true };
  }

  // Set default address helper
  async setDefaultAddress(user, addressId) {
    const address = user.addresses.id(addressId);
    if (!address) {
      throw new Error('Address not found');
    }

    // Unset all defaults
    user.addresses.forEach(addr => {
      addr.isDefault = false;
    });

    // Set new default
    address.isDefault = true;

    return address;
  }

  // Get user preferences
  async getPreferences(req, res) {
    try {
      const userId = req.user._id;
      
      const user = await User.findById(userId).select('preferences');
      
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      res.json({
        success: true,
        data: {
          preferences: user.preferences
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_preferences',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch preferences'
      });
    }
  }

  // Update preferences
  async updatePreferences(req, res) {
    try {
      const userId = req.user._id;
      const updates = req.body;

      // Validate updates
      const validPreferences = {
        language: ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko'],
        currency: ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR'],
        theme: ['light', 'dark', 'auto']
      };

      Object.keys(updates).forEach(key => {
        if (validPreferences[key] && !validPreferences[key].includes(updates[key])) {
          throw new Error(`Invalid value for ${key}`);
        }
      });

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Update preferences
      Object.keys(updates).forEach(key => {
        if (typeof updates[key] === 'object' && !Array.isArray(updates[key])) {
          Object.keys(updates[key]).forEach(subKey => {
            if (user.preferences[key]) {
              user.preferences[key][subKey] = updates[key][subKey];
            }
          });
        } else {
          user.preferences[key] = updates[key];
        }
      });

      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Log preferences update
      logger.auditLog('PREFERENCES_UPDATED', userId, {
        updatedFields: Object.keys(updates),
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Preferences updated successfully',
        data: {
          preferences: user.preferences
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_preferences',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update preferences: ' + error.message
      });
    }
  }

  // Get user activity
  async getActivity(req, res) {
    try {
      const userId = req.user._id;
      const { type, limit = 20, page = 1 } = req.query;

      const user = await User.findById(userId)
        .select('loginHistory recentlyViewed searchHistory')
        .lean();

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      let activity = [];
      let total = 0;

      switch (type) {
        case 'login':
          activity = user.loginHistory
            .sort((a, b) => b.timestamp - a.timestamp)
            .slice((page - 1) * limit, page * limit);
          total = user.loginHistory.length;
          break;

        case 'viewed':
          activity = user.recentlyViewed
            .sort((a, b) => b.viewedAt - a.viewedAt)
            .slice((page - 1) * limit, page * limit);
          total = user.recentlyViewed.length;
          break;

        case 'search':
          activity = user.searchHistory
            .sort((a, b) => b.lastSearched - a.lastSearched)
            .slice((page - 1) * limit, page * limit);
          total = user.searchHistory.length;
          break;

        default:
          // Combine all activities
          const allActivities = [
            ...user.loginHistory.map(item => ({ ...item, type: 'login' })),
            ...user.recentlyViewed.map(item => ({ ...item, type: 'viewed' })),
            ...user.searchHistory.map(item => ({ ...item, type: 'search' }))
          ].sort((a, b) => {
            const dateA = a.timestamp || a.viewedAt || a.lastSearched;
            const dateB = b.timestamp || b.viewedAt || b.lastSearched;
            return dateB - dateA;
          });
          
          activity = allActivities.slice((page - 1) * limit, page * limit);
          total = allActivities.length;
          break;
      }

      res.json({
        success: true,
        data: {
          activity,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total,
            pages: Math.ceil(total / limit)
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_activity',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch activity'
      });
    }
  }

  // Get user wallet
  async getWallet(req, res) {
    try {
      const userId = req.user._id;
      
      const user = await User.findById(userId).select('wallet loyaltyPoints loyaltyTier');
      
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Get recent transactions
      const recentTransactions = user.wallet.transactions
        .sort((a, b) => b.date - a.date)
        .slice(0, 10);

      res.json({
        success: true,
        data: {
          wallet: {
            balance: user.wallet.balance,
            currency: user.wallet.currency,
            recentTransactions
          },
          loyalty: {
            points: user.loyaltyPoints,
            tier: user.loyaltyTier,
            nextTier: this.getNextTier(user.loyaltyPoints, user.loyaltyTier)
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_wallet',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch wallet'
      });
    }
  }

  // Add wallet funds
  async addWalletFunds(req, res) {
    try {
      const userId = req.user._id;
      const { amount, paymentMethod } = req.body;

      if (!amount || amount <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Valid amount is required'
        });
      }

      if (!paymentMethod) {
        return res.status(400).json({
          success: false,
          error: 'Payment method is required'
        });
      }

      const user = await User.findById(userId);
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Create payment intent
      const paymentService = require('../config/payment');
      const paymentIntent = await paymentService.createPayment({
        gateway: paymentMethod === 'paypal' ? 'paypal' : 'stripe',
        amount,
        currency: 'usd',
        customerId: user.stripeCustomerId,
        metadata: {
          userId: userId.toString(),
          type: 'wallet_topup'
        },
        description: `Wallet top-up: $${amount}`
      });

      // Store pending transaction
      const transactionId = `WALLET-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      
      user.wallet.transactions.push({
        type: 'credit',
        amount,
        description: `Wallet top-up via ${paymentMethod}`,
        reference: transactionId,
        status: 'pending'
      });

      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Log wallet top-up
      logger.auditLog('WALLET_TOPUP_INITIATED', userId, {
        amount,
        paymentMethod,
        transactionId,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Payment initiated',
        data: {
          paymentIntent: paymentIntent.id,
          clientSecret: paymentIntent.client_secret,
          amount,
          transactionId
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'add_wallet_funds',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to add funds: ' + error.message
      });
    }
  }

  // Get referral information
  async getReferralInfo(req, res) {
    try {
      const userId = req.user._id;
      
      const user = await User.findById(userId)
        .select('referralCode referredBy referrals')
        .populate('referrals.user', 'firstName lastName email')
        .populate('referredBy', 'firstName lastName email')
        .lean();

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Get referral stats
      const referralStats = {
        totalReferrals: user.referrals.length,
        earnedPoints: user.referrals.reduce((sum, ref) => sum + (ref.earnedPoints || 0), 0),
        referralUrl: `${process.env.FRONTEND_URL}/signup?ref=${user.referralCode}`
      };

      res.json({
        success: true,
        data: {
          referralCode: user.referralCode,
          referredBy: user.referredBy,
          referrals: user.referrals,
          stats: referralStats
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_referral_info',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch referral information'
      });
    }
  }

  // Deactivate account
  async deactivateAccount(req, res) {
    try {
      const userId = req.user._id;
      const { reason, password } = req.body;

      if (!password) {
        return res.status(400).json({
          success: false,
          error: 'Password is required'
        });
      }

      // Find user with password
      const user = await User.findById(userId).select('+password');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Verify password
      const isPasswordValid = await user.correctPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Incorrect password'
        });
      }

      // Deactivate account
      user.status = 'inactive';
      user.deactivatedAt = new Date();
      
      // Clear sensitive data
      user.loginHistory = [];
      user.deviceTokens = [];
      user.cart.items = [];
      user.wishlist = [];
      user.recentlyViewed = [];
      user.searchHistory = [];

      await user.save();

      // Clear all user cache
      await redis.flush(`user:${userId}:*`);
      await redis.del(`refresh_token:${userId}`);

      // Send deactivation email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Account Deactivated',
        templateName: 'account-deactivated',
        templateData: {
          name: user.firstName,
          deactivationDate: new Date().toLocaleDateString(),
          reason: reason || 'Not specified',
          reactivationWindow: 30 // days
        }
      });

      // Log account deactivation
      logger.auditLog('ACCOUNT_DEACTIVATED', userId, {
        reason,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Account deactivated successfully. You can reactivate within 30 days.'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'deactivate_account',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to deactivate account'
      });
    }
  }

  // Request account deletion
  async requestAccountDeletion(req, res) {
    try {
      const userId = req.user._id;
      const { reason, password } = req.body;

      if (!password) {
        return res.status(400).json({
          success: false,
          error: 'Password is required'
        });
      }

      // Find user with password
      const user = await User.findById(userId).select('+password');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Verify password
      const isPasswordValid = await user.correctPassword(password);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Incorrect password'
        });
      }

      // Schedule deletion (30 days from now)
      const deletionDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      
      user.deletionRequestedAt = new Date();
      user.deletionScheduledAt = deletionDate;
      user.status = 'deleted';

      await user.save();

      // Clear user cache
      await redis.del(`user:${userId}`);

      // Send deletion confirmation email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Account Deletion Request Received',
        templateName: 'account-deletion-requested',
        templateData: {
          name: user.firstName,
          requestDate: new Date().toLocaleDateString(),
          deletionDate: deletionDate.toLocaleDateString(),
          reason: reason || 'Not specified',
          cancellationUrl: `${process.env.FRONTEND_URL}/cancel-deletion`
        }
      });

      // Log deletion request
      logger.auditLog('ACCOUNT_DELETION_REQUESTED', userId, {
        reason,
        scheduledDate: deletionDate,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Account deletion scheduled. Your account will be permanently deleted in 30 days.'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'request_account_deletion',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to request account deletion'
      });
    }
  }

  // Get user statistics
  async getUserStats(userId) {
    try {
      // Get order stats
      const orderStats = await Order.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: null,
            totalOrders: { $sum: 1 },
            totalSpent: { $sum: '$payment.amount.total' },
            averageOrderValue: { $avg: '$payment.amount.total' },
            lastOrderDate: { $max: '$timeline.placedAt' }
          }
        }
      ]);

      // Get review stats
      const reviewStats = await Review.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $group: {
            _id: null,
            totalReviews: { $sum: 1 },
            averageRating: { $avg: '$rating' }
          }
        }
      ]);

      // Get wishlist count
      const user = await User.findById(userId).select('wishlist').lean();
      const wishlistCount = user?.wishlist?.length || 0;

      return {
        orders: orderStats[0] || {
          totalOrders: 0,
          totalSpent: 0,
          averageOrderValue: 0,
          lastOrderDate: null
        },
        reviews: reviewStats[0] || {
          totalReviews: 0,
          averageRating: 0
        },
        wishlist: {
          count: wishlistCount
        }
      };
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_user_stats',
        userId
      });
      return null;
    }
  }

  // Helper method to get next loyalty tier
  getNextTier(currentPoints, currentTier) {
    const tiers = [
      { name: 'bronze', minPoints: 0, maxPoints: 499 },
      { name: 'silver', minPoints: 500, maxPoints: 1999 },
      { name: 'gold', minPoints: 2000, maxPoints: 4999 },
      { name: 'platinum', minPoints: 5000, maxPoints: 9999 },
      { name: 'diamond', minPoints: 10000, maxPoints: Infinity }
    ];

    const currentTierIndex = tiers.findIndex(t => t.name === currentTier);
    
    if (currentTierIndex < tiers.length - 1) {
      const nextTier = tiers[currentTierIndex + 1];
      const pointsNeeded = nextTier.minPoints - currentPoints;
      
      return {
        name: nextTier.name,
        pointsNeeded: Math.max(0, pointsNeeded),
        minPoints: nextTier.minPoints
      };
    }

    return null;
  }
}

module.exports = new UserController();
