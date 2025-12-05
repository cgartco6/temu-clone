const User = require('../models/User');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const validator = require('validator');
const logger = require('../config/logger');
const emailService = require('../config/email');
const redis = require('../config/redis');
const { promisify } = require('util');

class AuthController {
  // Sign up new user
  async signup(req, res) {
    try {
      const { 
        email, 
        password, 
        firstName, 
        lastName,
        phone,
        acceptTerms,
        marketingConsent,
        referralCode
      } = req.body;

      // Validation
      if (!email || !password || !firstName || !lastName) {
        return res.status(400).json({
          success: false,
          error: 'Please provide all required fields'
        });
      }

      if (!validator.isEmail(email)) {
        return res.status(400).json({
          success: false,
          error: 'Please provide a valid email address'
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      if (!acceptTerms) {
        return res.status(400).json({
          success: false,
          error: 'You must accept the terms and conditions'
        });
      }

      // Check if user already exists
      const existingUser = await User.findOne({ email: email.toLowerCase() });
      if (existingUser) {
        return res.status(409).json({
          success: false,
          error: 'User already exists with this email'
        });
      }

      // Check referral code if provided
      let referredBy = null;
      if (referralCode) {
        const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
        if (referrer) {
          referredBy = referrer._id;
        }
      }

      // Create new user
      const user = new User({
        email: email.toLowerCase(),
        password,
        firstName,
        lastName,
        phone,
        referredBy,
        metadata: {
          registrationSource: req.headers['user-agent']?.includes('Mobile') ? 'mobile' : 'web',
          marketingConsent: marketingConsent || false,
          privacyConsent: true,
          termsAccepted: true,
          cookieConsent: false
        }
      });

      // Generate email verification token
      const verificationToken = user.createEmailVerificationToken();
      await user.save();

      // Send verification email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        templateName: 'email-verification',
        templateData: {
          name: user.firstName,
          verificationUrl: `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`,
          expiryHours: 24
        }
      });

      // Generate tokens
      const accessToken = user.generateAuthToken();
      const refreshToken = user.generateRefreshToken();

      // Store refresh token in Redis
      await redis.set(`refresh_token:${user._id}`, refreshToken, 30 * 24 * 60 * 60); // 30 days

      // Log successful registration
      logger.auditLog('USER_SIGNUP', user._id, {
        email: user.email,
        referralCode,
        ip: req.ip
      });

      res.status(201).json({
        success: true,
        message: 'Registration successful. Please check your email to verify your account.',
        data: {
          user: {
            _id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            isEmailVerified: user.isEmailVerified,
            role: user.role
          },
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: process.env.JWT_EXPIRES_IN
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'signup',
        email: req.body.email,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Registration failed. Please try again.'
      });
    }
  }

  // Login user
  async login(req, res) {
    try {
      const { email, password, twoFactorCode } = req.body;

      // Validation
      if (!email || !password) {
        return res.status(400).json({
          success: false,
          error: 'Please provide email and password'
        });
      }

      // Find user with password
      const user = await User.findOne({ email: email.toLowerCase() })
        .select('+password +loginAttempts +lockUntil +twoFactorSecret');
      
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'Invalid credentials'
        });
      }

      // Check if account is locked
      if (user.isLocked) {
        const remainingTime = Math.ceil((user.lockUntil - Date.now()) / 1000 / 60);
        return res.status(423).json({
          success: false,
          error: `Account is locked. Please try again in ${remainingTime} minutes.`
        });
      }

      // Check password
      const isPasswordValid = await user.correctPassword(password);
      
      if (!isPasswordValid) {
        // Track failed attempt
        user.addLoginAttempt(false, req.ip, req.headers['user-agent'], {
          country: req.headers['cf-ipcountry'],
          city: req.headers['cf-ipcity']
        });
        await user.save();

        return res.status(401).json({
          success: false,
          error: 'Invalid credentials',
          remainingAttempts: 5 - user.loginAttempts
        });
      }

      // Check if 2FA is enabled
      if (user.twoFactorEnabled) {
        if (!twoFactorCode) {
          return res.status(200).json({
            success: true,
            requiresTwoFactor: true,
            message: 'Two-factor authentication required'
          });
        }

        // Verify 2FA code
        const isValid2FA = this.verifyTwoFactorCode(user.twoFactorSecret, twoFactorCode);
        if (!isValid2FA) {
          user.addLoginAttempt(false, req.ip, req.headers['user-agent'], {
            country: req.headers['cf-ipcountry'],
            city: req.headers['cf-ipcity']
          });
          await user.save();

          return res.status(401).json({
            success: false,
            error: 'Invalid two-factor authentication code'
          });
        }
      }

      // Reset login attempts on successful login
      user.addLoginAttempt(true, req.ip, req.headers['user-agent'], {
        country: req.headers['cf-ipcountry'],
        city: req.headers['cf-ipcity']
      });
      await user.save();

      // Generate tokens
      const accessToken = user.generateAuthToken();
      const refreshToken = user.generateRefreshToken();

      // Store refresh token in Redis
      await redis.set(`refresh_token:${user._id}`, refreshToken, 30 * 24 * 60 * 60);

      // Update user activity
      user.lastLogin = new Date();
      user.lastActivity = new Date();
      await user.save();

      // Log successful login
      logger.auditLog('USER_LOGIN', user._id, {
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        twoFactorUsed: user.twoFactorEnabled
      });

      res.json({
        success: true,
        data: {
          user: {
            _id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            isEmailVerified: user.isEmailVerified,
            role: user.role,
            twoFactorEnabled: user.twoFactorEnabled,
            preferences: user.preferences
          },
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: process.env.JWT_EXPIRES_IN
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'login',
        email: req.body.email,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Login failed. Please try again.'
      });
    }
  }

