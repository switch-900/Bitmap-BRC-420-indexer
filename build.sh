#!/bin/bash

# Build script for BRC-420 Indexer Umbrel App

echo "Building BRC-420 Indexer Docker image..."

# Build the Docker image
docker build -t getumbrel/brc420-indexer:latest .

if [ $? -eq 0 ]; then
    echo "✅ Docker image built successfully!"
    echo "Image: getumbrel/brc420-indexer:latest"
    
    # Optional: Test the image
    echo "Testing the image..."
    docker run --rm -p 8080:8080 -e NODE_ENV=development getumbrel/brc420-indexer:latest &
    DOCKER_PID=$!
    
    sleep 5
    
    # Test health endpoint
    if curl -f http://localhost:8080/health > /dev/null 2>&1; then
        echo "✅ Health check passed!"
    else
        echo "❌ Health check failed"
    fi
    
    # Stop test container
    kill $DOCKER_PID 2>/dev/null
    
else
    echo "❌ Docker build failed!"
    exit 1
fi

echo ""
echo "Next steps:"
echo "1. Push the image to a registry (Docker Hub, GitHub Container Registry, etc.)"
echo "2. Update the docker-compose.yml with the correct image URL"
echo "3. Test the Umbrel app on your node"
