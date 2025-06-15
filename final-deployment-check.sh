#!/bin/bash

# 🔍 BRC-420 Indexer - Final Deployment Verification
# Run this on your Umbrel system after deployment

echo "🎯 BRC-420 Indexer - Final Deployment Check"
echo "=========================================="

# Check if running on Umbrel
if [ ! -d "/home/umbrel/umbrel" ]; then
    echo "❌ Not running on Umbrel system"
    exit 1
fi

echo "✅ Running on Umbrel system"

# Check if app store directory exists and has latest changes
if [ -d "~/bitcoin-indexers-app-store" ]; then
    echo "✅ App store directory exists"
    
    # Check if docker-compose.yml has the correct command
    if grep -q 'command: \["node", "server.js"\]' ~/bitcoin-indexers-app-store/bitcoin-indexers-brc420/docker-compose.yml; then
        echo "✅ Docker compose uses correct server.js command"
    else
        echo "❌ Docker compose still has old command - run 'git pull origin main'"
        exit 1
    fi
else
    echo "❌ App store directory not found"
    echo "   Run: git clone https://github.com/switch-900/bitcoin-indexers-app-store.git"
    exit 1
fi

# Check if required services are running
echo ""
echo "🔍 Checking Umbrel services..."

if docker ps | grep -q "bitcoin"; then
    echo "✅ Bitcoin Core service is running"
else
    echo "❌ Bitcoin Core service not running"
fi

if docker ps | grep -q "ord"; then
    echo "✅ Ordinals service is running"
else
    echo "❌ Ordinals service not running"
fi

# Check if our app is installed
echo ""
echo "📦 Checking BRC-420 Indexer status..."

if ~/umbrel/scripts/app ls-installed | grep -q "bitcoin-indexers-brc420"; then
    echo "✅ App is installed"
    
    # Check if containers are running
    if docker ps | grep -q "bitcoin-indexers-brc420_web"; then
        echo "✅ Web container is running"
        
        # Check container health
        CONTAINER_ID=$(docker ps --filter "name=bitcoin-indexers-brc420_web" --format "{{.ID}}" | head -n1)
        if [ ! -z "$CONTAINER_ID" ]; then
            echo "   Container ID: $CONTAINER_ID"
            
            # Check if database was created
            if docker exec "$CONTAINER_ID" ls /app/db/brc420.db >/dev/null 2>&1; then
                echo "✅ Database file exists in container"
            else
                echo "⚠️  Database file not found (may still be initializing)"
            fi
            
            # Check recent logs for errors
            echo ""
            echo "📋 Recent container logs (last 10 lines):"
            docker logs --tail 10 "$CONTAINER_ID"
        fi
    else
        echo "❌ Web container not running"
        echo "   Check logs: ~/umbrel/scripts/app logs bitcoin-indexers-brc420"
    fi
    
    # Check if database directory exists on host
    APP_DATA_DIR="$HOME/umbrel/app-data/bitcoin-indexers-brc420"
    if [ -d "$APP_DATA_DIR" ]; then
        echo "✅ App data directory exists: $APP_DATA_DIR"
        
        if [ -f "$APP_DATA_DIR/data/brc420.db" ]; then
            DB_SIZE=$(du -h "$APP_DATA_DIR/data/brc420.db" | cut -f1)
            echo "✅ Database file exists on host (size: $DB_SIZE)"
        else
            echo "⚠️  Database file not yet created on host"
        fi
    else
        echo "❌ App data directory not found"
    fi
    
else
    echo "📦 App is not currently installed"
    echo ""
    echo "🚀 Ready to install! Run:"
    echo "   cd ~/bitcoin-indexers-app-store && git pull origin main && ~/umbrel/scripts/app install bitcoin-indexers-brc420"
fi

echo ""
echo "🎯 Deployment verification complete!"

# Summary
echo ""
echo "📊 Summary:"
echo "   - App store repository: $([ -d ~/bitcoin-indexers-app-store ] && echo "✅ Ready" || echo "❌ Missing")"
echo "   - Bitcoin Core: $(docker ps | grep -q bitcoin && echo "✅ Running" || echo "❌ Not running")"
echo "   - Ordinals: $(docker ps | grep -q ord && echo "✅ Running" || echo "❌ Not running")"
echo "   - BRC-420 App: $(~/umbrel/scripts/app ls-installed | grep -q bitcoin-indexers-brc420 && echo "✅ Installed" || echo "📦 Not installed")"

if ~/umbrel/scripts/app ls-installed | grep -q "bitcoin-indexers-brc420" && docker ps | grep -q "bitcoin-indexers-brc420_web"; then
    echo ""
    echo "🎉 BRC-420 Indexer is successfully deployed and running!"
    echo "🌐 Access it through your Umbrel dashboard or check logs for any issues."
fi
