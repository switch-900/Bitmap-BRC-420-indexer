# 🔧 AUTOMATIC PERMISSION FIX - No Manual Steps Required!

## 🎯 What We Fixed

1. **✅ Automatic Directory Permissions**: Added entrypoint script to handle permissions automatically
2. **✅ User Specification**: Explicit `user: "1000:1000"` in docker-compose.yml  
3. **✅ Server Stability**: Prevent crashes when database can't be opened 
4. **✅ Fallback Handling**: Continue running web server even with database issues
5. **✅ Better Logging**: More detailed error messages for troubleshooting

## 🚀 Deploy Latest Fix

### Wait 2-3 minutes for GitHub Actions to build, then run:

```bash
ssh umbrel@umbrel.local
```

Then execute this command on Umbrel:

```bash
# Pull latest Docker image and restart app (no manual permission fixes needed!)
docker pull ghcr.io/switch-900/brc-420-indexer:latest && \
~/umbrel/scripts/app restart bitcoin-indexers-brc420
```

## 🔍 What This Command Does:

1. **Pull latest image** with automatic permission handling
2. **Restart the app** with new entrypoint script that sets up directories

## ✅ Expected Result:

You should see:
- ✅ Entrypoint script setting up directories automatically
- ✅ Database directory creation with proper permissions
- ✅ Web server staying running (no more crashes)
- ✅ App accessible through Umbrel dashboard
- ✅ No more `SQLITE_CANTOPEN` errors
- ✅ **No manual permission fixing required by users!**

## 🌐 Access Your App:

Once fixed, the BRC-420 Indexer will be accessible through your Umbrel dashboard or directly at the app's URL.

---

**This should resolve both the database permission issue and the server stability problem!** 🎯
