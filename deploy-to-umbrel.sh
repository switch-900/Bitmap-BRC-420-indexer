#!/bin/bash

# Deploy BRC-420 Indexer to Umbrel - Updated Configuration
# This script should be run on the Umbrel system via SSH

echo "🚀 Deploying BRC-420 Indexer to Umbrel with simplified configuration..."

# Navigate to the app store directory
cd ~/bitcoin-indexers-app-store || {
    echo "❌ App store directory not found. Please run setup first."
    exit 1
}

# Pull latest changes from GitHub
echo "📥 Pulling latest changes from GitHub..."
git pull origin main

# Check if the app is currently installed
if ~/umbrel/scripts/app ls-installed | grep -q "bitcoin-indexers-brc420"; then
    echo "🔄 App is currently installed. Uninstalling first..."
    ~/umbrel/scripts/app uninstall bitcoin-indexers-brc420
    
    # Wait for uninstall to complete
    echo "⏳ Waiting for uninstall to complete..."
    sleep 10
fi

# Remove any existing app data to start fresh
echo "🧹 Cleaning up any existing app data..."
sudo rm -rf ~/umbrel/app-data/bitcoin-indexers-brc420

# Try to install the app
echo "📦 Installing BRC-420 Indexer..."
~/umbrel/scripts/app install bitcoin-indexers-brc420

# Check installation status
echo "🔍 Checking installation status..."
if ~/umbrel/scripts/app ls-installed | grep -q "bitcoin-indexers-brc420"; then
    echo "✅ Installation successful!"
    echo "🌐 The app should now be available at: http://umbrel.local/app-store/bitcoin-indexers-brc420"
    echo ""
    echo "📋 Next steps:"
    echo "1. Check app logs: ~/umbrel/scripts/app logs bitcoin-indexers-brc420"
    echo "2. Check app status: ~/umbrel/scripts/app ls-installed | grep bitcoin-indexers-brc420"
    echo "3. Access the web interface through your Umbrel dashboard"
else
    echo "❌ Installation failed. Checking logs..."
    echo ""
    echo "🔍 Recent system logs:"
    journalctl -u umbrel --no-pager -n 20
    echo ""
    echo "🔍 App installation logs:"
    ls -la ~/umbrel/logs/ | grep -i install
fi

echo ""
echo "🏁 Deployment script completed."
