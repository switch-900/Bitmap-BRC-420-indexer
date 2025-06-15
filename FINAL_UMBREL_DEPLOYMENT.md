# 🎯 FINAL UMBREL DEPLOYMENT GUIDE

## ✅ WHAT'S BEEN FIXED

We've successfully addressed all the issues preventing the BRC-420 Indexer from running on Umbrel:

### Key Fixes Applied:
1. **✅ Database Initialization**: Moved database setup from separate `db/setup.js` file into `server.js` startup routine
2. **✅ Docker Compose Command**: Fixed command from `sh -c "node db/setup.js && node server.js"` to `["node", "server.js"]`
3. **✅ Standard Umbrel Environment Variables**: Properly configured to use `${APP_BITCOIN_NODE_IP}`, `${APP_ORDINALS_NODE_IP}`, etc.
4. **✅ Single Service Architecture**: Simplified from complex multi-service setup to standard Umbrel single-service pattern
5. **✅ Docker Compose Version**: Changed from 3.8 to 3.7 for Umbrel compatibility

## 🚀 DEPLOY NOW - SIMPLE STEPS

### Step 1: SSH to Your Umbrel
```bash
ssh umbrel@umbrel.local
```

### Step 2: Update and Install
```bash
cd ~/bitcoin-indexers-app-store && git pull origin main && ~/umbrel/scripts/app uninstall bitcoin-indexers-brc420 2>/dev/null; sleep 5 && ~/umbrel/scripts/app install bitcoin-indexers-brc420
```

### Step 3: Verify Installation
```bash
# Check if app is installed
~/umbrel/scripts/app ls-installed | grep bitcoin-indexers-brc420

# Check container status
docker ps | grep bitcoin-indexers-brc420

# View logs
~/umbrel/scripts/app logs bitcoin-indexers-brc420
```

## 📊 WHAT TO EXPECT

Once successfully installed, your BRC-420 Indexer will:

1. **Start up cleanly** - No more missing `db/setup.js` errors
2. **Initialize database** - Creates SQLite tables automatically on first run
3. **Connect to local services** - Uses your Umbrel's Bitcoin Core and Ordinals services
4. **Serve web interface** - Available through Umbrel dashboard
5. **Provide REST API** - Full API access for external integrations

## 🌐 ACCESS YOUR APP

After installation:
- **Umbrel Dashboard**: Look for "Bitcoin Indexers BRC420" in your installed apps
- **Direct Web Access**: The app will be accessible through Umbrel's proxy system
- **API Endpoints**: Available at the app's URL + `/api`

## 📋 VERIFICATION CHECKLIST

Run these commands to verify everything is working:

```bash
# 1. Check app is running
docker ps | grep bitcoin-indexers-brc420_web

# 2. Check database was created
ls -la ~/umbrel/app-data/bitcoin-indexers-brc420/data/

# 3. Test health endpoint (from your local machine)
curl http://umbrel.local/[app-path]/health

# 4. Check if indexing is working
~/umbrel/scripts/app logs bitcoin-indexers-brc420 | grep -i "database\|table\|connected"
```

## 🔧 TROUBLESHOOTING

If you encounter issues:

### Database Problems:
```bash
# Check database file exists and has correct permissions
ls -la ~/umbrel/app-data/bitcoin-indexers-brc420/data/brc420.db
```

### Container Issues:
```bash
# Check container logs for errors
docker logs bitcoin-indexers-brc420_web_1

# Restart the app
~/umbrel/scripts/app restart bitcoin-indexers-brc420
```

### Connectivity Issues:
```bash
# Check if Bitcoin Core and Ordinals are running
docker ps | grep -E "(bitcoin|ord)"

# Verify they're accessible
docker exec bitcoin-indexers-brc420_web_1 curl -s http://ordinals_web_1:4000/api
```

## ✨ KEY IMPROVEMENTS MADE

1. **Self-Contained**: Database initialization is now built into the main server process
2. **Umbrel-Native**: Uses all standard Umbrel environment variables and patterns
3. **Simplified Architecture**: Single service instead of complex multi-container setup
4. **Error Recovery**: Better error handling and startup resilience
5. **Standard Compliance**: Follows Umbrel app development best practices

## 🎉 SUCCESS INDICATORS

You'll know the app is working when you see:

1. ✅ Container starts without crashing
2. ✅ Database tables are created successfully
3. ✅ Web interface is accessible through Umbrel
4. ✅ API endpoints respond correctly
5. ✅ Logs show successful connection to Bitcoin Core and Ordinals

---

**Your BRC-420 Indexer is now ready to run privately on your Umbrel node!** 🎯

The app will connect to your local Bitcoin Core and Ordinals services, providing completely private inscription indexing without any external dependencies.
