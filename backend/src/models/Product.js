const mongoose = require('mongoose');
const mongoosePaginate = require('mongoose-paginate-v2');

const productSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: [200, 'Product name cannot exceed 200 characters']
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    lowercase: true
  },
  description: {
    type: String,
    required: [true, 'Product description is required'],
    maxlength: [2000, 'Description cannot exceed 2000 characters']
  },
  price: {
    original: {
      type: Number,
      required: [true, 'Original price is required'],
      min: [0, 'Price must be positive']
    },
    discounted: {
      type: Number,
      min: [0, 'Discounted price must be positive']
    },
    currency: {
      type: String,
      default: 'USD',
      enum: ['USD', 'EUR', 'GBP', 'INR', 'CNY']
    }
  },
  category: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category',
    required: true
  },
  subcategory: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Category'
  },
  images: [{
    url: String,
    alt: String,
    isPrimary: Boolean
  }],
  variants: [{
    sku: {
      type: String,
      required: true,
      unique: true
    },
    attributes: {
      color: String,
      size: String,
      material: String
    },
    stock: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    priceAdjustment: {
      type: Number,
      default: 0
    }
  }],
  specifications: {
    weight: Number,
    dimensions: {
      length: Number,
      width: Number,
      height: Number
    },
    brand: String,
    manufacturer: String,
    warranty: String
  },
  ratings: {
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
  reviews: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5
    },
    comment: String,
    images: [String],
    helpful: {
      count: Number,
      users: [mongoose.Schema.Types.ObjectId]
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  shipping: {
    weight: Number,
    dimensions: String,
    freeShipping: {
      type: Boolean,
      default: false
    },
    estimatedDelivery: {
      minDays: Number,
      maxDays: Number
    }
  },
  tags: [String],
  seo: {
    title: String,
    description: String,
    keywords: [String]
  },
  status: {
    type: String,
    enum: ['draft', 'active', 'out_of_stock', 'discontinued'],
    default: 'draft'
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  discount: {
    percentage: {
      type: Number,
      min: 0,
      max: 100
    },
    amount: Number,
    validUntil: Date
  },
  metadata: {
    views: {
      type: Number,
      default: 0
    },
    purchases: {
      type: Number,
      default: 0
    },
    wishlistCount: {
      type: Number,
      default: 0
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
productSchema.index({ name: 'text', description: 'text', tags: 'text' });
productSchema.index({ category: 1, status: 1, 'price.discounted': 1 });
productSchema.index({ 'metadata.views': -1 });
productSchema.index({ 'metadata.purchases': -1 });
productSchema.index({ createdAt: -1 });

// Virtual for current price
productSchema.virtual('currentPrice').get(function() {
  if (this.discount && this.discount.validUntil > new Date()) {
    if (this.discount.percentage) {
      return this.price.original * (1 - this.discount.percentage / 100);
    }
    if (this.discount.amount) {
      return this.price.original - this.discount.amount;
    }
  }
  return this.price.discounted || this.price.original;
});

// Middleware for slug generation
productSchema.pre('save', function(next) {
  if (!this.slug) {
    this.slug = this.name
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/--+/g, '-');
  }
  next();
});

productSchema.plugin(mongoosePaginate);

module.exports = mongoose.model('Product', productSchema);
