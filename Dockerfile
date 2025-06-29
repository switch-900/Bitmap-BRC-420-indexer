FROM node:18-alpine AS builder

WORKDIR /build

# Install build dependencies for native modules (sqlite3 compilation)
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    sqlite-dev \
    pkgconfig \
    linux-headers

# Copy package files first for better layer caching
COPY package*.json ./

# Clean install with fallback for production build
RUN npm cache clean --force && \
    (npm ci --production --verbose || \
     npm install --production --no-audit --no-fund --verbose)

# Copy source code
COPY . .

# Remove development and unnecessary files
RUN rm -rf \
    umbrel-community-app-store/ \
    *.md \
    .git \
    .gitignore \
    .vscode \
    .idea \
    logs \
    tmp \
    test \
    tests \
    coverage

FROM node:18-alpine

# Install runtime dependencies
RUN apk add --no-cache \
    sqlite \
    dumb-init

# Create app user with UID 1000 for Umbrel compatibility
RUN addgroup -g 1000 app || true && \
    adduser -u 1000 -G app -s /bin/sh -D app 2>/dev/null || \
    (id 1000 >/dev/null 2>&1 && echo "User with UID 1000 already exists, using existing user") || \
    adduser -s /bin/sh -D app

WORKDIR /app

# Copy built application with proper ownership
COPY --from=builder --chown=1000:1000 /build .

# Copy entrypoint script if it exists
COPY --chown=1000:1000 entrypoint.sh /entrypoint.sh 2>/dev/null || echo "#!/bin/sh\nexec \"\$@\"" > /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Create necessary directories  
RUN mkdir -p /app/db /app/logs && \
    chown -R 1000:1000 /app

# Expose port
EXPOSE 8080

# Switch to user with UID 1000 (required for Umbrel)
USER 1000

# Set entrypoint
ENTRYPOINT ["/entrypoint.sh"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/deploys?limit=1', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command (can be overridden)
CMD ["node", "server.js"]
