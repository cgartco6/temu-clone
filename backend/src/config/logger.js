const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

// Ensure log directory exists
const logDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}

// Define log format
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Define console format
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message}`
  )
);

// Create logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  defaultMeta: { service: 'temu-backend' },
  transports: [
    // Console transport
    new winston.transports.Console({
      format: consoleFormat,
      level: 'debug'
    }),
    
    // Daily rotate file for all logs
    new DailyRotateFile({
      filename: path.join(logDir, 'combined-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'info'
    }),
    
    // Daily rotate file for errors
    new DailyRotateFile({
      filename: path.join(logDir, 'error-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error'
    }),
    
    // Daily rotate file for HTTP requests
    new DailyRotateFile({
      filename: path.join(logDir, 'http-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'http'
    })
  ],
  exceptionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d'
    })
  ],
  rejectionHandlers: [
    new DailyRotateFile({
      filename: path.join(logDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d'
    })
  ]
});

// Add stream for Morgan HTTP logging
logger.stream = {
  write: (message) => {
    logger.http(message.trim());
  }
};

// Custom logging methods
logger.requestLog = (req, res, responseTime) => {
  const logData = {
    method: req.method,
    url: req.originalUrl,
    status: res.statusCode,
    responseTime: `${responseTime}ms`,
    ip: req.ip,
    userAgent: req.get('user-agent'),
    userId: req.user ? req.user._id : null,
    query: Object.keys(req.query).length > 0 ? req.query : undefined,
    body: req.method !== 'GET' ? req.body : undefined
  };
  
  if (res.statusCode >= 400) {
    logger.warn('HTTP Request', logData);
  } else {
    logger.info('HTTP Request', logData);
  }
};

logger.errorWithContext = (error, context = {}) => {
  logger.error({
    message: error.message,
    stack: error.stack,
    ...context
  });
};

logger.auditLog = (action, userId, details = {}) => {
  logger.info('AUDIT_LOG', {
    action,
    userId,
    timestamp: new Date().toISOString(),
    details
  });
};

// Log uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.errorWithContext(error, { type: 'uncaughtException' });
  process.exit(1);
});

// Log unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error({
    message: 'Unhandled Rejection',
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined,
    promise: promise
  });
});

// Export the logger
module.exports = logger;
