# BRC-420 Indexer - Network Connectivity Fix

## 🎯 **ISSUE RESOLVED**

**Problem**: The indexer was getting `getaddrinfo ENOTFOUND umbrel.local` errors because Docker containers couldn't resolve the `umbrel.local` hostname.

**Root Cause**: Docker networking isolation prevents containers from resolving local hostnames that work on the host machine.

## ✅ **FIXES APPLIED**

### 1. **Smart API Fallback System**
- **Primary**: Uses reliable external API (`https://ordinals.com/api`) by default
- **Secondary**: Tests local API connectivity (`umbrel.local:4000`) and switches if available
- **Fallback**: Automatically switches back to external if local fails during operation

### 2. **Enhanced Error Handling**
- Added network timeout protection (10 seconds)
- Detects specific network errors (`ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`)
- Graceful fallback without stopping the indexer

### 3. **Configuration Improvements**
- `getApiUrl()` now returns external API by default for reliability
- `getLocalApiUrl()` handles local testing separately
- Proper URL formatting with scheme detection

### 4. **YAML Formatting Fixed**
- Fixed all missing newlines in `docker-compose.yml`
- Proper indentation throughout
- Clean environment variable structure

## 🚀 **EXPECTED BEHAVIOR NOW**

When you install the app:

1. **✅ Container starts successfully** (no more YAML errors)
2. **✅ Database initializes properly** (as shown in your logs)
3. **✅ Web server starts on port 8080** (accessible via Umbrel)
4. **✅ Indexer tests local API** (`umbrel.local:4000`)
5. **✅ Falls back to external API** (`ordinals.com`) if local unavailable
6. **✅ Begins indexing blocks** starting from block 792435

## 📋 **NEXT STEPS**

### **Try the Fixed Version:**

1. **Uninstall current app**:
   ```bash
   umbrel app uninstall bitcoin-indexers-brc420
   ```

2. **Update app store** (if needed):
   ```bash
   cd ~/umbrel/app-stores/bitcoin-indexers-app-store
   git pull origin main
   ```

3. **Reinstall app**:
   ```bash
   umbrel app install bitcoin-indexers-brc420
   ```

### **Monitor the Logs:**
```bash
docker logs bitcoin-indexers-brc420_web_1 -f
```

**You should now see:**
```
✅ Starting Bitcoin inscription indexer...
✅ Testing local API connectivity: http://umbrel.local:4000/api
✅ Local API not available, using external API: https://ordinals.com/api
✅ Starting to process block 792435
✅ Total inscriptions found in block 792435: [number]
```

## 🔧 **TECHNICAL DETAILS**

### **API Priority Logic:**
1. **Default**: `https://ordinals.com/api` (reliable, always works)
2. **Test**: `http://umbrel.local:4000/api` (if available)
3. **Switch**: Uses local if test succeeds
4. **Fallback**: Returns to external if local fails later

### **Network Error Handling:**
- `ENOTFOUND`: Hostname resolution failure → switch to external
- `ECONNREFUSED`: Service not running → switch to external  
- `ETIMEDOUT`: Network timeout → switch to external

### **Environment Variables:**
```yaml
# External APIs (reliable defaults)
API_URL: https://ordinals.com/api
API_WALLET_URL: https://mempool.space/api

# Local APIs (tested and used if available)
ORD_API_URL: http://umbrel.local:4000/api
```

## ✅ **VERIFICATION CHECKLIST**

After reinstallation, verify:

- [ ] App installs without YAML errors
- [ ] Web interface loads on port 8080
- [ ] Database tables are created
- [ ] Indexer starts processing blocks
- [ ] No more `ENOTFOUND umbrel.local` errors
- [ ] Blocks are being processed (check logs)

## 🎉 **RESULT**

Your BRC-420 indexer should now work reliably on Umbrel, automatically using the best available API source without any manual configuration!
