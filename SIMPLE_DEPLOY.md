# 🎯 Simple Git Deployment Guide

**Use your preferred Git app (GitHub Desktop, VS Code, GitKraken, etc.) - much easier than scripts!**

## 📋 **Quick Steps**

### 1. **Create GitHub Repositories**

Go to [github.com/new](https://github.com/new) and create:

1. **Main Repository**: `brc-420-indexer`
   - Description: `BRC-420 & Bitmap Indexer for Umbrel - Private Bitcoin inscription indexing`
   - Public ✓
   - Don't initialize with README (we have one)

2. **App Store Repository**: `umbrel-bitcoin-indexers`  
   - Description: `Bitcoin indexing tools for Umbrel - Community App Store`
   - Public ✓
   - Don't initialize with README

### 2. **Upload Main Repository**

**Option A: Using GitHub Desktop**
1. Open GitHub Desktop
2. File → Add Local Repository
3. Choose: `c:\Users\Naomi\brc-420-indexer-1`
4. Publish to GitHub → `switch-900/brc-420-indexer`

**Option B: Using VS Code**
1. Open folder in VS Code
2. Source Control tab (Ctrl+Shift+G)
3. Initialize Repository
4. Stage all files, commit with message:
   ```
   Initial commit: BRC-420 & Bitmap Indexer for Umbrel
   
   Complete Bitcoin inscription indexer with web UI, REST API, 
   Docker containerization, and Umbrel integration.
   ```
5. Publish to GitHub

**Option C: Command Line (if you prefer)**
```bash
git init
git add .
git commit -m "Initial commit: BRC-420 & Bitmap Indexer for Umbrel"
git branch -M main
git remote add origin https://github.com/switch-900/brc-420-indexer.git
git push -u origin main
```

### 3. **Setup App Store Repository**

1. **Clone the app store repo:**
   ```bash
   git clone https://github.com/switch-900/umbrel-bitcoin-indexers.git
   cd umbrel-bitcoin-indexers
   ```

2. **Copy app store files:**
   ```bash
   Copy-Item -Recurse "c:\Users\Naomi\brc-420-indexer-1\umbrel-community-app-store\*" .
   ```

3. **Commit and push using your Git app or:**
   ```bash
   git add .
   git commit -m "Add BRC-420 Indexer Umbrel app"
   git push origin main
   ```

### 4. **Install on Umbrel**

SSH to your Umbrel:
```bash
ssh umbrel@umbrel.local
sudo ~/umbrel/scripts/app-store add https://github.com/switch-900/umbrel-bitcoin-indexers
```

Then install via Umbrel dashboard: **App Store** → **Bitcoin Indexers** → **BRC-420 & Bitmap Indexer**

## ✅ **Repository URLs**

- **Main App**: https://github.com/switch-900/brc-420-indexer
- **App Store**: https://github.com/switch-900/umbrel-bitcoin-indexers

## 🎉 **That's It!**

Much simpler than complex scripts. GitHub Actions will automatically build your Docker images when you push to the main repository.

**Access your indexer at**: `http://umbrel.local:8080` after installation.
