const { createClient } = require('redis');
const logger = require('./logger');

class RedisClient {
  constructor() {
    this.client = null;
    this.isReady = false;
    this.connect();
  }

  async connect() {
    try {
      const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
      
      this.client = createClient({
        url: redisUrl,
        password: process.env.REDIS_PASSWORD,
        socket: {
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              logger.error('Too many retries on redis. Connection terminated');
              return new Error('Too many retries');
            }
            return Math.min(retries * 100, 3000);
          }
        }
      });

      this.client.on('connect', () => {
        logger.info('Redis client connecting...');
      });

      this.client.on('ready', () => {
        this.isReady = true;
        logger.info('Redis client ready');
      });

      this.client.on('end', () => {
        this.isReady = false;
        logger.warn('Redis client disconnected');
      });

      this.client.on('error', (err) => {
        logger.error('Redis client error:', err);
      });

      this.client.on('reconnecting', () => {
        logger.info('Redis client reconnecting...');
      });

      await this.client.connect();

    } catch (error) {
      logger.error('Redis connection failed:', error);
      this.isReady = false;
      
      // Retry connection after 5 seconds
      setTimeout(() => this.connect(), 5000);
    }
  }

  async get(key) {
    if (!this.isReady) return null;
    
    try {
      const value = await this.client.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error(`Redis GET error for key ${key}:`, error);
      return null;
    }
  }

  async set(key, value, ttl = 3600) {
    if (!this.isReady) return false;
    
    try {
      await this.client.set(key, JSON.stringify(value), {
        EX: ttl
      });
      return true;
    } catch (error) {
      logger.error(`Redis SET error for key ${key}:`, error);
      return false;
    }
  }

  async del(key) {
    if (!this.isReady) return false;
    
    try {
      await this.client.del(key);
      return true;
    } catch (error) {
      logger.error(`Redis DEL error for key ${key}:`, error);
      return false;
    }
  }

  async exists(key) {
    if (!this.isReady) return false;
    
    try {
      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error(`Redis EXISTS error for key ${key}:`, error);
      return false;
    }
  }

  async incr(key) {
    if (!this.isReady) return null;
    
    try {
      return await this.client.incr(key);
    } catch (error) {
      logger.error(`Redis INCR error for key ${key}:`, error);
      return null;
    }
  }

  async decr(key) {
    if (!this.isReady) return null;
    
    try {
      return await this.client.decr(key);
    } catch (error) {
      logger.error(`Redis DECR error for key ${key}:`, error);
      return null;
    }
  }

  async expire(key, ttl) {
    if (!this.isReady) return false;
    
    try {
      await this.client.expire(key, ttl);
      return true;
    } catch (error) {
      logger.error(`Redis EXPIRE error for key ${key}:`, error);
      return false;
    }
  }

  async ttl(key) {
    if (!this.isReady) return null;
    
    try {
      return await this.client.ttl(key);
    } catch (error) {
      logger.error(`Redis TTL error for key ${key}:`, error);
      return null;
    }
  }

  async keys(pattern) {
    if (!this.isReady) return [];
    
    try {
      return await this.client.keys(pattern);
    } catch (error) {
      logger.error(`Redis KEYS error for pattern ${pattern}:`, error);
      return [];
    }
  }

  async flush(pattern = '*') {
    if (!this.isReady) return false;
    
    try {
      const keys = await this.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
      return true;
    } catch (error) {
      logger.error(`Redis FLUSH error for pattern ${pattern}:`, error);
      return false;
    }
  }

  async hset(key, field, value) {
    if (!this.isReady) return false;
    
    try {
      await this.client.hSet(key, field, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error(`Redis HSET error for key ${key}, field ${field}:`, error);
      return false;
    }
  }

  async hget(key, field) {
    if (!this.isReady) return null;
    
    try {
      const value = await this.client.hGet(key, field);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      logger.error(`Redis HGET error for key ${key}, field ${field}:`, error);
      return null;
    }
  }

  async hdel(key, field) {
    if (!this.isReady) return false;
    
    try {
      await this.client.hDel(key, field);
      return true;
    } catch (error) {
      logger.error(`Redis HDEL error for key ${key}, field ${field}:`, error);
      return false;
    }
  }

  async hgetall(key) {
    if (!this.isReady) return {};
    
    try {
      const result = await this.client.hGetAll(key);
      const parsed = {};
      
      for (const [field, value] of Object.entries(result)) {
        parsed[field] = JSON.parse(value);
      }
      
      return parsed;
    } catch (error) {
      logger.error(`Redis HGETALL error for key ${key}:`, error);
      return {};
    }
  }

  async publish(channel, message) {
    if (!this.isReady) return false;
    
    try {
      await this.client.publish(channel, JSON.stringify(message));
      return true;
    } catch (error) {
      logger.error(`Redis PUBLISH error for channel ${channel}:`, error);
      return false;
    }
  }

  async subscribe(channel, callback) {
    if (!this.isReady) return null;
    
    try {
      const subscriber = this.client.duplicate();
      await subscriber.connect();
      
      await subscriber.subscribe(channel, (message) => {
        callback(JSON.parse(message));
      });
      
      return subscriber;
    } catch (error) {
      logger.error(`Redis SUBSCRIBE error for channel ${channel}:`, error);
      return null;
    }
  }

  async disconnect() {
    if (this.client && this.isReady) {
      await this.client.quit();
      this.isReady = false;
      logger.info('Redis client disconnected');
    }
  }

  async ping() {
    if (!this.isReady) return false;
    
    try {
      const result = await this.client.ping();
      return result === 'PONG';
    } catch (error) {
      return false;
    }
  }

  async getStats() {
    if (!this.isReady) return null;
    
    try {
      const info = await this.client.info();
      const lines = info.split('\r\n');
      const stats = {};
      
      for (const line of lines) {
        if (line.includes(':')) {
          const [key, value] = line.split(':');
          stats[key] = value;
        }
      }
      
      return {
        connected_clients: stats.connected_clients,
        used_memory_human: stats.used_memory_human,
        total_connections_received: stats.total_connections_received,
        total_commands_processed: stats.total_commands_processed,
        instantaneous_ops_per_sec: stats.instantaneous_ops_per_sec,
        keyspace_hits: stats.keyspace_hits,
        keyspace_misses: stats.keyspace_misses,
        uptime_in_seconds: stats.uptime_in_seconds
      };
    } catch (error) {
      logger.error('Failed to get Redis stats:', error);
      return null;
    }
  }
}

module.exports = new RedisClient();
