const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const validator = require('validator');

const userSchema = new mongoose.Schema({
  // Basic Information
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    validate: [validator.isEmail, 'Please provide a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
    maxlength: [50, 'First name cannot exceed 50 characters']
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
    maxlength: [50, 'Last name cannot exceed 50 characters']
  },
  phone: {
    type: String,
    validate: {
      validator: function(v) {
        return /^\+?[\d\s\-\(\)]+$/.test(v);
      },
      message: 'Please provide a valid phone number'
    }
  },
  avatar: {
    url: String,
    publicId: String,
    thumbnailUrl: String
  },
  dateOfBirth: {
    type: Date,
    validate: {
      validator: function(v) {
        return v <= new Date();
      },
      message: 'Date of birth cannot be in the future'
    }
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'prefer-not-to-say']
  },

  // Authentication & Security
  role: {
    type: String,
    enum: ['customer', 'vendor', 'admin', 'superadmin'],
    default: 'customer'
  },
  isEmailVerified: {
    type: Boolean,
    default: false
  },
  isPhoneVerified: {
    type: Boolean,
    default: false
  },
  twoFactorEnabled: {
    type: Boolean,
    default: false
  },
  twoFactorSecret: {
    type: String,
    select: false
  },
  loginAttempts: {
    type: Number,
    default: 0,
    select: false
  },
  lockUntil: {
    type: Date,
    select: false
  },
  passwordChangedAt: Date,
  passwordResetToken: String,
  passwordResetExpires: Date,
  emailVerificationToken: String,
  emailVerificationExpires: Date,

  // Social Login
  socialLogin: {
    googleId: String,
    facebookId: String,
    appleId: String,
    githubId: String
  },

  // Addresses
  addresses: [{
    type: {
      type: String,
      enum: ['home', 'work', 'billing', 'other'],
      default: 'home'
    },
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    isDefault: {
      type: Boolean,
      default: false
    },
    coordinates: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point'
      },
      coordinates: [Number] // [longitude, latitude]
    }
  }],

  // Preferences
  preferences: {
    language: {
      type: String,
      default: 'en',
      enum: ['en', 'es', 'fr', 'de', 'zh', 'ja', 'ko']
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'INR']
    },
    timezone: {
      type: String,
      default: 'UTC'
    },
    notifications: {
      email: {
        promotions: { type: Boolean, default: true },
        orderUpdates: { type: Boolean, default: true },
        priceAlerts: { type: Boolean, default: false },
        newsletter: { type: Boolean, default: true }
      },
      push: {
        orderUpdates: { type: Boolean, default: true },
        promotions: { type: Boolean, default: false },
        priceAlerts: { type: Boolean, default: true }
      },
      sms: {
        orderUpdates: { type: Boolean, default: false },
        securityAlerts: { type: Boolean, default: true }
      }
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'auto'
    }
  },

  // Wallet & Loyalty
  wallet: {
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    currency: {
      type: String,
      default: 'USD'
    },
    transactions: [{
      type: {
        type: String,
        enum: ['credit', 'debit', 'refund', 'cashback', 'referral']
      },
      amount: Number,
      description: String,
      referenceId: String,
      status: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'cancelled'],
        default: 'pending'
      },
      createdAt: {
        type: Date,
        default: Date.now
      }
    }]
  },
  loyaltyPoints: {
    type: Number,
    default: 0,
    min: 0
  },
  loyaltyTier: {
    type: String,
    enum: ['bronze', 'silver', 'gold', 'platinum', 'diamond'],
    default: 'bronze'
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  referrals: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    earnedPoints: Number,
    date: Date
  }],

  // Activity Tracking
  lastLogin: Date,
  lastActivity: Date,
  loginHistory: [{
    ip: String,
    userAgent: String,
    location: {
      country: String,
      city: String,
      region: String
    },
    timestamp: Date,
    successful: Boolean
  }],
  deviceTokens: [{
    token: String,
    platform: {
      type: String,
      enum: ['ios', 'android', 'web']
    },
    lastUsed: Date
  }],

  // Shopping Behavior
  cart: {
    items: [{
      product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
      },
      variant: {
        sku: String,
        color: String,
        size: String
      },
      quantity: {
        type: Number,
        min: 1,
        default: 1
      },
      price: Number,
      addedAt: {
        type: Date,
        default: Date.now
      }
    }],
    lastUpdated: Date
  },
  wishlist: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    addedAt: {
      type: Date,
      default: Date.now
    }
  }],
  recentlyViewed: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product'
    },
    viewedAt: {
      type: Date,
      default: Date.now
    },
    count: {
      type: Number,
      default: 1
    }
  }],
  searchHistory: [{
    query: String,
    count: {
      type: Number,
      default: 1
    },
    lastSearched: {
      type: Date,
      default: Date.now
    }
  }],

  // Vendor-specific fields (if role is vendor)
  vendorProfile: {
    businessName: String,
    businessType: {
      type: String,
      enum: ['individual', 'company', 'partnership']
    },
    taxId: String,
    registrationNumber: String,
    description: String,
    website: String,
    socialMedia: {
      facebook: String,
      twitter: String,
      instagram: String,
      linkedin: String
    },
    bankDetails: {
      accountName: String,
      accountNumber: String,
      bankName: String,
      branchCode: String,
      swiftCode: String
    },
    documents: [{
      type: {
        type: String,
        enum: ['id', 'license', 'certificate', 'other']
      },
      url: String,
      verified: {
        type: Boolean,
        default: false
      }
    }],
    rating: {
      average: {
        type: Number,
        default: 0,
        min: 0,
        max: 5
      },
      count: {
        type: Number,
        default: 0
      }
    },
    totalSales: {
      type: Number,
      default: 0
    },
    commissionRate: {
      type: Number,
      default: 10,
      min: 0,
      max: 100
    }
  },

  // Status
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended', 'banned', 'deleted'],
    default: 'active'
  },
  deactivatedAt: Date,
  deletionRequestedAt: Date,
  deletionScheduledAt: Date,

  // Metadata
  metadata: {
    registrationSource: {
      type: String,
      enum: ['web', 'mobile', 'social-google', 'social-facebook', 'social-apple', 'api']
    },
    marketingConsent: {
      type: Boolean,
      default: false
    },
    privacyConsent: {
      type: Boolean,
      default: false
    },
    termsAccepted: {
      type: Boolean,
      default: false
    },
    cookieConsent: {
      type: Boolean,
      default: false
    }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes
userSchema.index({ email: 1 });
userSchema.index({ role: 1, status: 1 });
userSchema.index({ 'addresses.coordinates': '2dsphere' });
userSchema.index({ referralCode: 1 }, { sparse: true });
userSchema.index({ 'socialLogin.googleId': 1 }, { sparse: true });
userSchema.index({ 'socialLogin.facebookId': 1 }, { sparse: true });
userSchema.index({ 'socialLogin.appleId': 1 }, { sparse: true });
userSchema.index({ createdAt: -1 });
userSchema.index({ loyaltyPoints: -1 });
userSchema.index({ 'preferences.language': 1 });
userSchema.index({ 'preferences.currency': 1 });

// Virtuals
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`.trim();
});

userSchema.virtual('isLocked').get(function() {
  return !!(this.lockUntil && this.lockUntil > Date.now());
});

userSchema.virtual('orders', {
  ref: 'Order',
  localField: '_id',
  foreignField: 'user'
});

userSchema.virtual('reviews', {
  ref: 'Review',
  localField: '_id',
  foreignField: 'user'
});

// Pre-save middleware
userSchema.pre('save', async function(next) {
  // Hash password if modified
  if (this.isModified('password')) {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    this.passwordChangedAt = Date.now() - 1000;
  }

  // Generate referral code if not exists
  if (!this.referralCode && this.role === 'customer') {
    this.referralCode = crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  // Set vendor-specific defaults
  if (this.role === 'vendor' && !this.vendorProfile) {
    this.vendorProfile = {
      rating: { average: 0, count: 0 },
      totalSales: 0,
      commissionRate: 10
    };
  }

  next();
});

userSchema.pre('save', function(next) {
  // Update lastActivity on certain changes
  if (this.isModified('lastLogin') || 
      this.isModified('cart') || 
      this.isModified('wishlist')) {
    this.lastActivity = new Date();
  }
  next();
});

// Methods
userSchema.methods.correctPassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

userSchema.methods.changedPasswordAfter = function(JWTTimestamp) {
  if (this.passwordChangedAt) {
    const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10);
    return JWTTimestamp < changedTimestamp;
  }
  return false;
};

userSchema.methods.createPasswordResetToken = function() {
  const resetToken = crypto.randomBytes(32).toString('hex');
  this.passwordResetToken = crypto
    .createHash('sha256')
    .update(resetToken)
    .digest('hex');
  this.passwordResetExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
  return resetToken;
};

userSchema.methods.createEmailVerificationToken = function() {
  const verificationToken = crypto.randomBytes(32).toString('hex');
  this.emailVerificationToken = crypto
    .createHash('sha256')
    .update(verificationToken)
    .digest('hex');
  this.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  return verificationToken;
};

userSchema.methods.generateAuthToken = function() {
  return jwt.sign(
    { id: this._id, role: this.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN }
  );
};

userSchema.methods.generateRefreshToken = function() {
  return jwt.sign(
    { id: this._id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN }
  );
};

userSchema.methods.addToCart = function(productId, variant, quantity = 1) {
  const cartItemIndex = this.cart.items.findIndex(item => 
    item.product.toString() === productId.toString() && 
    item.variant.sku === variant.sku
  );

  if (cartItemIndex > -1) {
    this.cart.items[cartItemIndex].quantity += quantity;
    this.cart.items[cartItemIndex].addedAt = new Date();
  } else {
    this.cart.items.push({
      product: productId,
      variant: variant,
      quantity: quantity,
      addedAt: new Date()
    });
  }
  
  this.cart.lastUpdated = new Date();
};

userSchema.methods.removeFromCart = function(productId, variantSku) {
  this.cart.items = this.cart.items.filter(item => 
    !(item.product.toString() === productId.toString() && 
      item.variant.sku === variantSku)
  );
  this.cart.lastUpdated = new Date();
};

userSchema.methods.clearCart = function() {
  this.cart.items = [];
  this.cart.lastUpdated = new Date();
};

userSchema.methods.addToWishlist = function(productId) {
  if (!this.wishlist.some(item => item.product.toString() === productId.toString())) {
    this.wishlist.push({
      product: productId,
      addedAt: new Date()
    });
  }
};

userSchema.methods.removeFromWishlist = function(productId) {
  this.wishlist = this.wishlist.filter(item => 
    item.product.toString() !== productId.toString()
  );
};

userSchema.methods.trackView = function(productId) {
  const viewedIndex = this.recentlyViewed.findIndex(item => 
    item.product.toString() === productId.toString()
  );

  if (viewedIndex > -1) {
    this.recentlyViewed[viewedIndex].count += 1;
    this.recentlyViewed[viewedIndex].viewedAt = new Date();
  } else {
    this.recentlyViewed.unshift({
      product: productId,
      viewedAt: new Date(),
      count: 1
    });

    // Keep only last 50 viewed items
    if (this.recentlyViewed.length > 50) {
      this.recentlyViewed.pop();
    }
  }
};

userSchema.methods.trackSearch = function(query) {
  const searchIndex = this.searchHistory.findIndex(item => 
    item.query.toLowerCase() === query.toLowerCase()
  );

  if (searchIndex > -1) {
    this.searchHistory[searchIndex].count += 1;
    this.searchHistory[searchIndex].lastSearched = new Date();
  } else {
    this.searchHistory.unshift({
      query: query,
      count: 1,
      lastSearched: new Date()
    });

    // Keep only last 100 searches
    if (this.searchHistory.length > 100) {
      this.searchHistory.pop();
    }
  }
};

userSchema.methods.addWalletTransaction = function(type, amount, description, referenceId) {
  this.wallet.transactions.push({
    type,
    amount,
    description,
    referenceId,
    status: 'completed',
    createdAt: new Date()
  });

  if (type === 'credit' || type === 'refund' || type === 'cashback' || type === 'referral') {
    this.wallet.balance += amount;
  } else if (type === 'debit') {
    this.wallet.balance -= amount;
  }
};

userSchema.methods.updateLoyaltyPoints = function(points, action = 'add') {
  if (action === 'add') {
    this.loyaltyPoints += points;
  } else if (action === 'subtract') {
    this.loyaltyPoints = Math.max(0, this.loyaltyPoints - points);
  }

  // Update loyalty tier
  if (this.loyaltyPoints >= 10000) {
    this.loyaltyTier = 'diamond';
  } else if (this.loyaltyPoints >= 5000) {
    this.loyaltyTier = 'platinum';
  } else if (this.loyaltyPoints >= 2000) {
    this.loyaltyTier = 'gold';
  } else if (this.loyaltyPoints >= 500) {
    this.loyaltyTier = 'silver';
  } else {
    this.loyaltyTier = 'bronze';
  }
};

userSchema.methods.addLoginAttempt = function(successful, ip, userAgent, location) {
  this.loginHistory.push({
    ip,
    userAgent,
    location,
    timestamp: new Date(),
    successful
  });

  if (!successful) {
    this.loginAttempts += 1;
    
    if (this.loginAttempts >= 5) {
      // Lock account for 15 minutes
      this.lockUntil = Date.now() + 15 * 60 * 1000;
    }
  } else {
    this.loginAttempts = 0;
    this.lockUntil = undefined;
    this.lastLogin = new Date();
  }

  // Keep only last 50 login attempts
  if (this.loginHistory.length > 50) {
    this.loginHistory = this.loginHistory.slice(-50);
  }
};

userSchema.methods.getDefaultAddress = function() {
  return this.addresses.find(addr => addr.isDefault) || this.addresses[0];
};

userSchema.methods.toJSON = function() {
  const obj = this.toObject();
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.loginAttempts;
  delete obj.lockUntil;
  delete obj.passwordResetToken;
  delete obj.passwordResetExpires;
  delete obj.emailVerificationToken;
  delete obj.emailVerificationExpires;
  delete obj.__v;
  return obj;
};

// Static methods
userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase() });
};

userSchema.statics.findByReferralCode = function(code) {
  return this.findOne({ referralCode: code.toUpperCase() });
};

userSchema.statics.findBySocialId = function(provider, id) {
  const field = `socialLogin.${provider}Id`;
  return this.findOne({ [field]: id });
};

userSchema.statics.getTopCustomers = function(limit = 10) {
  return this.aggregate([
    { $match: { role: 'customer', status: 'active' } },
    {
      $lookup: {
        from: 'orders',
        localField: '_id',
        foreignField: 'user',
        as: 'orders'
      }
    },
    {
      $addFields: {
        totalSpent: { $sum: '$orders.totalAmount' },
        orderCount: { $size: '$orders' }
      }
    },
    { $sort: { totalSpent: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 1,
        email: 1,
        firstName: 1,
        lastName: 1,
        totalSpent: 1,
        orderCount: 1,
        loyaltyPoints: 1,
        loyaltyTier: 1,
        lastLogin: 1
      }
    }
  ]);
};

userSchema.statics.getUserStats = function() {
  return this.aggregate([
    {
      $facet: {
        totalUsers: [
          { $count: 'count' }
        ],
        usersByRole: [
          { $group: { _id: '$role', count: { $sum: 1 } } }
        ],
        usersByStatus: [
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ],
        newUsersLast30Days: [
          { 
            $match: { 
              createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } 
            } 
          },
          {
            $group: {
              _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              count: { $sum: 1 }
            }
          },
          { $sort: { _id: 1 } }
        ],
        usersByCountry: [
          { $unwind: '$addresses' },
          { $match: { 'addresses.isDefault': true } },
          { $group: { _id: '$addresses.country', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 10 }
        ]
      }
    }
  ]);
};

module.exports = mongoose.model('User', userSchema);
