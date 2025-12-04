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

# Remove dev dependencies if any
RUN npm prune --production

# Production stage
FROM node:18-alpine

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built application
COPY --from=builder --chown=nodejs:nodejs /app .

USER nodejs

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:5000/health', (r) => {if(r.statusCode !== 200) throw new Error()})"

# Expose port
EXPOSE 5000

# Start application
CMD ["node", "src/app.js"]
