# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY yarn.lock ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Remove dev dependencies
RUN npm prune --production

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Production stage
FROM node:18-alpine

WORKDIR /app

# Create necessary directories
RUN mkdir -p /app/logs /app/uploads /app/temp

# Install necessary packages
RUN apk add --no-cache curl

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app .

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:5000/health || exit 1

# Expose port
EXPOSE 5000

# Environment variables
ENV NODE_ENV=production \
    PORT=5000 \
    NODE_OPTIONS="--max-old-space-size=2048"

# Start application with PM2
CMD ["npm", "start"]
