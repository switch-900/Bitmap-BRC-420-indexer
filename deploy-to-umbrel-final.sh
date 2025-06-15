#!/bin/bash

# 🚀 BRC-420 Indexer - Deploy to Umbrel
# Run this script on your Umbrel node after pushing code to GitHub

echo "🔄 Deploying BRC-420 Indexer to Umbrel..."

# Navigate to home directory
cd ~

# Clone or update the app store repository
if [ -d "bitcoin-indexers-app-store" ]; then
    echo "📥 Updating existing app store..."
    cd bitcoin-indexers-app-store
    git pull origin main
else
    echo "📥 Cloning app store..."
    git clone https://github.com/switch-900/bitcoin-indexers-app-store.git
    cd bitcoin-indexers-app-store
fi

# Install the app
echo "📦 Installing BRC-420 Indexer..."
~/umbrel/scripts/app install bitcoin-indexers-brc420

# Wait for installation
echo "⏳ Waiting for installation to complete..."
sleep 15

# Check status
echo "📊 Checking app status..."
~/umbrel/scripts/app status bitcoin-indexers-brc420

# Show logs
echo "📋 Recent logs:"
~/umbrel/scripts/app logs bitcoin-indexers-brc420 --tail 20

echo ""
echo "✅ Deployment complete!"
echo "🌐 Access your indexer at: http://umbrel.local:8080"
echo "📊 API available at: http://umbrel.local:8080/api"
