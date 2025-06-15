# 🎯 FINAL DEPLOYMENT - BRC-420 INDEXER FOR UMBREL

## ✅ WHAT'S BEEN FIXED

We've simplified the BRC-420 Indexer to work perfectly with Umbrel's standard app format:

### Key Fixes Applied:
- **✅ Single Service Architecture**: Removed complex multi-service setup
- **✅ Standard Docker Compose Version**: Changed from 3.8 to 3.7 for Umbrel compatibility
- **✅ Simplified Commands**: Combined database setup and server start into single command
- **✅ Clean Environment Variables**: Removed complex variable substitutions
- **✅ Standard Umbrel Integration**: Uses proper `${APP_BITCOIN_NODE_IP}` and `${APP_ORDINALS_NODE_IP}` variables

## 🚀 DEPLOY NOW

### Step 1: SSH to Your Umbrel
```bash
ssh umbrel@umbrel.local
```

### Step 2: Deploy with One Command
```bash
cd ~/bitcoin-indexers-app-store && git pull origin main && ~/umbrel/scripts/app uninstall bitcoin-indexers-brc420 2>/dev/null; sleep 5 && ~/umbrel/scripts/app install bitcoin-indexers-brc420
```

### Step 3: Verify Installation
```bash
~/umbrel/scripts/app ls-installed | grep bitcoin-indexers-brc420
```

## 📊 WHAT THE APP DOES

Once installed, your BRC-420 Indexer will:

1. **✅ Connect to Local Bitcoin Core** - Uses your Umbrel's Bitcoin node
2. **✅ Connect to Local Ordinals** - Uses your Umbrel's Ordinals service  
3. **✅ Index BRC-420 Inscriptions** - Automatically discovers and indexes new tokens
4. **✅ Provide Web Interface** - View tokens, holders, and statistics
5. **✅ Offer REST API** - Programmatic access to indexed data

## 🌐 ACCESS YOUR APP

After successful installation:
- **Umbrel Dashboard**: Look for "Bitcoin Indexers BRC420" in your app store
- **Direct Access**: The app will be available through your Umbrel's web interface
- **API Endpoint**: `http://umbrel.local/app-store/bitcoin-indexers-brc420/api`

## 🔍 TROUBLESHOOTING

If you encounter any issues:

```bash
# Check app logs
~/umbrel/scripts/app logs bitcoin-indexers-brc420

# Check if services are running
docker ps | grep brc420

# Restart if needed
~/umbrel/scripts/app restart bitcoin-indexers-brc420
```

## 📈 MONITORING

The app will automatically:
- Start indexing from block 792435 (BRC-420 genesis)
- Create SQLite database at `/app/db/brc420.db`
- Log activity to `/app/logs/`
- Connect to your local Bitcoin and Ordinals services

---

**🎉 You're all set! Your private, self-hosted BRC-420 indexer is ready to run on your Umbrel node.**
