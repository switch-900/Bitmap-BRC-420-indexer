FROM node:18-alpine AS builder

WORKDIR /build

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --production

# Copy source code
COPY . .

# Remove development files
RUN rm -rf umbrel-community-app-store/ *.md

FROM node:18-alpine

# Install dependencies
RUN apk add --no-cache sqlite

# Create app user with UID 1000 for Umbrel compatibility
RUN addgroup -g 1000 app || true && \
    adduser -u 1000 -G app -s /bin/sh -D app 2>/dev/null || \
    (id 1000 >/dev/null 2>&1 && echo "User with UID 1000 already exists, using existing user") || \
    adduser -s /bin/sh -D app

WORKDIR /app

# Copy built application
COPY --from=builder --chown=1000:1000 /build .

# Create necessary directories  
RUN mkdir -p /app/db /app/logs && \
    chown -R 1000:1000 /app

# Expose port
EXPOSE 8080

# Switch to user with UID 1000 (required for Umbrel)
USER 1000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/deploys?limit=1', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command (can be overridden)
CMD ["node", "server.js"]
