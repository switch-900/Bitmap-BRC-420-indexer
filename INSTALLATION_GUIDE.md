# BRC-420 & Bitmap Indexer - Installation Guide

## 🎯 **CURRENT STATUS - READY FOR DEPLOYMENT**

The BRC-420 indexer has been fully debugged and optimized for Umbrel deployment with the following critical fixes applied:

### ✅ **Issues Resolved:**

1. **API Endpoints Corrected**
   - Fixed external API: `https://ordinals.com` (removed incorrect `/api` suffix)
   - Fixed local API: `http://umbrel.local:4000` (proper Umbrel hostname)
   - All ord JSON endpoints now working correctly

2. **YAML Formatting Fixed**
   - Resolved all docker-compose.yml syntax errors
   - Proper indentation and newlines throughout
   - Clean, valid YAML structure

3. **Network Connectivity Enhanced**
   - Smart fallback from local to external APIs
   - Proper error handling for network issues
   - Automatic detection of available services

4. **Auto-Start Functionality**
   - Indexer starts automatically with the app
   - RUN_INDEXER environment variable configured
   - Proper database initialization

## 🚀 **INSTALLATION INSTRUCTIONS**

### **1. Update App Store**
```bash
cd ~/umbrel/app-stores/bitcoin-indexers-app-store
git pull origin main
```

### **2. Install the App**
```bash
# If previously installed, uninstall first
umbrel app uninstall bitcoin-indexers-brc420

# Fresh installation
umbrel app install bitcoin-indexers-brc420
```

### **3. Monitor Installation**
```bash
# Check container logs
docker logs bitcoin-indexers-brc420_web_1 -f

# Check app status
umbrel app list | grep bitcoin-indexers-brc420
```

## 📊 **Expected Log Output**

### **Successful Installation:**
```
✅ Setting up directory permissions for UID 1000...
✅ Permissions set successfully!
✅ Database setup completed successfully
✅ BRC-420 Indexer web server running on http://0.0.0.0:8080
✅ Starting Bitcoin inscription indexer...
✅ Testing local API connectivity: http://umbrel.local:4000
✅ Local API available! Using local Ordinals service
✅ Starting to process block 792435
✅ Total inscriptions found in block 792435: [number]
```

### **With External Fallback:**
```
✅ Testing local API connectivity: http://umbrel.local:4000
✅ Local API not available, using external: https://ordinals.com
✅ Starting to process block 792435
✅ Total inscriptions found in block 792435: [number]
```

## 🔧 **Features**

- **BRC-420 Token Indexing**: Complete deploy and mint validation
- **Bitmap Inscription Support**: Track and validate Bitcoin bitmaps
- **Local Ordinals Integration**: Prioritizes local services for privacy
- **Web Interface**: Beautiful UI for browsing indexed data
- **RESTful API**: Full API for querying inscription data
- **Auto-Recovery**: Handles network failures gracefully

## 📋 **API Endpoints**

The indexer provides these API endpoints:

### **General**
- `GET /api/health` - Health check
- `GET /api/config` - Configuration info

### **BRC-420 Data**
- `GET /api/deploys` - All deploy inscriptions
- `GET /api/deploy/{id}` - Specific deploy
- `GET /api/deploy/{id}/mints` - Mints for a deploy

### **Bitmaps**
- `GET /api/bitmaps` - All bitmap inscriptions
- `GET /api/bitmap/{id}` - Specific bitmap
- `GET /api/bitmaps/number/{number}` - Bitmaps by number

### **Addresses**
- `GET /api/address/{address}/inscriptions` - All inscriptions for address

## 🆘 **Troubleshooting**

### **Installation Fails**
```bash
# Clear Docker cache
docker system prune -f

# Update app store
cd ~/umbrel/app-stores/bitcoin-indexers-app-store
git pull origin main

# Retry installation
umbrel app install bitcoin-indexers-brc420
```

### **404 Errors in Logs**
- Check if Ordinals service is running: `docker ps | grep ordinals`
- Verify network connectivity to `umbrel.local:4000`
- App will automatically fallback to external APIs

### **Database Issues**
- Database auto-initializes on first run
- Persistent storage in `${APP_DATA_DIR}/data`
- Tables: deploys, mints, bitmaps, blocks, error_blocks

## 🎉 **Success Verification**

After successful installation:

1. **Web Interface**: Visit your Umbrel dashboard, click the BRC-420 app
2. **API Access**: `http://your-umbrel:port/api/health`
3. **Data Processing**: Check logs for "Total inscriptions found" messages
4. **Database Growth**: Query endpoints to see indexed data

## 📞 **Support**

- **GitHub Issues**: https://github.com/switch-900/brc-420-indexer/issues
- **Repository**: https://github.com/switch-900/brc-420-indexer
- **App Store**: https://github.com/switch-900/bitcoin-indexers-app-store

---

**Last Updated**: June 15, 2025
**Status**: ✅ Production Ready
