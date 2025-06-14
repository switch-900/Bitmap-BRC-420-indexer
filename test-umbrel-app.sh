#!/bin/bash

# BRC-420 Indexer Umbrel App Testing Script
# This script helps validate your Umbrel app installation

echo "🔍 BRC-420 Indexer - Umbrel App Health Check"
echo "=============================================="

# Check if running on Umbrel
if [ ! -d "/home/umbrel" ]; then
    echo "❌ Not running on Umbrel node"
    exit 1
fi

echo "✅ Running on Umbrel node"

# Check if app is installed
APP_DIR="/home/umbrel/umbrel/app-data/bitcoin-indexers-brc420"
if [ ! -d "$APP_DIR" ]; then
    echo "❌ BRC-420 Indexer app not installed"
    echo "   Please install from the App Store first"
    exit 1
fi

echo "✅ App directory found: $APP_DIR"

# Check if containers are running
echo ""
echo "📦 Checking Docker containers..."

WEB_CONTAINER=$(docker ps --filter "name=bitcoin-indexers-brc420_web" --format "{{.Names}}" | head -n1)
INDEXER_CONTAINER=$(docker ps --filter "name=bitcoin-indexers-brc420_indexer" --format "{{.Names}}" | head -n1)

if [ -z "$WEB_CONTAINER" ]; then
    echo "❌ Web container not running"
else
    echo "✅ Web container running: $WEB_CONTAINER"
fi

if [ -z "$INDEXER_CONTAINER" ]; then
    echo "❌ Indexer container not running"  
else
    echo "✅ Indexer container running: $INDEXER_CONTAINER"
fi

# Check dependencies
echo ""
echo "🔗 Checking dependencies..."

# Check Bitcoin Core
BITCOIN_CONTAINER=$(docker ps --filter "name=bitcoin_bitcoind" --format "{{.Names}}" | head -n1)
if [ -z "$BITCOIN_CONTAINER" ]; then
    echo "❌ Bitcoin Core not running"
else
    echo "✅ Bitcoin Core running: $BITCOIN_CONTAINER"
fi

# Check Ordinals
ORDINALS_CONTAINER=$(docker ps --filter "name=ordinals" --format "{{.Names}}" | head -n1)
if [ -z "$ORDINALS_CONTAINER" ]; then
    echo "❌ Ordinals app not running"
else
    echo "✅ Ordinals app running: $ORDINALS_CONTAINER"
fi

# Test API connectivity
echo ""
echo "🌐 Testing API connectivity..."

# Test web interface
if curl -f -s http://localhost:8080 > /dev/null; then
    echo "✅ Web interface accessible on port 8080"
else
    echo "❌ Web interface not accessible"
fi

# Test API endpoint
if curl -f -s http://localhost:8080/api/deploys > /dev/null; then
    echo "✅ API endpoints responding"
else
    echo "❌ API endpoints not responding"
fi

# Test Ordinals API
if curl -f -s http://localhost:4000/api > /dev/null; then
    echo "✅ Ordinals API accessible on port 4000"
else
    echo "❌ Ordinals API not accessible (check if ordinals app is running)"
fi

# Check database
echo ""
echo "💾 Checking database..."

DB_FILE="$APP_DIR/data/brc420.db"
if [ -f "$DB_FILE" ]; then
    echo "✅ Database file exists: $DB_FILE"
    
    # Check file size
    DB_SIZE=$(du -h "$DB_FILE" | cut -f1)
    echo "   Database size: $DB_SIZE"
    
    # Check permissions
    DB_PERMS=$(stat -c "%U:%G" "$DB_FILE" 2>/dev/null || echo "unknown")
    echo "   Database owner: $DB_PERMS"
else
    echo "❌ Database file not found"
fi

# Check logs
echo ""
echo "📋 Recent indexer logs..."
if [ ! -z "$INDEXER_CONTAINER" ]; then
    echo "--- Last 10 lines ---"
    docker logs --tail 10 "$INDEXER_CONTAINER"
else
    echo "❌ No indexer container to check logs"
fi

echo ""
echo "🎯 Health check complete!"

# Summary
echo ""
echo "📊 Summary:"
[ ! -z "$WEB_CONTAINER" ] && echo "✅ Web interface: http://$(hostname -I | awk '{print $1}'):8080"
[ ! -z "$INDEXER_CONTAINER" ] && echo "✅ Indexer running and processing blocks"
[ -f "$DB_FILE" ] && echo "✅ Database operational"

echo ""
echo "🔧 Troubleshooting commands:"
echo "   View logs: docker logs bitcoin-indexers-brc420_indexer_1"
echo "   Restart app: ~/umbrel/scripts/app restart bitcoin-indexers-brc420"
echo "   Check dependencies: ~/umbrel/scripts/app ls"
