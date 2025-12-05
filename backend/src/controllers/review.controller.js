const Review = require('../models/Review');
const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const logger = require('../config/logger');
const redis = require('../config/redis');

class ReviewController {
  // Get product reviews
  async getProductReviews(req, res) {
    try {
      const { productId } = req.params;
      const { 
        page = 1, 
        limit = 10, 
        sort = '-createdAt',
        rating,
        verified = 'true'
      } = req.query;

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Build query
      const query = { 
        product: productId,
        status: 'approved'
      };

      if (rating) {
        query.rating = parseInt(rating);
      }

      if (verified === 'true') {
        query.verifiedPurchase = true;
      }

      // Parse sort options
      let sortOptions = {};
      if (sort === 'helpful') {
        sortOptions = { helpfulCount: -1 };
      } else if (sort === 'rating_high') {
        sortOptions = { rating: -1 };
      } else if (sort === 'rating_low') {
        sortOptions = { rating: 1 };
      } else if (sort === 'recent') {
        sortOptions = { createdAt: -1 };
      } else {
        sortOptions = { createdAt: -1 };
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

      // Calculate rating distribution
      const ratingDistribution = await Review.aggregate([
        { $match: { product: product._id, status: 'approved' } },
        {
          $group: {
            _id: '$rating',
            count: { $sum: 1 }
          }
        },
        { $sort: { _id: 1 } }
      ]);

      // Format distribution
      const distribution = {
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0
      };

      ratingDistribution.forEach(item => {
        distribution[item._id] = item.count;
      });

      res.json({
        success: true,
        data: {
          reviews,
          summary: {
            averageRating: product.ratings.average,
            totalReviews: product.ratings.count,
            ratingDistribution: distribution,
            verifiedPurchaseCount: await Review.countDocuments({ 
              product: productId, 
              status: 'approved',
              verifiedPurchase: true 
            })
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_product_reviews',
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch reviews'
      });
    }
  }

  // Create review
  async createReview(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.params;
      const { rating, title, comment, images } = req.body;

      // Validate input
      if (!rating || rating < 1 || rating > 5) {
        return res.status(400).json({
          success: false,
          error: 'Rating must be between 1 and 5'
        });
      }

      if (!comment || comment.trim().length < 10) {
        return res.status(400).json({
          success: false,
          error: 'Comment must be at least 10 characters'
        });
      }

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check if user has purchased the product
      const hasPurchased = await Order.exists({
        user: userId,
        'items.product': productId,
        status: 'delivered'
      });

      // Check if user already reviewed this product
      const existingReview = await Review.findOne({
        user: userId,
        product: productId
      });

      if (existingReview) {
        return res.status(400).json({
          success: false,
          error: 'You have already reviewed this product'
        });
      }

      // Create review
      const review = new Review({
        user: userId,
        product: productId,
        rating: parseInt(rating),
        title: title?.trim(),
        comment: comment.trim(),
        images: images || [],
        verifiedPurchase: !!hasPurchased,
        status: 'pending', // Admin approval required
        helpfulCount: 0,
        unhelpfulCount: 0
      });

      await review.save();

      // Update product rating (temporarily, will be updated after admin approval)
      // This would be done in admin approval process

      // Clear product cache
      await redis.del(`product:${productId}`);
      await redis.del(`reviews:${productId}`);

      // Log review creation
      logger.auditLog('REVIEW_CREATED', userId, {
        productId,
        rating,
        verifiedPurchase: hasPurchased,
        ip: req.ip
      });

      res.status(201).json({
        success: true,
        message: 'Review submitted for approval',
        data: { review }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'create_review',
        userId: req.user?._id,
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to create review: ' + error.message
      });
    }
  }

  // Update review
  async updateReview(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId } = req.params;
      const updates = req.body;

      // Find review
      const review = await Review.findOne({
        _id: reviewId,
        user: userId
      });

      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Check if review can be updated
      if (review.status === 'approved') {
        return res.status(400).json({
          success: false,
          error: 'Approved reviews cannot be modified'
        });
      }

      // Validate updates
      if (updates.rating && (updates.rating < 1 || updates.rating > 5)) {
        return res.status(400).json({
          success: false,
          error: 'Rating must be between 1 and 5'
        });
      }

      if (updates.comment && updates.comment.trim().length < 10) {
        return res.status(400).json({
          success: false,
          error: 'Comment must be at least 10 characters'
        });
      }

      // Update review
      Object.keys(updates).forEach(key => {
        if (updates[key] !== undefined && key !== '_id') {
          review[key] = updates[key];
        }
      });

      review.status = 'pending'; // Back to pending after update
      review.updatedAt = new Date();

      await review.save();

      // Clear caches
      await redis.del(`product:${review.product}`);
      await redis.del(`reviews:${review.product}`);

      // Log review update
      logger.auditLog('REVIEW_UPDATED', userId, {
        reviewId,
        productId: review.product,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Review updated and sent for re-approval',
        data: { review }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_review',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update review'
      });
    }
  }

