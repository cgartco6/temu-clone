const database = require('./database');
const redis = require('./redis');
const logger = require('./logger');
const upload = require('./upload');
const email = require('./email');
const payment = require('./payment');

module.exports = {
  database,
  redis,
  logger,
  upload,
  email,
  payment,
  
  // Environment variables
  env: process.env.NODE_ENV || 'development',
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET,
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET,
  
  // API Configuration
  api: {
    prefix: '/api/v1',
    rateLimit: {
      windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900000,
      max: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100
    }
  },
  
  // Security Configuration
  security: {
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    helmet: {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          fontSrc: ["'self'", "https://fonts.gstatic.com"],
          imgSrc: ["'self'", "data:", "https:"],
          connectSrc: ["'self'", process.env.FRONTEND_URL]
        }
      }
    }
  },
  
  // Upload Configuration
  uploadConfig: {
    maxFileSize: parseInt(process.env.UPLOAD_LIMIT) || 10485760,
    allowedTypes: process.env.ALLOWED_FILE_TYPES?.split(',') || [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp'
    ]
  },
  
  // Email Configuration
  emailConfig: {
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    from: process.env.EMAIL_FROM,
    fromName: process.env.EMAIL_FROM_NAME
  },
  
  // Payment Configuration
  paymentConfig: {
    stripe: {
      secretKey: process.env.STRIPE_SECRET_KEY,
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET
    },
    paypal: {
      clientId: process.env.PAYPAL_CLIENT_ID,
      secret: process.env.PAYPAL_SECRET,
      mode: process.env.PAYPAL_MODE || 'sandbox'
    }
  },
  
  // AI Configuration
  aiConfig: {
    openaiApiKey: process.env.OPENAI_API_KEY,
    recommendationUrl: process.env.RECOMMENDATION_API_URL,
    fraudDetectionUrl: process.env.FRAUD_DETECTION_API_URL,
    chatbotUrl: process.env.CHATBOT_API_URL
  },
  
  // Shipping Configuration
  shippingConfig: {
    shippoApiKey: process.env.SHIPPO_API_KEY,
    easypostApiKey: process.env.EASYPOST_API_KEY,
    defaultCarrier: 'ups',
    defaultService: 'ground'
  },
  
  // Cache Configuration
  cacheConfig: {
    ttl: parseInt(process.env.CACHE_TTL) || 3600,
    enabled: process.env.CACHE_ENABLED !== 'false'
  },
  
  // Logging Configuration
  loggingConfig: {
    level: process.env.LOG_LEVEL || 'info',
    file: {
      maxSize: '20m',
      maxFiles: '30d',
      path: './logs'
    }
  },
  
  // Get full configuration
  getAll() {
    return {
      env: this.env,
      port: this.port,
      database: {
        connected: database.isConnected()
      },
      redis: {
        connected: redis.isReady
      },
      security: this.security,
      upload: this.uploadConfig,
      email: this.emailConfig,
      payment: this.paymentConfig,
      ai: this.aiConfig,
      shipping: this.shippingConfig,
      cache: this.cacheConfig,
      logging: this.loggingConfig
    };
  },
  
  // Validate configuration
  validate() {
    const required = [
      'JWT_SECRET',
      'MONGODB_URI',
      'REDIS_URL',
      'SMTP_HOST',
      'SMTP_USER',
      'SMTP_PASS',
      'EMAIL_FROM'
    ];
    
    const missing = [];
    
    for (const key of required) {
      if (!process.env[key]) {
        missing.push(key);
      }
    }
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    return true;
  }
};
