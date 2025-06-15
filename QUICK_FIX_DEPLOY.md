# 🔧 QUICK FIX DEPLOYMENT - Database Permissions Fixed

## 🎯 What We Fixed

1. **✅ Database Permissions**: Added proper directory permissions and error handling
2. **✅ Server Stability**: Prevent crashes when database can't be opened 
3. **✅ Fallback Handling**: Continue running web server even with database issues
4. **✅ Better Logging**: More detailed error messages for troubleshooting

## 🚀 Deploy Latest Fix

### Wait 2-3 minutes for GitHub Actions to build, then run:

```bash
ssh umbrel@umbrel.local
```

Then execute this command on Umbrel:

```bash
# Pull latest Docker image and restart app
docker pull ghcr.io/switch-900/brc-420-indexer:latest && \
docker stop bitcoin-indexers-brc420_web_1 && \
docker rm bitcoin-indexers-brc420_web_1 && \
cd ~/umbrel/app-data/bitcoin-indexers-brc420 && \
sudo chown -R 1000:1000 data/ logs/ && \
~/umbrel/scripts/app restart bitcoin-indexers-brc420
```

## 🔍 What This Command Does:

1. **Pull latest image** with database permission fixes
2. **Stop and remove** the old container
3. **Fix directory permissions** on Umbrel host (1000:1000 for user)
4. **Restart the app** with new configuration

## ✅ Expected Result:

You should see:
- ✅ Database directory creation with proper permissions
- ✅ Web server staying running (no more crashes)
- ✅ App accessible through Umbrel dashboard
- ✅ No more `SQLITE_CANTOPEN` errors

## 🌐 Access Your App:

Once fixed, the BRC-420 Indexer will be accessible through your Umbrel dashboard or directly at the app's URL.

---

**This should resolve both the database permission issue and the server stability problem!** 🎯
