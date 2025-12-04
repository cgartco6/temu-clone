const axios = require('axios');
const Product = require('../models/Product');
const User = require('../models/User');

class AIService {
  constructor() {
    this.openaiApiKey = process.env.OPENAI_API_KEY;
    this.recommendationModel = process.env.RECOMMENDATION_MODEL || 'recommendation-v1';
  }

  // Product recommendations
  async getPersonalizedRecommendations(userId, limit = 10) {
    try {
      const user = await User.findById(userId)
        .populate('metadata.viewedProducts.product')
        .populate('metadata.wishlist')
        .populate('metadata.cart.product');

      if (!user) {
        return this.getTrendingProducts(limit);
      }

      // Extract user preferences from behavior
      const userPreferences = this.extractUserPreferences(user);

      // Get recommendations from AI model
      const recommendations = await this.queryRecommendationModel(
        userPreferences,
        limit
      );

      // If AI fails, fallback to collaborative filtering
      if (!recommendations || recommendations.length === 0) {
        return this.getCollaborativeRecommendations(userId, limit);
      }

      // Get product details for recommendations
      const products = await Product.find({
        _id: { $in: recommendations },
        status: 'active'
      }).limit(limit);

      return products;
    } catch (error) {
      console.error('AI recommendation error:', error);
      return this.getTrendingProducts(limit);
    }
  }

  // Search with AI understanding
  async intelligentSearch(query, filters = {}, userId = null) {
    try {
      // Enhance query with AI
      const enhancedQuery = await this.enhanceSearchQuery(query);
      
      // Semantic search using embeddings
      const semanticResults = await this.semanticSearch(enhancedQuery, filters);
      
      // Personalize results if user is logged in
      if (userId) {
        const personalizedResults = await this.personalizeSearchResults(
          semanticResults,
          userId,
          enhancedQuery
        );
        return personalizedResults;
      }

      return semanticResults;
    } catch (error) {
      console.error('Intelligent search error:', error);
      // Fallback to traditional search
      return this.traditionalSearch(query, filters);
    }
  }

  // Price prediction and optimization
  async predictOptimalPrice(productId) {
    try {
      const product = await Product.findById(productId);
      if (!product) {
        throw new Error('Product not found');
      }

      const marketData = await this.fetchMarketData(product);
      const competitorPrices = await this.getCompetitorPrices(product);
      
      const optimalPrice = await this.calculateOptimalPrice(
        product,
        marketData,
        competitorPrices
      );

      return {
        currentPrice: product.price.discounted || product.price.original,
        optimalPrice,
        confidence: 0.85, // AI confidence score
        suggestions: this.generatePriceSuggestions(product, optimalPrice)
      };
    } catch (error) {
      console.error('Price prediction error:', error);
      return null;
    }
  }

  // Dynamic pricing
  async calculateDynamicPrice(productId, context = {}) {
    try {
      const { 
        demandLevel, 
        competitorPrice, 
        inventoryLevel,
        userSegment,
        timeOfDay 
      } = context;

      // AI model for dynamic pricing
      const response = await axios.post(
        `${process.env.AI_SERVICE_URL}/pricing/dynamic`,
        {
          productId,
          context: {
            demand: demandLevel || 'medium',
            competition: competitorPrice,
            inventory: inventoryLevel,
            user: userSegment,
            time: timeOfDay,
            dayOfWeek: new Date().getDay(),
            season: this.getCurrentSeason()
          }
        },
        {
          headers: { 'Authorization': `Bearer ${this.openaiApiKey}` }
        }
      );

      return response.data;
    } catch (error) {
      console.error('Dynamic pricing error:', error);
      return null;
    }
  }

