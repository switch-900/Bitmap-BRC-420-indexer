# 📋 Quick Deploy Checklist

## ✅ Pre-Deployment Checklist

- [ ] All code files are ready and tested
- [ ] Docker configuration validated
- [ ] Environment variables configured
- [ ] Documentation complete
- [ ] .gitignore file in place

## 🚀 Git Repository Setup

**💡 Recommended: Use GitHub Desktop, VS Code, or your preferred Git GUI app**

See [`SIMPLE_DEPLOY.md`](SIMPLE_DEPLOY.md) for the easiest deployment method.

### Manual Commands (if preferred):

### 1. Main Repository (brc-420-indexer)
```powershell
cd "c:\Users\Naomi\brc-420-indexer-1"
git init
git add .
git commit -m "Initial commit: BRC-420 & Bitmap Indexer for Umbrel"
git remote add origin https://github.com/switch-900/brc-420-indexer.git
git push -u origin main
```

### 2. App Store Repository (umbrel-bitcoin-indexers)
```powershell
git clone https://github.com/switch-900/umbrel-bitcoin-indexers.git
cd umbrel-bitcoin-indexers
Copy-Item -Recurse "c:\Users\Naomi\brc-420-indexer-1\umbrel-community-app-store\*" .
git add .
git commit -m "Add BRC-420 Indexer Umbrel app"
git push origin main
```

## 🐳 Update Docker References

Edit `bitcoin-indexers-brc420/docker-compose.yml` and change:
```yaml
# From:
image: ghcr.io/yourusername/brc-420-indexer:latest

# To:
image: ghcr.io/switch-900/brc-420-indexer:latest
```

## 🎯 Umbrel Installation

### SSH to Umbrel:
```bash
ssh umbrel@umbrel.local
```

### Add App Store:
```bash
sudo ~/umbrel/scripts/app-store add https://github.com/switch-900/umbrel-bitcoin-indexers
```

### Install via Dashboard:
1. Open Umbrel dashboard
2. Go to App Store
3. Find "Bitcoin Indexers" 
4. Install "BRC-420 & Bitmap Indexer"

## 🔍 Verification

### Check Installation:
```bash
docker ps | grep brc420
docker logs bitcoin-indexers-brc420_indexer_1
```

### Test Access:
- Web: `http://umbrel.local:8080`
- API: `http://umbrel.local:8080/api/deploys`

## 📱 Repository Structure

```
switch-900/brc-420-indexer/
├── README.md                    # Main documentation
├── Dockerfile                   # Container build
├── docker-compose.dev.yml       # Local development
├── package.json                 # Node.js dependencies
├── .github/workflows/           # Auto Docker builds
└── src/                         # Application code

switch-900/umbrel-bitcoin-indexers/
├── umbrel-app-store.yml         # Store metadata  
└── bitcoin-indexers-brc420/     # App package
    ├── umbrel-app.yml           # App manifest
    └── docker-compose.yml       # Production config
```

## 🛠️ Troubleshooting Commands

```bash
# Check app status
~/umbrel/scripts/app ls

# Restart app
~/umbrel/scripts/app restart bitcoin-indexers-brc420

# View logs
docker logs -f bitcoin-indexers-brc420_indexer_1

# Check dependencies
docker ps | grep -E "(bitcoin|ordinals)"

# Test connectivity
curl http://localhost:4000/api/blockheight
curl http://localhost:8080/api/deploys
```

## 📚 Documentation:
- **README.md** - Complete project documentation
- **SIMPLE_DEPLOY.md** - Easy deployment with Git GUI apps  
- **QUICK_DEPLOY.md** - This reference checklist

---

**🎉 Ready to deploy your private Bitcoin inscription indexer!**
