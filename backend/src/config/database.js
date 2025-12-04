const mongoose = require('mongoose');
const logger = require('./logger');

class Database {
  constructor() {
    this.connect();
  }

  async connect() {
    try {
      const mongoUri = process.env.NODE_ENV === 'test' 
        ? process.env.MONGODB_TEST_URI 
        : process.env.MONGODB_URI;

      if (!mongoUri) {
        throw new Error('MongoDB URI is not defined in environment variables');
      }

      const options = {
        useNewUrlParser: true,
        useUnifiedTopology: true,
        serverSelectionTimeoutMS: 5000,
        socketTimeoutMS: 45000,
        maxPoolSize: 10,
        minPoolSize: 5,
        retryWrites: true,
        w: 'majority'
      };

      await mongoose.connect(mongoUri, options);

      logger.info('MongoDB connected successfully');

      // Set up connection events
      mongoose.connection.on('connected', () => {
        logger.info('Mongoose connected to DB');
      });

      mongoose.connection.on('error', (err) => {
        logger.error('Mongoose connection error:', err);
      });

      mongoose.connection.on('disconnected', () => {
        logger.warn('Mongoose disconnected from DB');
      });

      // Graceful shutdown
      process.on('SIGINT', async () => {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed through app termination');
        process.exit(0);
      });

    } catch (error) {
      logger.error('MongoDB connection error:', error);
      
      // Retry connection
      setTimeout(() => {
        this.connect();
      }, 5000);
    }
  }

  async disconnect() {
    try {
      await mongoose.disconnect();
      logger.info('MongoDB disconnected successfully');
    } catch (error) {
      logger.error('MongoDB disconnect error:', error);
    }
  }

  async clearDatabase() {
    if (process.env.NODE_ENV === 'test') {
      const collections = mongoose.connection.collections;
      for (const key in collections) {
        await collections[key].deleteMany({});
      }
    }
  }

  async isConnected() {
    return mongoose.connection.readyState === 1;
  }

  async getStats() {
    try {
      const adminDb = mongoose.connection.db.admin();
      const serverStatus = await adminDb.serverStatus();
      const dbStats = await mongoose.connection.db.stats();
      
      return {
        connections: serverStatus.connections,
        memory: serverStatus.mem,
        network: serverStatus.network,
        operations: serverStatus.opcounters,
        database: {
          collections: dbStats.collections,
          objects: dbStats.objects,
          avgObjSize: dbStats.avgObjSize,
          dataSize: dbStats.dataSize,
          storageSize: dbStats.storageSize,
          indexes: dbStats.indexes,
          indexSize: dbStats.indexSize
        }
      };
    } catch (error) {
      logger.error('Failed to get database stats:', error);
      return null;
    }
  }
}

module.exports = new Database();
