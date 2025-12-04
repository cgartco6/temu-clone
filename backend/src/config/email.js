const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const handlebars = require('handlebars');
const logger = require('./logger');
const { promisify } = require('util');

class EmailService {
  constructor() {
    this.transporter = null;
    this.templates = {};
    this.initialize();
  }

  async initialize() {
    try {
      // Create transporter
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        pool: true,
        maxConnections: 5,
        maxMessages: 100
      });

      // Verify connection
      await this.verifyConnection();
      
      // Load email templates
      await this.loadTemplates();

      logger.info('Email service initialized successfully');
    } catch (error) {
      logger.error('Failed to initialize email service:', error);
      throw error;
    }
  }

  async verifyConnection() {
    try {
      const isVerified = await this.transporter.verify();
      if (isVerified) {
        logger.info('SMTP connection verified');
        return true;
      }
    } catch (error) {
      logger.error('SMTP connection verification failed:', error);
      throw error;
    }
  }

  async loadTemplates() {
    const templatesDir = path.join(__dirname, '../templates/email');
    
    try {
      const files = fs.readdirSync(templatesDir);
      
      for (const file of files) {
        if (file.endsWith('.hbs')) {
          const templateName = path.basename(file, '.hbs');
          const templatePath = path.join(templatesDir, file);
          const templateContent = fs.readFileSync(templatePath, 'utf8');
          
          this.templates[templateName] = handlebars.compile(templateContent);
          logger.debug(`Loaded email template: ${templateName}`);
        }
      }
      
      logger.info(`Loaded ${Object.keys(this.templates).length} email templates`);
    } catch (error) {
      logger.warn('Could not load email templates:', error);
    }
  }

  async sendEmail(options) {
    const {
      to,
      subject,
      templateName,
      templateData = {},
      text,
      html,
      attachments = [],
      cc = [],
      bcc = [],
      replyTo = process.env.EMAIL_FROM,
      priority = 'normal'
    } = options;

    try {
      // Validate required fields
      if (!to) {
        throw new Error('Recipient email address is required');
      }

      if (!subject) {
        throw new Error('Email subject is required');
      }

      // Prepare email content
      let emailHtml = html;
      let emailText = text;

      // Use template if specified
      if (templateName && this.templates[templateName]) {
        emailHtml = this.templates[templateName](templateData);
        
        // Generate plain text version if not provided
        if (!emailText) {
          emailText = this.generatePlainText(emailHtml);
        }
      }

      if (!emailHtml && !emailText) {
        throw new Error('Email content is required');
      }

      // Prepare email options
      const mailOptions = {
        from: {
          name: process.env.EMAIL_FROM_NAME || 'Temu Clone',
          address: process.env.EMAIL_FROM
        },
        to: Array.isArray(to) ? to : [to],
        subject: subject,
        priority: priority,
        replyTo: replyTo,
        date: new Date()
      };

      if (emailText) mailOptions.text = emailText;
      if (emailHtml) mailOptions.html = emailHtml;
      if (cc.length > 0) mailOptions.cc = cc;
      if (bcc.length > 0) mailOptions.bcc = bcc;
      if (attachments.length > 0) mailOptions.attachments = attachments;

      // Send email
      const info = await this.transporter.sendMail(mailOptions);
      
      logger.info(`Email sent successfully: ${info.messageId}`, {
        to: to,
        subject: subject,
        messageId: info.messageId
      });

      return {
        success: true,
        messageId: info.messageId,
        response: info.response
      };
    } catch (error) {
      logger.error('Failed to send email:', error, {
        to: to,
        subject: subject
      });
      
      return {
        success: false,
        error: error.message
      };
    }
  }

  generatePlainText(html) {
    // Simple HTML to plain text conversion
    return html
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Predefined email templates
  async sendWelcomeEmail(user) {
    return this.sendEmail({
      to: user.email,
      subject: 'Welcome to Temu Clone!',
      templateName: 'welcome',
      templateData: {
        name: user.name,
        email: user.email,
        loginUrl: `${process.env.FRONTEND_URL}/login`,
        supportEmail: process.env.SUPPORT_EMAIL
      }
    });
  }

  async sendPasswordResetEmail(user, resetToken) {
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
    
    return this.sendEmail({
      to: user.email,
      subject: 'Password Reset Request',
      templateName: 'password-reset',
      templateData: {
        name: user.name,
        resetUrl: resetUrl,
        expiryHours: 1
      }
    });
  }

  async sendOrderConfirmation(order, user) {
    return this.sendEmail({
      to: user.email,
      subject: `Order Confirmation #${order.orderId}`,
      templateName: 'order-confirmation',
      templateData: {
        name: user.name,
        orderId: order.orderId,
        orderDate: new Date(order.createdAt).toLocaleDateString(),
        items: order.items.map(item => ({
          name: item.name,
          quantity: item.quantity,
          price: item.price
        })),
        total: order.total,
        shippingAddress: order.shippingAddress,
        estimatedDelivery: order.estimatedDelivery,
        trackingUrl: order.trackingUrl
      },
      attachments: [
        {
          filename: `invoice-${order.orderId}.pdf`,
          path: await this.generateInvoicePdf(order, user)
        }
      ]
    });
  }

  async sendShippingNotification(order, trackingInfo) {
    return this.sendEmail({
      to: order.user.email,
      subject: `Your Order #${order.orderId} Has Shipped!`,
      templateName: 'shipping-notification',
      templateData: {
        name: order.user.name,
        orderId: order.orderId,
        carrier: trackingInfo.carrier,
        trackingNumber: trackingInfo.trackingNumber,
        trackingUrl: trackingInfo.trackingUrl,
        estimatedDelivery: trackingInfo.estimatedDelivery
      }
    });
  }

  async sendPaymentReceipt(payment, user) {
    return this.sendEmail({
      to: user.email,
      subject: `Payment Receipt - ${payment.description}`,
      templateName: 'payment-receipt',
      templateData: {
        name: user.name,
        amount: payment.amount,
        currency: payment.currency,
        description: payment.description,
        date: new Date(payment.createdAt).toLocaleDateString(),
        transactionId: payment.transactionId,
        paymentMethod: payment.paymentMethod
      }
    });
  }

  async sendNewsletter(subscribers, content) {
    const results = [];
    
    for (const subscriber of subscribers) {
      try {
        const result = await this.sendEmail({
          to: subscriber.email,
          subject: content.subject,
          templateName: 'newsletter',
          templateData: {
            name: subscriber.name,
            content: content.body,
            unsubscribeUrl: `${process.env.FRONTEND_URL}/unsubscribe?token=${subscriber.unsubscribeToken}`
          }
        });
        
        results.push({
          email: subscriber.email,
          success: result.success,
          messageId: result.messageId
        });
      } catch (error) {
        results.push({
          email: subscriber.email,
          success: false,
          error: error.message
        });
      }
    }
    
    return results;
  }

  async generateInvoicePdf(order, user) {
    // This would generate a PDF invoice
    // For now, return a placeholder
    const PDFDocument = require('pdfkit');
    const fs = require('fs');
    const path = require('path');
    
    const invoicePath = path.join(__dirname, '../../temp', `invoice-${order.orderId}.pdf`);
    const doc = new PDFDocument();
    
    const writeStream = fs.createWriteStream(invoicePath);
    doc.pipe(writeStream);
    
    // Generate PDF content
    doc.fontSize(20).text('INVOICE', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice #: ${order.orderId}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.text(`Customer: ${user.name}`);
    doc.text(`Email: ${user.email}`);
    doc.moveDown();
    
    // Add items table
    doc.text('Items:', { underline: true });
    order.items.forEach((item, index) => {
      doc.text(`${index + 1}. ${item.name} - ${item.quantity} x $${item.price}`);
    });
    
    doc.moveDown();
    doc.text(`Total: $${order.total}`);
    
    doc.end();
    
    return new Promise((resolve, reject) => {
      writeStream.on('finish', () => resolve(invoicePath));
      writeStream.on('error', reject);
    });
  }

  async getDeliveryStatus(messageId) {
    try {
      // This would check with the email service provider
      // For now, return a mock response
      return {
        delivered: true,
        opened: Math.random() > 0.5,
        clicked: Math.random() > 0.3,
        status: 'delivered'
      };
    } catch (error) {
      logger.error('Failed to get delivery status:', error);
      return null;
    }
  }

  async close() {
    if (this.transporter) {
      this.transporter.close();
      logger.info('Email transporter closed');
    }
  }
}

module.exports = new EmailService();
