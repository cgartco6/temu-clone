const multer = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

// Ensure upload directories exist
const uploadDirs = {
  images: 'uploads/images',
  documents: 'uploads/documents',
  videos: 'uploads/videos',
  temp: 'uploads/temp'
};

Object.values(uploadDirs).forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Allowed file types
const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml'];
const ALLOWED_DOCUMENT_TYPES = ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const ALLOWED_VIDEO_TYPES = ['video/mp4', 'video/mpeg', 'video/ogg', 'video/webm'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// File filter
const fileFilter = (req, file, cb) => {
  const fileType = file.mimetype;
  
  if (ALLOWED_IMAGE_TYPES.includes(fileType)) {
    file.fileCategory = 'images';
  } else if (ALLOWED_DOCUMENT_TYPES.includes(fileType)) {
    file.fileCategory = 'documents';
  } else if (ALLOWED_VIDEO_TYPES.includes(fileType)) {
    file.fileCategory = 'videos';
  } else {
    file.fileCategory = 'others';
  }

  // Check file type
  if (
    ALLOWED_IMAGE_TYPES.includes(fileType) ||
    ALLOWED_DOCUMENT_TYPES.includes(fileType) ||
    ALLOWED_VIDEO_TYPES.includes(fileType)
  ) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type. Allowed types: ${[...ALLOWED_IMAGE_TYPES, ...ALLOWED_DOCUMENT_TYPES, ...ALLOWED_VIDEO_TYPES].join(', ')}`), false);
  }
};

// Storage configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDirs[file.fileCategory] || uploadDirs.temp);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

// Create multer instance
const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 10 // Max 10 files at once
  }
});

// Image optimization function
const optimizeImage = async (filePath, options = {}) => {
  try {
    const {
      width = 1200,
      height = 1200,
      quality = 80,
      format = 'webp'
    } = options;

    const outputPath = filePath.replace(path.extname(filePath), `.${format}`);
    
    await sharp(filePath)
      .resize(width, height, {
        fit: 'inside',
        withoutEnlargement: true
      })
      .toFormat(format, {
        quality: quality,
        progressive: true
      })
      .toFile(outputPath);

    // Delete original if optimized version created
    if (filePath !== outputPath) {
      fs.unlinkSync(filePath);
    }

    return {
      success: true,
      path: outputPath,
      size: fs.statSync(outputPath).size,
      format: format
    };
  } catch (error) {
    logger.error('Image optimization failed:', error);
    return {
      success: false,
      error: error.message,
      path: filePath
    };
  }
};

// Generate thumbnails
const generateThumbnails = async (filePath, sizes = []) => {
  const results = [];
  const ext = path.extname(filePath);
  const baseName = path.basename(filePath, ext);
  const dirName = path.dirname(filePath);

  const defaultSizes = [
    { width: 150, height: 150, suffix: '_thumb' },
    { width: 300, height: 300, suffix: '_small' },
    { width: 600, height: 600, suffix: '_medium' }
  ];

  const thumbnailSizes = sizes.length > 0 ? sizes : defaultSizes;

  for (const size of thumbnailSizes) {
    try {
      const thumbPath = path.join(dirName, `${baseName}${size.suffix}${ext}`);
      
      await sharp(filePath)
        .resize(size.width, size.height, {
          fit: 'cover',
          position: 'center'
        })
        .toFile(thumbPath);

      results.push({
        size: `${size.width}x${size.height}`,
        path: thumbPath,
        suffix: size.suffix
      });
    } catch (error) {
      logger.error(`Thumbnail generation failed for size ${size.width}x${size.height}:`, error);
    }
  }

  return results;
};

// Delete file
const deleteFile = (filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (error) {
    logger.error('File deletion failed:', error);
    return { success: false, error: error.message };
  }
};

// Get file info
const getFileInfo = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    
    return {
      path: filePath,
      name: path.basename(filePath),
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      created: stats.birthtime,
      modified: stats.mtime,
      extension: ext,
      mimeType: getMimeType(ext),
      isImage: ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].includes(ext),
      isDocument: ['.pdf', '.doc', '.docx', '.txt'].includes(ext),
      isVideo: ['.mp4', '.mpeg', '.ogg', '.webm'].includes(ext)
    };
  } catch (error) {
    logger.error('Get file info failed:', error);
    return null;
  }
};

// Helper function to format bytes
const formatBytes = (bytes, decimals = 2) => {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
};

// Helper function to get MIME type from extension
const getMimeType = (extension) => {
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.txt': 'text/plain',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.ogg': 'video/ogg',
    '.webm': 'video/webm'
  };

  return mimeTypes[extension] || 'application/octet-stream';
};

// Clean up old temp files
const cleanupTempFiles = (ageInHours = 24) => {
  try {
    const tempDir = uploadDirs.temp;
    const files = fs.readdirSync(tempDir);
    const now = Date.now();
    const maxAge = ageInHours * 60 * 60 * 1000;

    let deletedCount = 0;

    files.forEach(file => {
      const filePath = path.join(tempDir, file);
      const stats = fs.statSync(filePath);
      const fileAge = now - stats.mtime.getTime();

      if (fileAge > maxAge) {
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    });

    logger.info(`Cleaned up ${deletedCount} old temporary files`);
    return deletedCount;
  } catch (error) {
    logger.error('Cleanup temp files failed:', error);
    return 0;
  }
};

module.exports = {
  upload,
  optimizeImage,
  generateThumbnails,
  deleteFile,
  getFileInfo,
  cleanupTempFiles,
  ALLOWED_IMAGE_TYPES,
  ALLOWED_DOCUMENT_TYPES,
  ALLOWED_VIDEO_TYPES,
  MAX_FILE_SIZE,
  uploadDirs
};
