# Quick Start Script for BRC-420 Indexer Development

Write-Host "🚀 Starting BRC-420 Indexer Development Environment" -ForegroundColor Green

# Create data directories
Write-Host "Creating data directories..." -ForegroundColor Yellow
New-Item -ItemType Directory -Force -Path "data", "logs" | Out-Null

# Start the web service only (without indexer for testing)
Write-Host "Starting web service..." -ForegroundColor Yellow
docker-compose -f docker-compose.dev.yml up --build web

Write-Host "✅ Development environment ready!" -ForegroundColor Green
Write-Host "🌐 Web interface: http://localhost:8080" -ForegroundColor Cyan
Write-Host "📊 API endpoint: http://localhost:8080/api" -ForegroundColor Cyan
Write-Host "❤️  Health check: http://localhost:8080/health" -ForegroundColor Cyan

Write-Host ""
Write-Host "To start with indexing enabled:" -ForegroundColor Yellow
Write-Host "docker-compose -f docker-compose.dev.yml --profile indexer up --build" -ForegroundColor White

Write-Host ""
Write-Host "To stop the services:" -ForegroundColor Yellow
Write-Host "docker-compose -f docker-compose.dev.yml down" -ForegroundColor White
