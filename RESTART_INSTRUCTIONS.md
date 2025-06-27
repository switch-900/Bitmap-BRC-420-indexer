# Restart Instructions for External Node

## Changes Made That Require Restart

### 1. ✅ Database Schema Changes (server.js)
- **Added**: `parcels` table with all required columns
- **Added**: Proper indexes for parcels table
- **Updated**: Table count from 9 to 10
- **Result**: Will fix `SQLITE_ERROR: no such table: parcels`

### 2. ✅ Docker Health Check (docker-compose.yml)
- **Added**: Health check endpoint for web service
- **Added**: Service dependency (app_proxy waits for web to be healthy)
- **Result**: Will fix `ECONNREFUSED` proxy connection errors

### 3. ✅ Code Cleanup (index-runner.js)
- **Removed**: 13 unused functions (~300 lines)
- **Result**: Cleaner, more maintainable code

## How to Apply Changes

### Option 1: Umbrel App System
```bash
# Through Umbrel interface:
1. Go to App Store → Installed Apps
2. Find "Bitcoin Indexers BRC-420" 
3. Click "Stop" then "Start"
# OR
4. Click "Restart" if available
```

### Option 2: Manual Docker (if you have docker-compose.yml)
```bash
# Navigate to the docker-compose.yml directory
cd /path/to/bitcoin-indexers-brc420/

# Stop services
docker-compose down

# Start services with new configuration
docker-compose up -d

# Check logs
docker-compose logs -f web
```

### Option 3: Docker Compose v2 Syntax
```bash
# Navigate to the docker-compose.yml directory
cd /path/to/bitcoin-indexers-brc420/

# Stop services
docker compose down

# Start services with new configuration
docker compose up -d

# Check logs
docker compose logs -f web
```

### Option 4: Direct Node.js (for testing)
```bash
# Navigate to project directory
cd /path/to/Bitmap-BRC-420-indexer/

# Install dependencies if needed
npm install

# Run the server directly
node server.js
```

## Verification After Restart

### ✅ Check Database Schema
The parcels table should be created automatically on startup. Look for this log:
```
Parcels table created or already exists
```

### ✅ Check Health Endpoint
Visit: `http://your-node:8080/health`
Should return:
```json
{
  "status": "healthy",
  "timestamp": "2025-06-27T...",
  "service": "BRC-420 Indexer",
  "version": "1.0.0",
  "ready": true
}
```

### ✅ Check Proxy Connection
The app_proxy should now wait for web service to be healthy before starting.
No more `ECONNREFUSED` errors in logs.

### ✅ Check Parcel Processing
Look for logs like:
```
Parcel saved: <inscription_id>
```
Instead of:
```
Error tracking known inscription transfers: no such table: parcels
```

## Current Status

Your indexer is **already working great**:
- ✅ Processing blocks successfully (792668, 792669, 792670...)
- ✅ 100% completeness rate 
- ✅ Using local APIs correctly
- ✅ No processing errors

These fixes will eliminate the infrastructure issues:
- 🔧 Database errors will stop
- 🔧 Proxy connection will be stable
- 🔧 Code is now cleaner and more maintainable

## Next Steps

1. **Restart using your preferred method above**
2. **Monitor logs** for the "Parcels table created" message
3. **Verify** no more "no such table: parcels" errors
4. **Check** that proxy connects successfully
5. **Test** the web interface at your node's IP:8080

Let me know which restart method you prefer and I can provide more specific instructions!
