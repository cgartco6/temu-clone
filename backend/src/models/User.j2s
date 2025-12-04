const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Invalid email format']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [8, 'Password must be at least 8 characters'],
    select: false
  },
  profile: {
    firstName: String,
    lastName: String,
    phone: String,
    avatar: String,
    dateOfBirth: Date,
    gender: {
      type: String,
      enum: ['male', 'female', 'other']
    }
  },
  addresses: [{
    type: {
      type: String,
      enum: ['home', 'work', 'other'],
      default: 'home'
    },
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    isDefault: Boolean
  }],
  preferences: {
    language: {
      type: String,
      default: 'en'
    },
    currency: {
      type: String,
      default: 'USD'
    },
    notifications: {
      email: {
        type: Boolean,
        default: true
      },
      sms: {
        type: Boolean,
        default: false
      },
      push: {
        type: Boolean,
        default: true
      }
    },
    theme: {
      type: String,
      enum: ['light', 'dark', 'auto'],
      default: 'auto'
    }
  },
  wallet: {
    balance: {
      type: Number,
      default: 0,
      min: 0
    },
    transactions: [{
      type: {
        type: String,
        enum: ['credit', 'debit', 'refund']
      },
      amount: Number,
      description: String,
      reference: String,
      date: {
        type: Date,
        default: Date.now
      }
    }]
  },
  loyalty: {
    points: {
      type: Number,
      default: 0
    },
    tier: {
      type: String,
      enum: ['bronze', 'silver', 'gold', 'platinum'],
      default: 'bronze'
    },
    history: [{
      points: Number,
      reason: String,
      date: Date
    }]
  },
  social: {
    googleId: String,
    facebookId: String,
    appleId: String
  },
  verification: {
    email: {
      verified: {
        type: Boolean,
        default: false
      },
      token: String,
      expires: Date
    },
    phone: {
      verified: {
        type: Boolean,
        default: false
      },
      code: String,
      expires: Date
    },
    identity: {
      verified: Boolean,
      documents: [{
        type: String,
        url: String,
        status: {
          type: String,
          enum: ['pending', 'approved', 'rejected'],
          default: 'pending'
        }
      }]
    }
  },
  security: {
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },
    twoFactorSecret: String,
    lastPasswordChange: Date,
    loginHistory: [{
      ip: String,
      userAgent: String,
      timestamp: Date,
      location: String,
      success: Boolean
    }]
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'suspended', 'banned'],
    default: 'active'
  },
  role: {
    type: String,
    enum: ['customer', 'vendor', 'moderator', 'admin', 'superadmin'],
    default: 'customer'
  },
  metadata: {
    registrationSource: {
      type: String,
      enum: ['web', 'mobile', 'social']
    },
    lastLogin: Date,
    loginCount: {
      type: Number,
      default: 0
    },
    cart: [{
      product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
      },
      variant: String,
      quantity: Number,
      addedAt: Date
    }],
    wishlist: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      addedAt: Date
    }],
    viewedProducts: [{
      product: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Product'
      },
      timestamp: Date,
      count: Number
    }]
  }
}, {
  timestamps: true,
  toJSON: {
    virtuals: true,
    transform: function(doc, ret) {
      delete ret.password;
      delete ret.security;
      return ret;
    }
  }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    this.security.lastPasswordChange = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Generate JWT token
userSchema.methods.generateAuthToken = function() {
  return jwt.sign(
    {
      userId: this._id,
      email: this.email,
      role: this.role
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d'
    }
  );
};

// Generate refresh token
userSchema.methods.generateRefreshToken = function() {
  return jwt.sign(
    { userId: this._id },
    process.env.JWT_REFRESH_SECRET,
    {
      expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d'
    }
  );
};

// Virtual for full name
userSchema.virtual('fullName').get(function() {
  return `${this.profile.firstName || ''} ${this.profile.lastName || ''}`.trim();
});

module.exports = mongoose.model('User', userSchema);
