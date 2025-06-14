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

# Create app user with UID 1000 (use existing group if GID 1000 exists)
RUN if getent group 1000 >/dev/null 2>&1; then \
        GROUP_NAME=$(getent group 1000 | cut -d: -f1); \
        adduser -u 1000 -G $GROUP_NAME -s /bin/sh -D app; \
    else \
        addgroup -g 1000 app && \
        adduser -u 1000 -G app -s /bin/sh -D app; \
    fi

# Install sqlite3 and other dependencies
RUN apk add --no-cache sqlite

WORKDIR /app

# Copy built application
COPY --from=builder --chown=app:app /build .

# Create necessary directories
RUN mkdir -p /app/db /app/logs && \
    chown -R app:app /app

# Expose port
EXPOSE 8080

# Switch to app user
USER app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/api/deploys?limit=1', (res) => process.exit(res.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

# Default command (can be overridden)
CMD ["node", "server.js"]