  // Delete review
  async deleteReview(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId } = req.params;

      // Find review
      const review = await Review.findOne({
        _id: reviewId,
        user: userId
      });

      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Get product ID before deletion
      const productId = review.product;

      // Delete review
      await Review.findByIdAndDelete(reviewId);

      // Update product rating if review was approved
      if (review.status === 'approved') {
        await this.updateProductRating(productId);
      }

      // Clear caches
      await redis.del(`product:${productId}`);
      await redis.del(`reviews:${productId}`);

      // Log review deletion
      logger.auditLog('REVIEW_DELETED', userId, {
        reviewId,
        productId,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Review deleted successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'delete_review',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to delete review'
      });
    }
  }

  // Get user reviews
  async getUserReviews(req, res) {
    try {
      const userId = req.user._id;
      const { page = 1, limit = 10, status } = req.query;

      // Build query
      const query = { user: userId };
      
      if (status) {
        query.status = status;
      }

      // Get reviews with pagination
      const reviews = await Review.paginate(query, {
        page: parseInt(page),
        limit: parseInt(limit),
        sort: { createdAt: -1 },
        populate: {
          path: 'product',
          select: 'name slug images'
        },
        lean: true
      });

      res.json({
        success: true,
        data: reviews
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_user_reviews',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch user reviews'
      });
    }
  }

  // Mark review as helpful
  async markHelpful(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId } = req.params;
      const { helpful = true } = req.body;

      // Find review
      const review = await Review.findById(reviewId);
      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Check if user already voted
      const alreadyVoted = review.helpfulVotes.includes(userId) || 
                          review.unhelpfulVotes.includes(userId);

      if (alreadyVoted) {
        return res.status(400).json({
          success: false,
          error: 'You have already voted on this review'
        });
      }

      // Update vote counts
      if (helpful) {
        review.helpfulCount += 1;
        review.helpfulVotes.push(userId);
      } else {
        review.unhelpfulCount += 1;
        review.unhelpfulVotes.push(userId);
      }

      await review.save();

      // Log vote
      logger.auditLog('REVIEW_VOTED', userId, {
        reviewId,
        helpful,
        ip: req.ip
      });

      res.json({
        success: true,
        message: `Review marked as ${helpful ? 'helpful' : 'unhelpful'}`,
        data: {
          helpfulCount: review.helpfulCount,
          unhelpfulCount: review.unhelpfulCount
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'mark_helpful',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to mark review'
      });
    }
  }

  // Report review
  async reportReview(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId } = req.params;
      const { reason, details } = req.body;

      if (!reason) {
        return res.status(400).json({
          success: false,
          error: 'Reason is required'
        });
      }

      // Find review
      const review = await Review.findById(reviewId);
      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Check if user already reported
      const alreadyReported = review.reports.some(report => 
        report.user.toString() === userId.toString()
      );

      if (alreadyReported) {
        return res.status(400).json({
          success: false,
          error: 'You have already reported this review'
        });
      }

      // Add report
      review.reports.push({
        user: userId,
        reason,
        details: details || '',
        reportedAt: new Date()
      });

      // If report count reaches threshold, flag for admin review
      if (review.reports.length >= 3) {
        review.status = 'flagged';
      }

      await review.save();

      // Log report
      logger.auditLog('REVIEW_REPORTED', userId, {
        reviewId,
        reason,
        reportCount: review.reports.length,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Review reported successfully',
        data: {
          reportCount: review.reports.length,
          status: review.status
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'report_review',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to report review'
      });
    }
  }

  // Upload review images
  async uploadImages(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId } = req.params;
      const files = req.files;

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No images uploaded'
        });
      }

      // Find review
      const review = await Review.findOne({
        _id: reviewId,
        user: userId
      });

      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Check image limit (max 5 images)
      if (review.images.length + files.length > 5) {
        return res.status(400).json({
          success: false,
          error: 'Maximum 5 images allowed per review'
        });
      }

      // Process uploaded images
      const uploadService = require('../config/upload');
      const newImages = [];

      for (const file of files) {
        // Optimize image
        const optimized = await uploadService.optimizeImage(file.path, {
          width: 800,
          height: 800,
          quality: 80,
          format: 'webp'
        });

        // Generate thumbnail
        const thumbnails = await uploadService.generateThumbnails(optimized.path, [
          { width: 200, height: 200, suffix: '_thumb' }
        ]);

        // Get image info
        const imageInfo = uploadService.getFileInfo(optimized.path);

        newImages.push({
          url: `/uploads/${path.basename(optimized.path)}`,
          thumbnailUrl: thumbnails[0]?.path ? `/uploads/${path.basename(thumbnails[0].path)}` : null,
          publicId: file.filename,
          order: review.images.length + newImages.length
        });
      }

      // Add images to review
      review.images.push(...newImages);
      await review.save();

      // Clear review cache
      await redis.del(`reviews:${review.product}`);

      // Log image upload
      logger.auditLog('REVIEW_IMAGES_UPLOADED', userId, {
        reviewId,
        imageCount: files.length,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Images uploaded successfully',
        data: {
          images: review.images
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'upload_review_images',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to upload images'
      });
    }
  }

  // Delete review image
  async deleteImage(req, res) {
    try {
      const userId = req.user._id;
      const { reviewId, imageIndex } = req.params;

      // Find review
      const review = await Review.findOne({
        _id: reviewId,
        user: userId
      });

      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      // Check image index
      const index = parseInt(imageIndex);
      if (isNaN(index) || index < 0 || index >= review.images.length) {
        return res.status(400).json({
          success: false,
          error: 'Invalid image index'
        });
      }

      // Delete image file
      const uploadService = require('../config/upload');
      const image = review.images[index];
      
      if (image.url) {
        await uploadService.deleteFile(image.url.replace('/uploads/', 'uploads/'));
      }
      if (image.thumbnailUrl) {
        await uploadService.deleteFile(image.thumbnailUrl.replace('/uploads/', 'uploads/'));
      }

      // Remove image from array
      review.images.splice(index, 1);

      // Reorder remaining images
      review.images.forEach((img, idx) => {
        img.order = idx;
      });

      await review.save();

      // Clear review cache
      await redis.del(`reviews:${review.product}`);

      // Log image deletion
      logger.auditLog('REVIEW_IMAGE_DELETED', userId, {
        reviewId,
        imageIndex: index,
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Image deleted successfully',
        data: {
          images: review.images
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'delete_review_image',
        userId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to delete image'
      });
    }
  }

  // Get review statistics
  async getReviewStats(req, res) {
    try {
      const userId = req.user._id;

      const stats = await Review.aggregate([
        { $match: { user: new mongoose.Types.ObjectId(userId) } },
        {
          $facet: {
            totalReviews: [
              { $count: 'count' }
            ],
            reviewsByStatus: [
              { $group: { _id: '$status', count: { $sum: 1 } } }
            ],
            reviewsByRating: [
              { $group: { _id: '$rating', count: { $sum: 1 } } }
            ],
            averageRating: [
              { $group: { _id: null, average: { $avg: '$rating' } } }
            ],
            helpfulStats: [
              {
                $group: {
                  _id: null,
                  totalHelpful: { $sum: '$helpfulCount' },
                  totalUnhelpful: { $sum: '$unhelpfulCount' }
                }
              }
            ]
          }
        }
      ]);

      // Get recent reviews
      const recentReviews = await Review.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(5)
        .populate('product', 'name slug images')
        .lean();

      res.json({
        success: true,
        data: {
          summary: {
            totalReviews: stats[0].totalReviews[0]?.count || 0,
            averageRating: stats[0].averageRating[0]?.average || 0,
            byStatus: stats[0].reviewsByStatus || [],
            byRating: stats[0].reviewsByRating || [],
            helpful: stats[0].helpfulStats[0] || { totalHelpful: 0, totalUnhelpful: 0 }
          },
          recentReviews
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_review_stats',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch review statistics'
      });
    }
  }

  // Check if user can review product
  async canReviewProduct(req, res) {
    try {
      const userId = req.user._id;
      const { productId } = req.params;

      // Check if product exists
      const product = await Product.findById(productId);
      if (!product) {
        return res.status(404).json({
          success: false,
          error: 'Product not found'
        });
      }

      // Check if already reviewed
      const existingReview = await Review.findOne({
        user: userId,
        product: productId
      });

      if (existingReview) {
        return res.json({
          success: true,
          data: {
            canReview: false,
            reason: 'already_reviewed',
            existingReview: {
              _id: existingReview._id,
              rating: existingReview.rating,
              status: existingReview.status
            }
          }
        });
      }

      // Check if user purchased the product
      const hasPurchased = await Order.exists({
        user: userId,
        'items.product': productId,
        status: 'delivered'
      });

      // Calculate days since first eligible purchase
      let daysSincePurchase = null;
      if (hasPurchased) {
        const firstPurchase = await Order.findOne({
          user: userId,
          'items.product': productId,
          status: 'delivered'
        }).sort({ 'timeline.deliveredAt': 1 });

        if (firstPurchase) {
          const days = Math.floor(
            (Date.now() - firstPurchase.timeline.deliveredAt.getTime()) / 
            (1000 * 60 * 60 * 24)
          );
          daysSincePurchase = days;
        }
      }

      res.json({
        success: true,
        data: {
          canReview: true,
          hasPurchased,
          daysSincePurchase,
          product: {
            name: product.name,
            images: product.images
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'can_review_product',
        userId: req.user?._id,
        productId: req.params.productId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to check review eligibility'
      });
    }
  }

  // Admin: Get pending reviews
  async getPendingReviews(req, res) {
    try {
      const userRole = req.user.role;
      
      if (userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'Only admins can access pending reviews'
        });
      }

      const { page = 1, limit = 20 } = req.query;

      const reviews = await Review.paginate(
        { status: 'pending' },
        {
          page: parseInt(page),
          limit: parseInt(limit),
          sort: { createdAt: 1 },
          populate: [
            { path: 'user', select: 'firstName lastName email' },
            { path: 'product', select: 'name slug' }
          ],
          lean: true
        }
      );

      res.json({
        success: true,
        data: reviews
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_pending_reviews',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to fetch pending reviews'
      });
    }
  }

  // Admin: Approve/reject review
  async moderateReview(req, res) {
    try {
      const adminId = req.user._id;
      const userRole = req.user.role;
      const { reviewId } = req.params;
      const { action, reason } = req.body;

      if (userRole !== 'admin' && userRole !== 'superadmin') {
        return res.status(403).json({
          success: false,
          error: 'Only admins can moderate reviews'
        });
      }

      if (!action || !['approve', 'reject'].includes(action)) {
        return res.status(400).json({
          success: false,
          error: 'Valid action (approve/reject) is required'
        });
      }

      // Find review
      const review = await Review.findById(reviewId);
      if (!review) {
        return res.status(404).json({
          success: false,
          error: 'Review not found'
        });
      }

      if (review.status !== 'pending') {
        return res.status(400).json({
          success: false,
          error: 'Review is not pending moderation'
        });
      }

      // Update review status
      review.status = action === 'approve' ? 'approved' : 'rejected';
      review.moderatedBy = adminId;
      review.moderatedAt = new Date();
      
      if (reason) {
        review.moderatorNotes = reason;
      }

      await review.save();

      // If approved, update product rating
      if (action === 'approve') {
        await this.updateProductRating(review.product);
      }

      // Clear caches
      await redis.del(`product:${review.product}`);
      await redis.del(`reviews:${review.product}`);

      // Send notification to user if rejected
      if (action === 'reject') {
        const user = await User.findById(review.user);
        if (user) {
          await emailService.sendEmail({
            to: user.email,
            subject: 'Your Review Was Not Approved',
            templateName: 'review-rejected',
            templateData: {
              name: user.firstName,
              productName: review.product?.name || 'the product',
              reason: reason || 'It did not meet our community guidelines',
              reviewGuidelinesUrl: `${process.env.FRONTEND_URL}/review-guidelines`
            }
          });
        }
      }

      // Log moderation
      logger.auditLog('REVIEW_MODERATED', adminId, {
        reviewId,
        action,
        previousStatus: 'pending',
        newStatus: review.status,
        reason,
        ip: req.ip
      });

      res.json({
        success: true,
        message: `Review ${action}d successfully`,
        data: { review }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'moderate_review',
        adminId: req.user?._id,
        reviewId: req.params.reviewId,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to moderate review'
      });
    }
  }

  // Helper method to update product rating
  async updateProductRating(productId) {
    try {
      const reviews = await Review.find({
        product: productId,
        status: 'approved'
      });

      if (reviews.length === 0) return;

      // Calculate average rating
      const totalRating = reviews.reduce((sum, review) => sum + review.rating, 0);
      const averageRating = totalRating / reviews.length;

      // Calculate rating distribution
      const distribution = {
        1: 0, 2: 0, 3: 0, 4: 0, 5: 0
      };

      reviews.forEach(review => {
        distribution[review.rating] = (distribution[review.rating] || 0) + 1;
      });

      // Update product
      await Product.findByIdAndUpdate(productId, {
        $set: {
          'ratings.average': parseFloat(averageRating.toFixed(1)),
          'ratings.count': reviews.length,
          'ratings.distribution': distribution
        }
      });

      // Clear product cache
      await redis.del(`product:${productId}`);
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_product_rating',
        productId
      });
    }
  }
}

module.exports = new ReviewController();
