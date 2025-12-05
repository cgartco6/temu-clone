const Product = require('../models/Product');
const Category = require('../models/Category');
const Review = require('../models/Review');
const User = require('../models/User');
const logger = require('../config/logger');
const redis = require('../config/redis');
const mongoose = require('mongoose');

class ProductController {
  // Get all products with filtering, sorting, and pagination
  async getAllProducts(req, res) {
    try {
      const {
        page = 1,
        limit = 20,
        sort = '-createdAt',
        category,
        subcategory,
        brand,
        minPrice,
        maxPrice,
        rating,
        tags,
        status = 'active',
        featured,
        bestSeller,
        newArrival,
        search,
        vendor,
        inStock,
        discount
      } = req.query;

      // Build query
      const query = {};

      // Status filter
      if (status) {
        query.status = status;
      }

      // Visibility filter
      query.visibility = 'public';

      // Category filter
      if (category) {
        query.category = category;
      }

      // Subcategory filter
      if (subcategory) {
        query.subcategory = subcategory;
      }

      // Brand filter
      if (brand) {
        query.brand = brand;
      }

      // Price range filter
      if (minPrice || maxPrice) {
        query['price.base'] = {};
        if (minPrice) query['price.base'].$gte = parseFloat(minPrice);
        if (maxPrice) query['price.base'].$lte = parseFloat(maxPrice);
      }

      // Rating filter
      if (rating) {
        query['ratings.average'] = { $gte: parseFloat(rating) };
      }

      // Tags filter
      if (tags) {
        const tagArray = Array.isArray(tags) ? tags : [tags];
        query.tags = { $in: tagArray.map(tag => tag.toLowerCase()) };
      }

      // Featured filter
      if (featured !== undefined) {
        query.featured = featured === 'true';
      }

      // Best seller filter
      if (bestSeller !== undefined) {
        query.bestSeller = bestSeller === 'true';
      }

      // New arrival filter
      if (newArrival !== undefined) {
        query.newArrival = newArrival === 'true';
      }

      // Vendor filter
      if (vendor) {
        query.vendor = vendor;
      }

      // In stock filter
      if (inStock === 'true') {
        query['$or'] = [
          { 'inventory.type': 'infinite' },
          { 'inventory.type': 'tracking' },
          { 
            $expr: { 
              $gt: [
                { 
                  $add: [
                    '$inventory.quantity',
                    { 
                      $sum: '$variants.inventory.quantity' 
                    }
                  ]
                },
                { 
                  $add: [
                    '$inventory.reserved',
                    { 
                      $sum: '$variants.inventory.reserved' 
                    }
                  ]
                }
              ]
            }
          }
        ];
      }

      // Discount filter
      if (discount === 'true') {
        query['price.sale.amount'] = { $gt: 0 };
        query['price.sale.startDate'] = { $lte: new Date() };
        query['$or'] = [
          { 'price.sale.endDate': { $exists: false } },
          { 'price.sale.endDate': null },
          { 'price.sale.endDate': { $gte: new Date() } }
        ];
      }

      // Search filter
      if (search) {
        query.$text = { $search: search };
      }

      // Parse sort options
      let sortOptions = {};
      if (sort) {
        const sortFields = sort.split(',');
        sortFields.forEach(field => {
          const order = field.startsWith('-') ? -1 : 1;
          const fieldName = field.replace(/^-/, '');
          sortOptions[fieldName] = order;
        });
      }

      // Pagination options
      const options = {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: sortOptions,
        populate: [
          { path: 'category', select: 'name slug' },
          { path: 'subcategory', select: 'name slug' },
          { path: 'vendor', select: 'firstName lastName email' }
        ],
        lean: true
      };

      // Execute query with pagination
      const products = await Product.paginate(query, options);

      // Cache results for 5 minutes
      const cacheKey = `products:${JSON.stringify(req.query)}`;
      await redis.set(cacheKey, JSON.stringify(products), 300);

      // Track search if user is logged in
      if (search && req.user) {
        const user = await User.findById(req.user._id);
        if (user) {
          user.trackSearch(search);
          await user.save();
        }
      }

      res.json({
        success: true,
        data: products
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_all_products',
        query: req.query,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch products'
      });
    }
  }

