# Build script for BRC-420 Indexer Umbrel App

Write-Host "Building BRC-420 Indexer Docker image..." -ForegroundColor Yellow

# Build the Docker image
docker build -t getumbrel/brc420-indexer:latest .

if ($LASTEXITCODE -eq 0) {
    Write-Host "✅ Docker image built successfully!" -ForegroundColor Green
    Write-Host "Image: getumbrel/brc420-indexer:latest" -ForegroundColor Cyan
    
    # Optional: Test the image
    Write-Host "Testing the image..." -ForegroundColor Yellow
    $dockerJob = Start-Job -ScriptBlock {
        docker run --rm -p 8080:8080 -e NODE_ENV=development getumbrel/brc420-indexer:latest
    }
    
    Start-Sleep -Seconds 5
    
    # Test health endpoint
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:8080/health" -UseBasicParsing -TimeoutSec 5
        if ($response.StatusCode -eq 200) {
            Write-Host "✅ Health check passed!" -ForegroundColor Green
        } else {
            Write-Host "❌ Health check failed with status: $($response.StatusCode)" -ForegroundColor Red
        }
    } catch {
        Write-Host "❌ Health check failed: $($_.Exception.Message)" -ForegroundColor Red
    }
    
    # Stop test container
    Stop-Job $dockerJob -Force
    Remove-Job $dockerJob -Force
    
} else {
    Write-Host "❌ Docker build failed!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Push the image to a registry (Docker Hub, GitHub Container Registry, etc.)"
Write-Host "2. Update the docker-compose.yml with the correct image URL"
Write-Host "3. Test the Umbrel app on your node"
