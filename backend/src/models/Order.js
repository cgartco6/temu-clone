const mongoose = require('mongoose');

const orderSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  items: [{
    product: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      required: true
    },
    variant: {
      sku: String,
      color: String,
      size: String
    },
    quantity: {
      type: Number,
      required: true,
      min: 1
    },
    price: {
      type: Number,
      required: true
    },
    subtotal: {
      type: Number,
      required: true
    },
    tax: Number,
    discount: {
      code: String,
      amount: Number
    }
  }],
  shippingAddress: {
    fullName: String,
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String,
    phone: String,
    email: String
  },
  billingAddress: {
    sameAsShipping: {
      type: Boolean,
      default: true
    },
    fullName: String,
    street: String,
    city: String,
    state: String,
    country: String,
    postalCode: String
  },
  payment: {
    method: {
      type: String,
      enum: ['credit_card', 'debit_card', 'paypal', 'bank_transfer', 'cod', 'wallet'],
      required: true
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'refunded', 'cancelled'],
      default: 'pending'
    },
    transactionId: String,
    gateway: String,
    amount: {
      subtotal: Number,
      shipping: Number,
      tax: Number,
      discount: Number,
      total: Number
    },
    paidAt: Date
  },
  shipping: {
    method: {
      type: String,
      required: true
    },
    cost: {
      type: Number,
      required: true,
      min: 0
    },
    tracking: {
      carrier: String,
      number: String,
      url: String
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled', 'returned'],
      default: 'pending'
    },
    estimatedDelivery: {
      from: Date,
      to: Date
    },
    deliveredAt: Date
  },
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled', 'refunded'],
    default: 'pending'
  },
  notes: String,
  metadata: {
    ip: String,
    userAgent: String,
    device: String,
    referrer: String
  },
  totals: {
    items: Number,
    shipping: Number,
    tax: Number,
    discount: Number,
    grandTotal: Number
  },
  currency: {
    type: String,
    default: 'USD'
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Generate order ID
orderSchema.pre('save', function(next) {
  if (!this.orderId) {
    const timestamp = Date.now().toString();
    const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    this.orderId = `ORD-${timestamp.slice(-6)}-${random}`;
  }
  next();
});

// Update totals before save
orderSchema.pre('save', function(next) {
  this.totals = {
    items: this.items.reduce((sum, item) => sum + item.subtotal, 0),
    shipping: this.shipping.cost || 0,
    tax: this.items.reduce((sum, item) => sum + (item.tax || 0), 0),
    discount: this.items.reduce((sum, item) => sum + (item.discount?.amount || 0), 0),
    grandTotal: 0
  };
  
  this.totals.grandTotal = this.totals.items + this.totals.shipping + 
                          this.totals.tax - this.totals.discount;
  
  this.payment.amount = this.totals;
  next();
});

module.exports = mongoose.model('Order', orderSchema);
