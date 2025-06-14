# 🚀 BRC-420 Indexer - Ready to Install!

## Installation Steps

### 1. Access Umbrel App Store
Open your Umbrel dashboard: http://umbrel.local

### 2. Navigate to Community Apps
- Go to **App Store**
- Click on **Community App Stores** tab
- You should see "Bitcoin Indexers" in the list

### 3. Install BRC-420 Indexer
- Click on "Bitcoin Indexers" store
- Find "BRC-420 Indexer" app
- Click **Install**
- Wait for installation to complete

### 4. Dependencies Check
The app requires these to be installed first:
- ✅ **Bitcoin Core** (should already be running)
- ✅ **Ordinals** (should already be running)

### 5. Access the App
Once installed, access the BRC-420 Indexer at:
- **Web Interface**: http://umbrel.local:8080
- **API Endpoint**: http://umbrel.local:8080/api

## What to Expect

### After Installation:
1. **Database Setup**: App will automatically create SQLite database
2. **Service Connection**: Will connect to local Bitcoin Core (port 8332) and Ordinals (port 4000)
3. **Web Interface**: Beautiful UI for browsing inscriptions and deployments
4. **API Access**: REST API for programmatic access to indexed data

### Key Features:
- 📊 **Real-time Indexing**: Processes Bitcoin inscriptions as they happen
- 🔍 **Search & Filter**: Find specific BRC-420 tokens and deployments
- 📈 **Analytics**: View token statistics and deployment history
- 🔗 **Local Only**: All data stays on your Umbrel, no external dependencies
- ⚡ **Fast API**: Optimized SQLite database with proper indexing

## Troubleshooting

### If Installation Fails:
```bash
# SSH into Umbrel and check logs
ssh umbrel@umbrel.local
cd ~/umbrel
./scripts/app logs bitcoin-indexers-brc420
```

### If App Won't Start:
```bash
# Check if dependencies are running
./scripts/app ls | grep -E "(bitcoin|ordinals)"

# Check container status
docker ps | grep brc-420-indexer
```

### If Can't Access Web Interface:
- Wait 2-3 minutes after installation for full startup
- Check that port 8080 isn't blocked
- Try accessing directly: http://[UMBREL_IP]:8080

## Success Indicators

✅ **App Installed**: Shows in Umbrel app list  
✅ **Container Running**: `docker ps` shows brc-420-indexer container  
✅ **Web Accessible**: Can open http://umbrel.local:8080  
✅ **API Working**: GET http://umbrel.local:8080/api/deploys returns data  
✅ **Database Created**: SQLite database contains indexed data  

---

**Ready to install? Go to your Umbrel dashboard now!** 🎯
