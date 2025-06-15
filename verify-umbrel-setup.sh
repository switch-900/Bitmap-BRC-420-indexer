#!/bin/bash

# 🔍 UMBREL DEPLOYMENT VERIFICATION SCRIPT
# Run this on your Umbrel system to verify everything is ready

echo "🔍 BRC-420 Indexer Deployment Verification"
echo "=========================================="

# Check if app store directory exists
if [ -d "~/bitcoin-indexers-app-store" ]; then
    echo "✅ App store directory exists"
else
    echo "❌ App store directory not found"
    echo "   Run: git clone https://github.com/switch-900/bitcoin-indexers-app-store.git"
    exit 1
fi

# Check if docker-compose.yml exists and is valid
if [ -f "~/bitcoin-indexers-app-store/bitcoin-indexers-brc420/docker-compose.yml" ]; then
    echo "✅ docker-compose.yml exists"
    
    # Check if it's the simplified version
    if grep -q "command: sh -c" ~/bitcoin-indexers-app-store/bitcoin-indexers-brc420/docker-compose.yml; then
        echo "✅ Using simplified docker-compose format"
    else
        echo "⚠️  May be using old complex format"
    fi
else
    echo "❌ docker-compose.yml not found"
    exit 1
fi

# Check if required Umbrel services are running
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

# Check if app is currently installed
echo ""
echo "🔍 Checking current app status..."

if ~/umbrel/scripts/app ls-installed | grep -q "bitcoin-indexers-brc420"; then
    echo "📦 App is currently installed"
    echo "   Status: $(~/umbrel/scripts/app ls-installed | grep bitcoin-indexers-brc420)"
else
    echo "📦 App is not currently installed"
fi

echo ""
echo "🚀 Ready to deploy! Run the installation command:"
echo "cd ~/bitcoin-indexers-app-store && git pull origin main && ~/umbrel/scripts/app uninstall bitcoin-indexers-brc420 2>/dev/null; sleep 5 && ~/umbrel/scripts/app install bitcoin-indexers-brc420"