  // Chatbot for customer service
  async handleChatbotQuery(query, context = {}) {
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: `You are a helpful customer service assistant for an e-commerce store. 
                       Help users with order tracking, product inquiries, returns, and general questions.
                       Keep responses concise and helpful.`
            },
            {
              role: 'user',
              content: query
            }
          ],
          context: {
            ...context,
            storeName: 'Temu Clone',
            policies: '30-day return policy, free shipping over $50'
          }
        },
        {
          headers: {
            'Authorization': `Bearer ${this.openaiApiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      return response.data.choices[0].message.content;
    } catch (error) {
      console.error('Chatbot error:', error);
      return "I'm sorry, I'm having trouble helping you right now. Please try again or contact our support team.";
    }
  }

  // Fraud detection
  async detectFraudulentActivity(data) {
    try {
      const features = this.extractFraudFeatures(data);
      
      const response = await axios.post(
        `${process.env.FRAUD_DETECTION_URL}/predict`,
        {
          features,
          model: 'fraud-detection-v2'
        }
      );

      return {
        isFraudulent: response.data.score > 0.8,
        confidence: response.data.score,
        reasons: response.data.reasons || [],
        riskLevel: this.calculateRiskLevel(response.data.score)
      };
    } catch (error) {
      console.error('Fraud detection error:', error);
      return { isFraudulent: false, confidence: 0, reasons: [] };
    }
  }

  // Helper methods
  extractUserPreferences(user) {
    const preferences = {
      categories: new Set(),
      priceRange: { min: Infinity, max: 0 },
      brands: new Set(),
      viewedProducts: user.metadata.viewedProducts.map(vp => vp.product?._id),
      wishlist: user.metadata.wishlist.map(w => w._id),
      cart: user.metadata.cart.map(c => c.product?._id),
      purchaseHistory: [] // Would come from order history
    };

    // Analyze viewed products
    user.metadata.viewedProducts.forEach(vp => {
      if (vp.product) {
        preferences.categories.add(vp.product.category);
        if (vp.product.price) {
          preferences.priceRange.min = Math.min(
            preferences.priceRange.min,
            vp.product.price.discounted || vp.product.price.original
          );
          preferences.priceRange.max = Math.max(
            preferences.priceRange.max,
            vp.product.price.discounted || vp.product.price.original
          );
        }
        if (vp.product.specifications?.brand) {
          preferences.brands.add(vp.product.specifications.brand);
        }
      }
    });

    return {
      categories: Array.from(preferences.categories),
      priceRange: {
        min: preferences.priceRange.min === Infinity ? 0 : preferences.priceRange.min,
        max: preferences.priceRange.max
      },
      brands: Array.from(preferences.brands),
      behavior: {
        viewed: preferences.viewedProducts,
        wishlist: preferences.wishlist,
        cart: preferences.cart
      }
    };
  }

  async queryRecommendationModel(preferences, limit) {
    // Implementation depends on your AI infrastructure
    // This could be a custom model, TensorFlow Serving, etc.
    
    // Mock implementation
    const recommendedProductIds = await Product.aggregate([
      { $match: { 
        category: { $in: preferences.categories },
        'price.discounted': { 
          $gte: preferences.priceRange.min * 0.8,
          $lte: preferences.priceRange.max * 1.2
        },
        status: 'active'
      }},
      { $sample: { size: limit } },
      { $project: { _id: 1 } }
    ]);

    return recommendedProductIds.map(p => p._id);
  }

  async semanticSearch(query, filters) {
    // Implement semantic search using embeddings
    // This could use OpenAI embeddings, Pinecone, etc.
    
    // Fallback to traditional search for now
    return this.traditionalSearch(query, filters);
  }

  async traditionalSearch(query, filters) {
    const searchQuery = {
      $and: [
        { status: 'active' },
        {
          $or: [
            { name: { $regex: query, $options: 'i' } },
            { description: { $regex: query, $options: 'i' } },
            { tags: { $regex: query, $options: 'i' } }
          ]
        }
      ]
    };

    // Apply filters
    if (filters.category) {
      searchQuery.$and.push({ category: filters.category });
    }
    if (filters.priceMin || filters.priceMax) {
      searchQuery.$and.push({
        $or: [
          { 'price.discounted': { 
            $gte: filters.priceMin || 0,
            $lte: filters.priceMax || 999999 
          }},
          { 'price.original': { 
            $gte: filters.priceMin || 0,
            $lte: filters.priceMax || 999999 
          }}
        ]
      });
    }

    const products = await Product.find(searchQuery)
      .sort({ 'metadata.purchases': -1, 'ratings.average': -1 })
      .limit(filters.limit || 20);

    return products;
  }

  getCurrentSeason() {
    const month = new Date().getMonth();
    if (month >= 2 && month <= 4) return 'spring';
    if (month >= 5 && month <= 7) return 'summer';
    if (month >= 8 && month <= 10) return 'fall';
    return 'winter';
  }

  extractFraudFeatures(data) {
    return {
      orderAmount: data.amount,
      orderFrequency: data.frequency,
      ipLocation: data.ipLocation,
      deviceFingerprint: data.deviceHash,
      userBehavior: data.behaviorPattern,
      paymentMethod: data.paymentMethod,
      shippingAddressMatch: data.shippingBillingMatch,
      velocity: data.orderVelocity
    };
  }

  calculateRiskLevel(score) {
    if (score > 0.8) return 'high';
    if (score > 0.5) return 'medium';
    return 'low';
  }

  async getTrendingProducts(limit) {
    return Product.find({ status: 'active' })
      .sort({ 'metadata.views': -1, 'metadata.purchases': -1 })
      .limit(limit);
  }

  async getCollaborativeRecommendations(userId, limit) {
    // Implement collaborative filtering
    // This would analyze similar users' behavior
    
    // Simple implementation: return trending products
    return this.getTrendingProducts(limit);
  }
}

module.exports = new AIService();
