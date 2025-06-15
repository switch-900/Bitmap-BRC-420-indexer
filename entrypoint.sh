#!/bin/sh

# Entrypoint script to ensure proper permissions for database and logs

echo "Setting up directories and permissions..."

# Ensure directories exist
mkdir -p /app/db /app/logs

# Try to fix permissions if running as root or if we have sudo access
if [ "$(id -u)" = "0" ]; then
    echo "Running as root, setting up permissions for UID 1000..."
    chown -R 1000:1000 /app/db /app/logs
    chmod -R 755 /app/db /app/logs
    echo "Permissions set successfully"
fi

# Check write permissions
if [ -w /app/db ]; then
    echo "Database directory is writable"
else
    echo "Warning: Database directory is not writable"
    # Try to create a subdirectory in /tmp as fallback
    mkdir -p /tmp/brc420-db
    echo "Created fallback database directory: /tmp/brc420-db"
    export DB_PATH="/tmp/brc420-db/brc420.db"
fi

if [ -w /app/logs ]; then
    echo "Logs directory is writable"
else
    echo "Warning: Logs directory is not writable, logging to console only"
fi

echo "Starting application..."
exec "$@"
