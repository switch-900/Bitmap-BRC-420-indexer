# 🚀 DEPLOY TO UMBREL - SIMPLIFIED CONFIGURATION

## Step 1: Connect to Your Umbrel System

```bash
ssh umbrel@umbrel.local
```

## Step 2: Pull Latest Changes and Install

Run this single command on your Umbrel system:

```bash
cd ~/bitcoin-indexers-app-store && git pull origin main && ~/umbrel/scripts/app uninstall bitcoin-indexers-brc420 2>/dev/null; sleep 5 && ~/umbrel/scripts/app install bitcoin-indexers-brc420
```

## What This Command Does:

1. **Navigate** to the app store directory
2. **Pull latest changes** from GitHub (includes the simplified docker-compose.yml)
3. **Uninstall existing app** (if installed) and ignore errors if not installed
4. **Wait 5 seconds** for clean uninstall
5. **Install the app** with the new simplified configuration

## Expected Output:

✅ **Success**: You should see the app install successfully without Docker Compose errors

## Verification:

After installation, check the app status:

```bash
~/umbrel/scripts/app ls-installed | grep bitcoin-indexers-brc420
```

And view logs if needed:

```bash
~/umbrel/scripts/app logs bitcoin-indexers-brc420
```

## Key Changes Made:

- ✅ **Simplified docker-compose.yml** to use single service pattern
- ✅ **Changed version** from 3.8 to 3.7 for Umbrel compatibility  
- ✅ **Removed complex dependencies** and multi-service setup
- ✅ **Combined database setup and server start** into single command
- ✅ **Standard Umbrel environment variables** for Bitcoin Core and Ordinals

The app should now install cleanly and be accessible through your Umbrel dashboard!
