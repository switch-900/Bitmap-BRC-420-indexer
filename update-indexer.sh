#!/bin/bash

# Script to update BRC-420 Indexer with new Docker image that includes indexer functionality
# Run this script on your Umbrel device after the GitHub Actions build completes

echo "🔄 Updating BRC-420 Indexer with Indexer Functionality..."

# Pull the latest Docker image
echo "📥 Pulling latest Docker image..."
docker pull ghcr.io/switch-900/brc-420-indexer:latest

# Restart the app to use the new image
echo "🔄 Restarting app..."
~/umbrel/scripts/app restart bitcoin-indexers-brc420

# Wait for containers to start
echo "⏳ Waiting for containers to start..."
sleep 10

# Check status
echo "📊 Checking app status..."
~/umbrel/scripts/app status bitcoin-indexers-brc420

# Check if indexer is running
echo "🔍 Checking indexer logs..."
docker logs bitcoin-indexers-brc420_web_1 | tail -20

echo ""
echo "✅ Update complete!"
echo ""
echo "🔗 Access your indexer at: http://umbrel.local:3420"
echo ""
echo "🔍 To monitor indexer progress:"
echo "   docker logs -f bitcoin-indexers-brc420_web_1"
echo ""
echo "📊 The indexer will start processing Bitcoin blocks automatically."
echo "   Starting from block 792435 (BRC-420 genesis)"
echo "   Database will populate with inscriptions as they are processed."