  // Get single product by ID or slug
  async getProduct(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user?._id;

      // Check if ID is a valid ObjectId or slug
      let query;
      if (mongoose.Types.ObjectId.isValid(id)) {
        query = { _id: id, status: 'active', visibility: 'public' };
      } else {
        query = { slug: id, status: 'active', visibility: 'public' };
      }

      // Get product with related data
      const product = await Product.findOne(query)
        .populate('category', 'name slug description')
        .populate('subcategory', 'name slug description')
        .populate('vendor', 'firstName lastName email vendorProfile')
        .populate('relatedProducts', 'name slug price images ratings')
        .populate('crossSellProducts', 'name slug price images ratings')
        .populate('upSellProducts', 'name slug price images ratings')
        .lean();

      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Increment view count
      await Product.findByIdAndUpdate(product._id, {
        $inc: { 'analytics.views': 1 }
      });

      // Track view for logged in users
      if (userId) {
        const user = await User.findById(userId);
        if (user) {
          user.trackView(product._id);
          await user.save();
        }
      }

      // Get related reviews
      const reviews = await Review.find({ product: product._id, status: 'approved' })
        .populate('user', 'firstName lastName avatar')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      // Get similar products
      const similarProducts = await Product.find({
        category: product.category,
        _id: { $ne: product._id },
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings brand')
      .limit(8)
      .lean();

      // Prepare response data
      const responseData = {
        ...product,
        reviews: {
          data: reviews,
          average: product.ratings.average,
          count: product.ratings.count,
          distribution: product.ratings.distribution
        },
        similarProducts
      };

      // Cache product for 10 minutes
      const cacheKey = `product:${id}`;
      await redis.set(cacheKey, JSON.stringify(responseData), 600);

      res.json({
        success: true,
        data: responseData
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_product',
        productId: req.params.id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch product'
      });
    }
  }

  // Create new product (vendor/admin only)
  async createProduct(req, res) {
    try {
      const vendorId = req.user._id;
      const userRole = req.user.role;

      // Check if user is vendor or admin
      if (userRole !== 'vendor' && userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'Only vendors and admins can create products'
        });
      }

      const {
        name,
        description,
        category,
        subcategory,
        brand,
        tags,
        price,
        inventory,
        variants,
        specifications,
        shipping,
        seo,
        digital,
        subscription,
        customFields
      } = req.body;

      // Validate required fields
      if (!name || !description?.short || !description?.long || !category || !price?.base) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields'
        });
      }

      // Check if category exists
      const categoryExists = await Category.findById(category);
      if (!categoryExists) {
        return res.status(400).json({
          success: false,
          error: 'Category not found'
        });
      }

      // Generate SKU
      const sku = this.generateSKU(name, brand);

      // Create product
      const product = new Product({
        name,
        description,
        sku,
        category,
        subcategory,
        brand,
        tags: tags?.map(tag => tag.toLowerCase()),
        price,
        inventory: {
          type: inventory?.type || 'finite',
          quantity: inventory?.quantity || 0,
          lowStockThreshold: inventory?.lowStockThreshold || 5,
          allowBackorders: inventory?.allowBackorders || false
        },
        variants: variants || [],
        specifications,
        shipping,
        seo,
        digital,
        subscription,
        customFields,
        vendor: vendorId,
        createdBy: vendorId,
        updatedBy: vendorId
      });

      await product.save();

      // Clear product cache
      await redis.flush('products:*');

      // Log product creation
      logger.auditLog('PRODUCT_CREATED', vendorId, {
        productId: product._id,
        name: product.name,
        sku: product.sku
      });

      res.status(201).json({
        success: true,
        message: 'Product created successfully',
        data: { product }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'create_product',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to create product'
      });
    }
  }

  // Update product
  async updateProduct(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRole = req.user.role;
      const updates = req.body;

      // Find product
      const product = await Product.findById(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check permissions
      const isOwner = product.vendor.toString() === userId.toString();
      const isAdmin = userRole === 'admin' || userRole === 'superadmin';
      
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to update this product'
        });
      }

      // Remove restricted fields
      delete updates._id;
      delete updates.sku;
      delete updates.vendor;
      delete updates.createdAt;
      delete updates.createdBy;
      delete updates.analytics;

      // Update product
      Object.keys(updates).forEach(key => {
        if (updates[key] !== undefined) {
          // Handle nested updates
          if (typeof updates[key] === 'object' && !Array.isArray(updates[key])) {
            product[key] = { ...product[key], ...updates[key] };
          } else {
            product[key] = updates[key];
          }
        }
      });

      product.updatedBy = userId;
      await product.save();

      // Clear cache
      await redis.del(`product:${id}`);
      await redis.flush('products:*');

      // Log update
      logger.auditLog('PRODUCT_UPDATED', userId, {
        productId: product._id,
        updatedFields: Object.keys(updates)
      });

      res.json({
        success: true,
        message: 'Product updated successfully',
        data: { product }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_product',
        productId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update product'
      });
    }
  }

  // Delete product
  async deleteProduct(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const userRole = req.user.role;

      // Find product
      const product = await Product.findById(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check permissions
      const isOwner = product.vendor.toString() === userId.toString();
      const isAdmin = userRole === 'admin' || userRole === 'superadmin';
      
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to delete this product'
        });
      }

      // Soft delete (archive) instead of hard delete
      product.status = 'archived';
      product.updatedBy = userId;
      await product.save();

      // Clear cache
      await redis.del(`product:${id}`);
      await redis.flush('products:*');

      // Log deletion
      logger.auditLog('PRODUCT_DELETED', userId, {
        productId: product._id,
        name: product.name
      });

      res.json({
        success: true,
        message: 'Product archived successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'delete_product',
        productId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to delete product'
      });
    }
  }

  // Upload product images
  async uploadImages(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const files = req.files;
      const { isPrimary } = req.body;

      // Find product
      const product = await Product.findById(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check permissions
      const isOwner = product.vendor.toString() === userId.toString();
      const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
      
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to upload images for this product'
        });
      }

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No images uploaded'
        });
      }

      // Process uploaded images
      const uploadService = require('../config/upload');
      const images = [];

      for (const file of files) {
        // Optimize image
        const optimized = await uploadService.optimizeImage(file.path, {
          width: 1200,
          height: 1200,
          quality: 80,
          format: 'webp'
        });

        // Generate thumbnails
        const thumbnails = await uploadService.generateThumbnails(optimized.path, [
          { width: 150, height: 150, suffix: '_thumb' },
          { width: 300, height: 300, suffix: '_small' },
          { width: 600, height: 600, suffix: '_medium' }
        ]);

        // Get image info
        const imageInfo = uploadService.getFileInfo(optimized.path);

        images.push({
          url: `/uploads/${path.basename(optimized.path)}`,
          publicId: file.filename,
          altText: file.originalname,
          isPrimary: isPrimary === 'true',
          order: product.images.length,
          dimensions: {
            width: imageInfo?.width,
            height: imageInfo?.height
          }
        });
      }

      // Update product images
      if (isPrimary === 'true') {
        // Reset all images to non-primary
        product.images.forEach(img => {
          img.isPrimary = false;
        });
      }

      product.images.push(...images);
      product.updatedBy = userId;
      await product.save();

      // Clear cache
      await redis.del(`product:${id}`);

      res.json({
        success: true,
        message: 'Images uploaded successfully',
        data: { images }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'upload_product_images',
        productId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to upload images'
      });
    }
  }

  // Update product inventory
  async updateInventory(req, res) {
    try {
      const { id } = req.params;
      const userId = req.user._id;
      const { quantity, variantSku, action = 'restock', notes } = req.body;

      // Validate input
      if (!quantity || quantity <= 0) {
        return res.status(400).json({
          success: false,
          error: 'Valid quantity is required'
        });
      }

      // Find product
      const product = await Product.findById(id);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check permissions
      const isOwner = product.vendor.toString() === userId.toString();
      const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
      
      if (!isOwner && !isAdmin) {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to update inventory'
        });
      }

      // Update inventory
      product.updateInventory(quantity, variantSku, action);
      product.updatedBy = userId;
      await product.save();

      // Log inventory update
      logger.auditLog('INVENTORY_UPDATED', userId, {
        productId: product._id,
        sku: product.sku,
        variantSku,
        action,
        quantity,
        notes
      });

      // Clear cache
      await redis.del(`product:${id}`);

      res.json({
        success: true,
        message: 'Inventory updated successfully',
        data: {
          productId: product._id,
          sku: product.sku,
          currentInventory: product.inventory.quantity,
          variants: product.variants.map(v => ({
            sku: v.sku,
            inventory: v.inventory.quantity
          }))
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_inventory',
        productId: req.params.id,
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update inventory'
      });
    }
  }

  // Get product reviews
  async getProductReviews(req, res) {
    try {
      const { id } = req.params;
      const { page = 1, limit = 10, sort = '-createdAt', rating } = req.query;

      // Build query
      const query = { product: id, status: 'approved' };

      if (rating) {
        query.rating = parseInt(rating);
      }

      // Parse sort options
      let sortOptions = { createdAt: -1 };
      if (sort === 'helpful') {
        sortOptions = { helpfulCount: -1 };
      } else if (sort === 'rating') {
        sortOptions = { rating: -1 };
      }

      // Get reviews with pagination
      const reviews = await Review.paginate(query, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: sortOptions,
        populate: {
          path: 'user',
          select: 'firstName lastName avatar'
        },
        lean: true
      });

      res.json({
        success: true,
        data: reviews
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_product_reviews',
        productId: req.params.id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch reviews'
      });
    }
  }

  // Search products
  async searchProducts(req, res) {
    try {
      const { q, category, minPrice, maxPrice, brand, sort, page = 1, limit = 20 } = req.query;

      if (!q && !category && !brand) {
        return res.status(400).json({
          success: false,
          error: 'Search query, category, or brand is required'
        });
      }

      // Build search query
      const query = {
        status: 'active',
        visibility: 'public'
      };

      // Text search
      if (q) {
        query.$text = { $search: q };
      }

      // Category filter
      if (category) {
        query.category = category;
      }

      // Price filter
      if (minPrice || maxPrice) {
        query['price.base'] = {};
        if (minPrice) query['price.base'].$gte = parseFloat(minPrice);
        if (maxPrice) query['price.base'].$lte = parseFloat(maxPrice);
      }

      // Brand filter
      if (brand) {
        query.brand = brand;
      }

      // Sort options
      let sortOptions = {};
      if (sort === 'price_asc') {
        sortOptions = { 'price.base': 1 };
      } else if (sort === 'price_desc') {
        sortOptions = { 'price.base': -1 };
      } else if (sort === 'rating') {
        sortOptions = { 'ratings.average': -1 };
      } else if (sort === 'newest') {
        sortOptions = { createdAt: -1 };
      } else if (sort === 'popular') {
        sortOptions = { 'analytics.purchases': -1 };
      } else if (q) {
        // Default sort for text search
        sortOptions = { score: { $meta: 'textScore' } };
      }

      // Execute search
      const products = await Product.find(query)
        .select('name slug price images ratings brand category')
        .sort(sortOptions)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .populate('category', 'name slug')
        .lean();

      // Get total count
      const total = await Product.countDocuments(query);

      // Track search for logged in users
      if (q && req.user) {
        const user = await User.findById(req.user._id);
        if (user) {
          user.trackSearch(q);
          await user.save();
        }
      }

      res.json({
        success: true,
        data: {
          products,
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
        action: 'search_products',
        query: req.query,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Search failed'
      });
    }
  }

  // Get featured products
  async getFeaturedProducts(req, res) {
    try {
      const { limit = 10 } = req.query;

      const cacheKey = `featured_products:${limit}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached)
        });
      }

      const products = await Product.find({
        featured: true,
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings brand')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(products), 300);

      res.json({
        success: true,
        data: products
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_featured_products',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch featured products'
      });
    }
  }

  // Get best sellers
  async getBestSellers(req, res) {
    try {
      const { limit = 10 } = req.query;

      const cacheKey = `best_sellers:${limit}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached)
        });
      }

      const products = await Product.find({
        bestSeller: true,
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings brand analytics')
      .sort({ 'analytics.purchases': -1 })
      .limit(parseInt(limit))
      .lean();

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(products), 300);

      res.json({
        success: true,
        data: products
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_best_sellers',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch best sellers'
      });
    }
  }

  // Get new arrivals
  async getNewArrivals(req, res) {
    try {
      const { days = 30, limit = 10 } = req.query;
      const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const cacheKey = `new_arrivals:${days}:${limit}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached)
        });
      }

      const products = await Product.find({
        createdAt: { $gte: date },
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings brand')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(products), 300);

      res.json({
        success: true,
        data: products
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_new_arrivals',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch new arrivals'
      });
    }
  }

  // Get products on sale
  async getProductsOnSale(req, res) {
    try {
      const { limit = 10 } = req.query;

      const cacheKey = `products_on_sale:${limit}`;
      const cached = await redis.get(cacheKey);

      if (cached) {
        return res.json({
          success: true,
          data: JSON.parse(cached)
        });
      }

      const products = await Product.find({
        'price.sale.amount': { $gt: 0 },
        'price.sale.startDate': { $lte: new Date() },
        $or: [
          { 'price.sale.endDate': { $exists: false } },
          { 'price.sale.endDate': null },
          { 'price.sale.endDate': { $gte: new Date() } }
        ],
        status: 'active',
        visibility: 'public'
      })
      .select('name slug price images ratings brand')
      .sort({ 'price.sale.amount': -1 })
      .limit(parseInt(limit))
      .lean();

      // Cache for 5 minutes
      await redis.set(cacheKey, JSON.stringify(products), 300);

      res.json({
        success: true,
        data: products
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_products_on_sale',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch products on sale'
      });
    }
  }

  // Get product variants
  async getProductVariants(req, res) {
    try {
      const { id } = req.params;

      const product = await Product.findById(id)
        .select('variants inventory')
        .lean();

      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Calculate available stock for each variant
      const variants = product.variants.map(variant => ({
        ...variant,
        availableStock: variant.inventory.quantity - variant.inventory.reserved,
        inStock: (variant.inventory.quantity - variant.inventory.reserved) > 0
      }));

      res.json({
        success: true,
        data: {
          variants,
          mainProduct: {
            inventory: product.inventory,
            totalStock: product.inventory.quantity + product.variants.reduce((sum, v) => sum + v.inventory.quantity, 0),
            availableStock: (product.inventory.quantity - product.inventory.reserved) + 
                          product.variants.reduce((sum, v) => sum + (v.inventory.quantity - v.inventory.reserved), 0)
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_product_variants',
        productId: req.params.id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch product variants'
      });
    }
  }

  // Check product availability
  async checkAvailability(req, res) {
    try {
      const { id } = req.params;
      const { variantSku, quantity = 1 } = req.query;

      const product = await Product.findById(id)
        .select('inventory variants')
        .lean();

      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      let availableStock;
      let inStock;

      if (variantSku) {
        const variant = product.variants.find(v => v.sku === variantSku);
        if (!variant) {
          return res.status(404).json({
            success: false,
            error: 'Variant not found'
          });
        }
        availableStock = variant.inventory.quantity - variant.inventory.reserved;
        inStock = availableStock >= parseInt(quantity);
      } else {
        const variantStock = product.variants.reduce((sum, v) => sum + (v.inventory.quantity - v.inventory.reserved), 0);
        availableStock = (product.inventory.quantity - product.inventory.reserved) + variantStock;
        inStock = availableStock >= parseInt(quantity);
      }

      res.json({
        success: true,
        data: {
          productId: id,
          variantSku,
          requestedQuantity: parseInt(quantity),
          availableStock,
          inStock,
          canBackorder: product.inventory.allowBackorders && !inStock
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'check_availability',
        productId: req.params.id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to check availability'
      });
    }
  }

  // Get product statistics
  async getProductStats(req, res) {
    try {
      const userId = req.user._id;
      const userRole = req.user.role;

      // Only vendors and admins can see stats
      if (userRole !== 'vendor' && userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'You do not have permission to view product statistics'
        });
      }

      // Build query based on user role
      let query = {};
      if (userRole === 'vendor') {
        query.vendor = userId;
      }

      const stats = await Product.aggregate([
        { $match: query },
        {
          $facet: {
            totalProducts: [
              { $count: 'count' }
            ],
            productsByStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            inventorySummary: [
              {
                $group: {
                  _id: null,
                  totalStock: { $sum: '$inventory.quantity' },
                  lowStockCount: {
                    $sum: {
                      $cond: [
                        { 
                          $and: [
                            { $eq: ['$inventory.type', 'finite'] },
                            { $lte: ['$inventory.quantity', '$inventory.lowStockThreshold'] },
                            { $gt: ['$inventory.quantity', 0] }
                          ]
                        },
                        1,
                        0
                      ]
                    }
                  },
                  outOfStockCount: {
                    $sum: {
                      $cond: [
                        { 
                          $and: [
                            { $eq: ['$inventory.type', 'finite'] },
                            { $eq: ['$inventory.quantity', 0] }
                          ]
                        },
                        1,
                        0
                      ]
                    }
                  },
                  totalSold: { $sum: '$inventory.sold' },
                  totalRevenue: {
                    $sum: { $multiply: ['$price.base', '$inventory.sold'] }
                  }
                }
              }
            ],
            topProducts: [
              { $sort: { 'analytics.purchases': -1 } },
              { $limit: 10 },
              {
                $project: {
                  name: 1,
                  sku: 1,
                  status: 1,
                  purchases: '$analytics.purchases',
                  views: '$analytics.views',
                  conversionRate: '$analytics.conversionRate',
                  revenue: { $multiply: ['$price.base', '$inventory.sold'] }
                }
              }
            ],
            productsByCategory: [
              { $group: { _id: '$category', count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 10 }
            ]
          }
        }
      ]);

      res.json({
        success: true,
        data: stats[0]
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_product_stats',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch product statistics'
      });
    }
  }

  // Helper method to generate SKU
  generateSKU(name, brand) {
    const namePart = name.substring(0, 3).toUpperCase();
    const brandPart = brand ? brand.substring(0, 3).toUpperCase() : 'GEN';
    const randomPart = Math.random().toString(36).substr(2, 6).toUpperCase();
    const timestamp = Date.now().toString().substr(-4);
    
    return `${namePart}-${brandPart}-${randomPart}-${timestamp}`;
  }
}

module.exports = new ProductController();