  // Logout user
  async logout(req, res) {
    try {
      const userId = req.user._id;
      
      // Remove refresh token from Redis
      await redis.del(`refresh_token:${userId}`);
      
      // Log logout
      logger.auditLog('USER_LOGOUT', userId, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'logout',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Logout failed'
      });
    }
  }

  // Refresh access token
  async refreshToken(req, res) {
    try {
      const { refreshToken } = req.body;

      if (!refreshToken) {
        return res.status(400).json({
          success: false,
          error: 'Refresh token is required'
        });
      }

      // Verify refresh token
      const decoded = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
      
      // Check if refresh token exists in Redis
      const storedToken = await redis.get(`refresh_token:${decoded.id}`);
      if (!storedToken || storedToken !== refreshToken) {
        return res.status(401).json({
          success: false,
          error: 'Invalid refresh token'
        });
      }

      // Find user
      const user = await User.findById(decoded.id);
      if (!user) {
        return res.status(401).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate new access token
      const newAccessToken = user.generateAuthToken();

      res.json({
        success: true,
        data: {
          accessToken: newAccessToken,
          expiresIn: process.env.JWT_EXPIRES_IN
        }
      });
    } catch (error) {
      if (error.name === 'JsonWebTokenError') {
        return res.status(401).json({
          success: false,
          error: 'Invalid refresh token'
        });
      }
      
      logger.errorWithContext(error, {
        action: 'refresh_token',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Token refresh failed'
      });
    }
  }

  // Forgot password
  async forgotPassword(req, res) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      // Find user
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        // Return success even if user doesn't exist for security
        return res.json({
          success: true,
          message: 'If an account exists with this email, you will receive a password reset link'
        });
      }

      // Generate reset token
      const resetToken = user.createPasswordResetToken();
      await user.save();

      // Send password reset email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Reset your password',
        templateName: 'password-reset',
        templateData: {
          name: user.firstName,
          resetUrl: `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`,
          expiryMinutes: 10
        }
      });

      // Log password reset request
      logger.auditLog('PASSWORD_RESET_REQUEST', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'If an account exists with this email, you will receive a password reset link'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'forgot_password',
        email: req.body.email,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Password reset request failed'
      });
    }
  }

  // Reset password
  async resetPassword(req, res) {
    try {
      const { token, password } = req.body;

      if (!token || !password) {
        return res.status(400).json({
          success: false,
          error: 'Token and password are required'
        });
      }

      if (password.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'Password must be at least 8 characters long'
        });
      }

      // Hash the token
      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      // Find user with valid token
      const user = await User.findOne({
        passwordResetToken: hashedToken,
        passwordResetExpires: { $gt: Date.now() }
      });

      if (!user) {
        return res.status(400).json({
          success: false,
          error: 'Token is invalid or has expired'
        });
      }

      // Update password
      user.password = password;
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      user.passwordChangedAt = Date.now();
      
      await user.save();

      // Send password changed notification
      await emailService.sendEmail({
        to: user.email,
        subject: 'Password changed successfully',
        templateName: 'password-changed',
        templateData: {
          name: user.firstName,
          timestamp: new Date().toLocaleString()
        }
      });

      // Log password reset
      logger.auditLog('PASSWORD_RESET_SUCCESS', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Password has been reset successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'reset_password',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Password reset failed'
      });
    }
  }

  // Verify email
  async verifyEmail(req, res) {
    try {
      const { token } = req.body;

      if (!token) {
        return res.status(400).json({
          success: false,
          error: 'Verification token is required'
        });
      }

      // Hash the token
      const hashedToken = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

      // Find user with valid token
      const user = await User.findOne({
        emailVerificationToken: hashedToken,
        emailVerificationExpires: { $gt: Date.now() }
      });

      if (!user) {
        return res.status(400).json({
          success: false,
          error: 'Verification token is invalid or has expired'
        });
      }

      // Verify email
      user.isEmailVerified = true;
      user.emailVerificationToken = undefined;
      user.emailVerificationExpires = undefined;
      await user.save();

      // Send welcome email
      await emailService.sendWelcomeEmail(user);

      // Log email verification
      logger.auditLog('EMAIL_VERIFIED', user._id);

      res.json({
        success: true,
        message: 'Email verified successfully',
        data: {
          user: {
            _id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            isEmailVerified: user.isEmailVerified
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'verify_email',
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Email verification failed'
      });
    }
  }

  // Resend verification email
  async resendVerificationEmail(req, res) {
    try {
      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          error: 'Email is required'
        });
      }

      // Find user
      const user = await User.findOne({ email: email.toLowerCase() });
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      if (user.isEmailVerified) {
        return res.status(400).json({
          success: false,
          error: 'Email is already verified'
        });
      }

      // Check rate limiting
      const rateLimitKey = `verification_email:${user._id}`;
      const lastSent = await redis.get(rateLimitKey);
      
      if (lastSent) {
        const timeSinceLastSent = Date.now() - parseInt(lastSent);
        if (timeSinceLastSent < 5 * 60 * 1000) { // 5 minutes
          const remainingTime = Math.ceil((5 * 60 * 1000 - timeSinceLastSent) / 1000 / 60);
          return res.status(429).json({
            success: false,
            error: `Please wait ${remainingTime} minutes before requesting another verification email`
          });
        }
      }

      // Generate new verification token
      const verificationToken = user.createEmailVerificationToken();
      await user.save();

      // Send verification email
      await emailService.sendEmail({
        to: user.email,
        subject: 'Verify your email address',
        templateName: 'email-verification',
        templateData: {
          name: user.firstName,
          verificationUrl: `${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}`,
          expiryHours: 24
        }
      });

      // Store rate limit
      await redis.set(rateLimitKey, Date.now().toString(), 5 * 60); // 5 minutes

      // Log resend request
      logger.auditLog('VERIFICATION_EMAIL_RESENT', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Verification email sent successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'resend_verification',
        email: req.body.email,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to send verification email'
      });
    }
  }

  // Change password
  async changePassword(req, res) {
    try {
      const { currentPassword, newPassword } = req.body;
      const userId = req.user._id;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          error: 'Current password and new password are required'
        });
      }

      if (newPassword.length < 8) {
        return res.status(400).json({
          success: false,
          error: 'New password must be at least 8 characters long'
        });
      }

      // Find user with password
      const user = await User.findById(userId).select('+password');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Verify current password
      const isPasswordValid = await user.correctPassword(currentPassword);
      if (!isPasswordValid) {
        return res.status(401).json({
          success: false,
          error: 'Current password is incorrect'
        });
      }

      // Update password
      user.password = newPassword;
      user.passwordChangedAt = Date.now();
      await user.save();

      // Send password changed notification
      await emailService.sendEmail({
        to: user.email,
        subject: 'Password changed successfully',
        templateName: 'password-changed',
        templateData: {
          name: user.firstName,
          timestamp: new Date().toLocaleString()
        }
      });

      // Log password change
      logger.auditLog('PASSWORD_CHANGED', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Password changed successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'change_password',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Password change failed'
      });
    }
  }

  // Setup two-factor authentication
  async setupTwoFactor(req, res) {
    try {
      const userId = req.user._id;
      
      // Find user
      const user = await User.findById(userId).select('+twoFactorSecret');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Generate secret if not exists
      if (!user.twoFactorSecret) {
        const speakeasy = require('speakeasy');
        const secret = speakeasy.generateSecret({
          name: `Temu Clone (${user.email})`
        });
        
        user.twoFactorSecret = secret.base32;
        await user.save();

        res.json({
          success: true,
          data: {
            secret: secret.base32,
            qrCode: secret.otpauth_url
          }
        });
      } else {
        res.json({
          success: true,
          data: {
            secret: user.twoFactorSecret,
            message: 'Two-factor authentication is already set up'
          }
        });
      }
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'setup_two_factor',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to setup two-factor authentication'
      });
    }
  }

  // Enable two-factor authentication
  async enableTwoFactor(req, res) {
    try {
      const { code } = req.body;
      const userId = req.user._id;

      if (!code) {
        return res.status(400).json({
          success: false,
          error: 'Verification code is required'
        });
      }

      // Find user
      const user = await User.findById(userId).select('+twoFactorSecret');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      if (!user.twoFactorSecret) {
        return res.status(400).json({
          success: false,
          error: 'Please setup two-factor authentication first'
        });
      }

      // Verify code
      const isValid = this.verifyTwoFactorCode(user.twoFactorSecret, code);
      if (!isValid) {
        return res.status(400).json({
          success: false,
          error: 'Invalid verification code'
        });
      }

      // Enable 2FA
      user.twoFactorEnabled = true;
      await user.save();

      // Send notification
      await emailService.sendEmail({
        to: user.email,
        subject: 'Two-factor authentication enabled',
        templateName: 'two-factor-enabled',
        templateData: {
          name: user.firstName,
          timestamp: new Date().toLocaleString()
        }
      });

      // Log 2FA enabled
      logger.auditLog('TWO_FACTOR_ENABLED', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Two-factor authentication enabled successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'enable_two_factor',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to enable two-factor authentication'
      });
    }
  }

  // Disable two-factor authentication
  async disableTwoFactor(req, res) {
    try {
      const { code } = req.body;
      const userId = req.user._id;

      // Find user
      const user = await User.findById(userId).select('+twoFactorSecret');
      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      if (!user.twoFactorEnabled) {
        return res.status(400).json({
          success: false,
          error: 'Two-factor authentication is not enabled'
        });
      }

      // Verify code if provided
      if (code) {
        const isValid = this.verifyTwoFactorCode(user.twoFactorSecret, code);
        if (!isValid) {
          return res.status(400).json({
            success: false,
            error: 'Invalid verification code'
          });
        }
      }

      // Disable 2FA
      user.twoFactorEnabled = false;
      user.twoFactorSecret = undefined;
      await user.save();

      // Send notification
      await emailService.sendEmail({
        to: user.email,
        subject: 'Two-factor authentication disabled',
        templateName: 'two-factor-disabled',
        templateData: {
          name: user.firstName,
          timestamp: new Date().toLocaleString()
        }
      });

      // Log 2FA disabled
      logger.auditLog('TWO_FACTOR_DISABLED', user._id, {
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Two-factor authentication disabled successfully'
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'disable_two_factor',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to disable two-factor authentication'
      });
    }
  }

  // Get current user
  async getCurrentUser(req, res) {
    try {
      const userId = req.user._id;
      
      const user = await User.findById(userId)
        .select('-password -twoFactorSecret -loginAttempts -lockUntil')
        .populate('addresses')
        .populate('cart.items.product')
        .populate('wishlist.product')
        .populate('recentlyViewed.product');

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      res.json({
        success: true,
        data: { user }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'get_current_user',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to get user data'
      });
    }
  }

  // Update user profile
  async updateProfile(req, res) {
    try {
      const userId = req.user._id;
      const updates = req.body;

      // Remove restricted fields
      delete updates.email;
      delete updates.password;
      delete updates.role;
      delete updates.status;
      delete updates.twoFactorSecret;
      delete updates.loginAttempts;
      delete updates.lockUntil;

      // Find and update user
      const user = await User.findByIdAndUpdate(
        userId,
        { $set: updates },
        { new: true, runValidators: true }
      ).select('-password -twoFactorSecret -loginAttempts -lockUntil');

      if (!user) {
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }

      // Log profile update
      logger.auditLog('PROFILE_UPDATED', user._id, {
        updatedFields: Object.keys(updates),
        ip: req.ip
      });

      res.json({
        success: true,
        message: 'Profile updated successfully',
        data: { user }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'update_profile',
        userId: req.user?._id,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Failed to update profile'
      });
    }
  }

  // Helper method to verify 2FA code
  verifyTwoFactorCode(secret, code) {
    const speakeasy = require('speakeasy');
    
    return speakeasy.totp.verify({
      secret: secret,
      encoding: 'base32',
      token: code,
      window: 2 // Allow 2 time steps before/after
    });
  }

  // Social login (Google, Facebook, Apple)
  async socialLogin(req, res) {
    try {
      const { provider, token, email, name } = req.body;

      if (!provider || !token) {
        return res.status(400).json({
          success: false,
          error: 'Provider and token are required'
        });
      }

      // Verify social token (implementation depends on provider)
      let userData;
      switch (provider) {
        case 'google':
          userData = await this.verifyGoogleToken(token);
          break;
        case 'facebook':
          userData = await this.verifyFacebookToken(token);
          break;
        case 'apple':
          userData = await this.verifyAppleToken(token);
          break;
        default:
          return res.status(400).json({
            success: false,
            error: 'Unsupported social provider'
          });
      }

      if (!userData) {
        return res.status(401).json({
          success: false,
          error: 'Invalid social token'
        });
      }

      // Find or create user
      let user = await User.findOne({ [`socialLogin.${provider}Id`]: userData.id });
      
      if (!user) {
        // Check if email already exists
        user = await User.findOne({ email: userData.email });
        
        if (user) {
          // Link social account to existing user
          user.socialLogin[`${provider}Id`] = userData.id;
          await user.save();
        } else {
          // Create new user
          const [firstName, ...lastNameParts] = userData.name.split(' ');
          const lastName = lastNameParts.join(' ') || 'User';
          
          user = new User({
            email: userData.email,
            firstName: firstName,
            lastName: lastName,
            isEmailVerified: true,
            socialLogin: {
              [`${provider}Id`]: userData.id
            },
            metadata: {
              registrationSource: `social-${provider}`,
              marketingConsent: false,
              privacyConsent: true,
              termsAccepted: true,
              cookieConsent: false
            }
          });
          await user.save();
        }
      }

      // Update user activity
      user.lastLogin = new Date();
      user.lastActivity = new Date();
      await user.save();

      // Generate tokens
      const accessToken = user.generateAuthToken();
      const refreshToken = user.generateRefreshToken();

      // Store refresh token in Redis
      await redis.set(`refresh_token:${user._id}`, refreshToken, 30 * 24 * 60 * 60);

      // Log social login
      logger.auditLog('SOCIAL_LOGIN', user._id, {
        provider: provider,
        ip: req.ip
      });

      res.json({
        success: true,
        data: {
          user: {
            _id: user._id,
            email: user.email,
            firstName: user.firstName,
            lastName: user.lastName,
            isEmailVerified: user.isEmailVerified,
            role: user.role,
            socialLogin: user.socialLogin
          },
          tokens: {
            accessToken,
            refreshToken,
            expiresIn: process.env.JWT_EXPIRES_IN
          }
        }
      });
    } catch (error) {
      logger.errorWithContext(error, {
        action: 'social_login',
        provider: req.body.provider,
        ip: req.ip
      });
      
      res.status(500).json({
        success: false,
        error: 'Social login failed'
      });
    }
  }

  // Verify Google token
  async verifyGoogleToken(token) {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    
    try {
      const ticket = await client.verifyIdToken({
        idToken: token,
        audience: process.env.GOOGLE_CLIENT_ID
      });
      
      const payload = ticket.getPayload();
      return {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        picture: payload.picture
      };
    } catch (error) {
      logger.error('Google token verification failed:', error);
      return null;
    }
  }

  // Verify Facebook token
  async verifyFacebookToken(token) {
    const axios = require('axios');
    
    try {
      const response = await axios.get(`https://graph.facebook.com/me`, {
        params: {
          access_token: token,
          fields: 'id,name,email,picture'
        }
      });
      
      return {
        id: response.data.id,
        email: response.data.email,
        name: response.data.name,
        picture: response.data.picture?.data?.url
      };
    } catch (error) {
      logger.error('Facebook token verification failed:', error);
      return null;
    }
  }

  // Verify Apple token (simplified)
  async verifyAppleToken(token) {
    // Apple Sign In verification is more complex
    // This is a simplified version
    try {
      const jwt = require('jsonwebtoken');
      const jwksClient = require('jwks-rsa');
      
      const client = jwksClient({
        jwksUri: 'https://appleid.apple.com/auth/keys'
      });
      
      const getKey = (header, callback) => {
        client.getSigningKey(header.kid, (err, key) => {
          const signingKey = key.getPublicKey();
          callback(null, signingKey);
        });
      };
      
      return new Promise((resolve, reject) => {
        jwt.verify(token, getKey, {
          algorithms: ['RS256'],
          audience: process.env.APPLE_CLIENT_ID,
          issuer: 'https://appleid.apple.com'
        }, (err, decoded) => {
          if (err) {
            logger.error('Apple token verification failed:', err);
            resolve(null);
          } else {
            resolve({
              id: decoded.sub,
              email: decoded.email,
              name: decoded.name || 'Apple User'
            });
          }
        });
      });
    } catch (error) {
      logger.error('Apple token verification failed:', error);
      return null;
    }
  }
}

module.exports = new AuthController();
