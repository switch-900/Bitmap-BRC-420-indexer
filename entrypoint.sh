#!/bin/sh

# Entrypoint script to ensure proper permissions for database and logs

echo "Setting up directories and permissions..."

# Ensure directories exist and have correct permissions
mkdir -p /app/db /app/logs

# Set permissions if we have write access
if [ -w /app/db ]; then
    echo "Database directory is writable"
else
    echo "Warning: Database directory is not writable, will run in read-only mode"
fi

if [ -w /app/logs ]; then
    echo "Logs directory is writable"
else
    echo "Warning: Logs directory is not writable, logging to console only"
fi

echo "Starting application..."
exec "$@"
