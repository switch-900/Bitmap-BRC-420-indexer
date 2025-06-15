# PowerShell script to check GitHub Actions build status and provide update instructions
# Run this script to monitor the build and get update instructions

Write-Host "BRC-420 Indexer - Checking Build Status..." -ForegroundColor Green

# Function to check GitHub Actions status
function Get-BuildStatus {
    try {
        $response = Invoke-RestMethod -Uri "https://api.github.com/repos/switch-900/brc-420-indexer/actions/runs" -Headers @{
            "Accept" = "application/vnd.github.v3+json"
        }
        
        $latestRun = $response.workflow_runs | Where-Object { $_.head_branch -eq "main" } | Select-Object -First 1
        
        Write-Host "Latest Build Status: $($latestRun.status) - $($latestRun.conclusion)" -ForegroundColor Yellow
        Write-Host "Started: $($latestRun.created_at)"
        Write-Host "URL: $($latestRun.html_url)"
        
        if ($latestRun.status -eq "completed" -and $latestRun.conclusion -eq "success") {
            Write-Host "Build completed successfully!" -ForegroundColor Green
            return $true
        } else {
            Write-Host "Build still in progress..." -ForegroundColor Yellow
            return $false
        }
    } catch {
        Write-Host "Error checking build status: $_" -ForegroundColor Red
        return $false
    }
}

# Check build status
$buildComplete = Get-BuildStatus

Write-Host ""
Write-Host "UPDATE INSTRUCTIONS:" -ForegroundColor Cyan
Write-Host ""

if ($buildComplete) {
    Write-Host "Docker image is ready! Follow these steps on your Umbrel device:" -ForegroundColor Green
} else {
    Write-Host "Wait for build to complete, then follow these steps on your Umbrel device:" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "1. SSH to your Umbrel:" -ForegroundColor White
Write-Host "   ssh umbrel@[UMBREL_IP]" -ForegroundColor Gray
Write-Host ""
Write-Host "2. Pull the latest image:" -ForegroundColor White
Write-Host "   docker pull ghcr.io/switch-900/brc-420-indexer:latest" -ForegroundColor Gray
Write-Host ""
Write-Host "3. Restart the app:" -ForegroundColor White
Write-Host "   ~/umbrel/scripts/app restart bitcoin-indexers-brc420" -ForegroundColor Gray
Write-Host ""
Write-Host "4. Monitor the indexer:" -ForegroundColor White
Write-Host "   docker logs -f bitcoin-indexers-brc420_web_1" -ForegroundColor Gray
Write-Host ""
Write-Host "WHAT TO EXPECT:" -ForegroundColor Cyan
Write-Host "- Web server starts on port 8080" -ForegroundColor White
Write-Host "- Indexer process begins automatically (RUN_INDEXER=true)" -ForegroundColor White
Write-Host "- Database starts populating with Bitcoin inscriptions" -ForegroundColor White
Write-Host "- Processing begins from block 792435 (BRC-420 genesis)" -ForegroundColor White
Write-Host "- You'll see logs showing block processing progress" -ForegroundColor White
Write-Host ""
Write-Host "Access your indexer at: http://umbrel.local:3420" -ForegroundColor Green
Write-Host ""

if (-not $buildComplete) {
    Write-Host "Waiting for build to complete..." -ForegroundColor Yellow
    Write-Host "Re-run this script to check status again" -ForegroundColor Gray
    Write-Host "Or check: https://github.com/switch-900/brc-420-indexer/actions" -ForegroundColor Gray
}
