# 🔍 BRC-420 Indexer Troubleshooting Guide

## Step 1: Check if App is Installed

SSH to your Umbrel and run these commands:

```bash
ssh umbrel@umbrel.local

# Check if the app is listed
~/umbrel/scripts/app ls | grep brc420

# Check if containers are running
docker ps | grep brc420

# Check all bitcoin-indexers related containers
docker ps | grep bitcoin-indexers
```

## Step 2: Check App Status

```bash
# Check app status
~/umbrel/scripts/app status bitcoin-indexers-brc420

# View app logs
~/umbrel/scripts/app logs bitcoin-indexers-brc420
```

## Step 3: Check Docker Containers

If containers aren't running, check why:

```bash
# Check if containers exist but are stopped
docker ps -a | grep brc420

# Check container logs
docker logs bitcoin-indexers-brc420_web_1
docker logs bitcoin-indexers-brc420_indexer_1
docker logs bitcoin-indexers-brc420_db-setup_1
```

## Step 4: Check Dependencies

Your app requires Bitcoin Core and Ordinals to be running:

```bash
# Check if Bitcoin Core is running
docker ps | grep bitcoin

# Check if Ordinals is running  
docker ps | grep ordinals

# Test Ordinals API connectivity
curl http://localhost:4000/api/blockheight
```

## Step 5: Manual Container Check

If nothing is running, try to see what's happening:

```bash
# Check if the image was pulled
docker images | grep brc420

# Check app data directory
ls -la ~/umbrel/app-data/ | grep bitcoin-indexers

# Check for any error messages
journalctl -u umbrel --since "10 minutes ago" | grep -i brc420
```

## Step 6: Force Restart

If the app seems stuck:

```bash
# Stop the app
~/umbrel/scripts/app stop bitcoin-indexers-brc420

# Start the app
~/umbrel/scripts/app start bitcoin-indexers-brc420

# Or restart
~/umbrel/scripts/app restart bitcoin-indexers-brc420
```

## Step 7: Check Network Access

Test if you can reach the web interface:

```bash
# Test from Umbrel itself
curl http://localhost:8080

# Check what's listening on port 8080
netstat -tlnp | grep 8080

# Check if port is accessible from your computer
curl http://umbrel.local:8080
```

## Common Issues & Solutions

### Issue 1: Docker Image Not Found
**Error**: Image pull failed
**Solution**: Check if GitHub Actions built the image correctly at:
`https://github.com/switch-900/brc-420-indexer/actions`

### Issue 2: Dependencies Not Running
**Error**: Cannot connect to Bitcoin Core or Ordinals
**Solution**: Install Bitcoin and Ordinals apps first from Umbrel App Store

### Issue 3: Port Conflict
**Error**: Port 8080 already in use
**Solution**: Check what's using the port and stop it

### Issue 4: Permissions Error
**Error**: Database permissions denied
**Solution**: 
```bash
sudo chown -R 1000:1000 ~/umbrel/app-data/bitcoin-indexers-brc420/
```

## Quick Diagnostic Script

Run this one-liner to get all important info:

```bash
echo "=== App Status ===" && ~/umbrel/scripts/app status bitcoin-indexers-brc420 && echo -e "\n=== Containers ===" && docker ps | grep -E "(brc420|bitcoin-indexers)" && echo -e "\n=== Dependencies ===" && docker ps | grep -E "(bitcoin|ordinals)" && echo -e "\n=== Port Check ===" && netstat -tlnp | grep 8080 && echo -e "\n=== API Test ===" && curl -s http://localhost:8080/api/deploys | head -n 5
```

---

**Run these commands and let me know what output you get!** 🔍
