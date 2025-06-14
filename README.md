# 🔗 BRC-420 & Bitmap Indexer for Umbrel

A comprehensive Bitcoin inscription indexer that runs privately on your Umbrel node. This application indexes BRC-420 deploys, mints, and Bitcoin bitmap inscriptions directly from your local Bitcoin Core and Ordinals services.

![BRC-420 Indexer](https://img.shields.io/badge/Bitcoin-BRC--420-orange)
![Umbrel](https://img.shields.io/badge/Umbrel-Community%20App-purple)
![Docker](https://img.shields.io/badge/Docker-Ready-blue)

## ✨ Features

- 🔍 **Real-time BRC-420 Indexing**: Monitors and validates deploy/mint inscriptions
- 🗺️ **Bitmap Support**: Tracks Bitcoin bitmap inscriptions (.bitmap format)
- 🌐 **Modern Web Interface**: Browse indexed data with responsive UI
- 🔌 **REST API**: Complete API for external integrations
- 🔒 **Privacy First**: Connects only to your local Umbrel services
- 🛡️ **Robust Validation**: Comprehensive royalty payment verification
- 💾 **Persistent Storage**: SQLite database with automatic setup
- 🔄 **Error Recovery**: Automatic retry mechanisms and error handling
- 📱 **Mobile Responsive**: Works on all device sizes

## 🏗️ Architecture

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Web Interface │    │   REST API      │    │   Indexer       │
│   (Port 8080)   │◄──►│   (Express.js)  │◄──►│   (Background)  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
                                │                        │
                                ▼                        ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   SQLite DB     │    │  Bitcoin Core   │    │   Ordinals API  │
│   (Persistent)  │    │   (RPC 8332)    │    │   (HTTP 4000)   │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

## 🚀 Installation on Umbrel

### Prerequisites

1. **Umbrel 0.5.0+** with Bitcoin Core synced
2. **Ordinals app** installed from Umbrel App Store
3. **Git** for cloning repositories

### Step 1: Add Community App Store

SSH into your Umbrel node:

```bash
ssh umbrel@umbrel.local
```

Add this community app store:

```bash
sudo ~/umbrel/scripts/app-store add https://github.com/switch-900/umbrel-bitcoin-indexers
```

### Step 2: Install from App Store

1. Open your Umbrel dashboard
2. Go to **App Store**
3. Find **"Bitcoin Indexers"** in community stores
4. Install **"BRC-420 & Bitmap Indexer"**

### Step 3: Access Your Indexer

Once installed, access via:
- **Web Interface**: `http://umbrel.local:8080`
- **API**: `http://umbrel.local:8080/api`

## 📖 Usage

### Web Interface

- **Home Page**: Browse BRC-420 deploys with mint counters
- **Deploy Details**: View specific deploy info and all mints
- **Bitmaps**: Explore Bitcoin bitmap inscriptions
- **Search**: Find specific inscriptions by ID or address

### API Endpoints

```bash
# Get all deploys with mint counts
curl http://umbrel.local:8080/api/deploys/with-mints

# Get specific deploy details
curl http://umbrel.local:8080/api/deploy/{deploy_id}/summary

# Get all mints for a deploy
curl http://umbrel.local:8080/api/deploy/{deploy_id}/mints

# Get all bitmaps
curl http://umbrel.local:8080/api/bitmaps

# Get inscriptions for an address
curl http://umbrel.local:8080/api/address/{address}/inscriptions
```

## 🛠️ Local Development

### Prerequisites

- Node.js 18+
- Docker & Docker Compose
- Access to Bitcoin Core RPC and Ordinals API

### Setup

```bash
# Clone the repository
git clone https://github.com/switch-900/brc-420-indexer.git
cd brc-420-indexer

# Install dependencies
npm install

# Copy environment template
cp .env.example .env

# Edit environment variables
nano .env
```

### Environment Configuration

```bash
# Required for indexing
START_BLOCK=792435
ORD_API_URL=http://localhost:4000/api
BITCOIN_RPC_HOST=localhost
BITCOIN_RPC_PORT=8332
BITCOIN_RPC_USER=your_rpc_user
BITCOIN_RPC_PASS=your_rpc_pass

# Optional external APIs (fallback)
API_URL=https://ordinals.com/api
API_WALLET_URL=https://mempool.space/api
```

### Running Locally

```bash
# Setup database
npm run setup-db

# Start indexer (background process)
npm run indexer &

# Start web server
npm start
```

### Docker Development

```bash
# Build image
docker build -t brc420-indexer .

# Run with Docker Compose
docker-compose -f docker-compose.dev.yml up
```

## 📊 Database Schema

The indexer creates three main tables:

### Deploys
```sql
CREATE TABLE deploys (
    id TEXT PRIMARY KEY,
    source_id TEXT UNIQUE,
    name TEXT,
    max INTEGER,
    price REAL,
    deployer_address TEXT,
    block_height INTEGER,
    timestamp INTEGER,
    wallet TEXT,
    updated_at INTEGER
);
```

### Mints
```sql
CREATE TABLE mints (
    id TEXT PRIMARY KEY,
    deploy_id TEXT,
    source_id TEXT,
    mint_address TEXT,
    transaction_id TEXT,
    block_height INTEGER,
    timestamp INTEGER,
    wallet TEXT,
    updated_at INTEGER,
    FOREIGN KEY (deploy_id) REFERENCES deploys (id)
);
```

### Bitmaps
```sql
CREATE TABLE bitmaps (
    inscription_id TEXT PRIMARY KEY,
    bitmap_number INTEGER,
    address TEXT,
    wallet TEXT,
    block_height INTEGER,
    timestamp INTEGER,
    updated_at INTEGER
);
```

## 🔧 Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `START_BLOCK` | `792435` | First block to start indexing |
| `ORD_API_URL` | - | Local Ordinals API URL |
| `BITCOIN_RPC_HOST` | - | Bitcoin Core RPC host |
| `BITCOIN_RPC_PORT` | `8332` | Bitcoin Core RPC port |
| `DB_PATH` | `./db/brc420.db` | SQLite database path |
| `PORT` | `8080` | Web server port |
| `CONCURRENCY_LIMIT` | `5` | API request concurrency |
| `MAX_RETRIES` | `3` | Maximum retry attempts |

### Indexer Behavior

- **Block Processing**: Sequential block processing with error recovery
- **Validation**: Full BRC-420 compliance checking including royalty payments
- **Retry Logic**: Failed blocks are retried with exponential backoff
- **Rate Limiting**: Respects API rate limits with automatic throttling

## 🚨 Troubleshooting

### Common Issues

1. **Indexer not starting**: Check Bitcoin Core and Ordinals are running
2. **Database locked**: Ensure proper file permissions (1000:1000)
3. **API errors**: Verify local service connectivity
4. **Missing data**: Check indexer logs for processing errors

### Diagnostic Commands

```bash
# Check container status
docker ps | grep brc420

# View indexer logs
docker logs -f bitcoin-indexers-brc420_indexer_1

# Check database
ls -la ~/umbrel/app-data/bitcoin-indexers-brc420/data/

# Test API connectivity
curl http://localhost:4000/api/blockheight
curl http://localhost:8332 -u user:pass
```

### Service Restart

```bash
# Restart the app
~/umbrel/scripts/app restart bitcoin-indexers-brc420

# Restart dependencies
~/umbrel/scripts/app restart bitcoin
~/umbrel/scripts/app restart ordinals
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- [Umbrel](https://getumbrel.com) - Self-hosting platform
- [Bitcoin Core](https://bitcoin.org) - Bitcoin full node implementation
- [Ordinals](https://ordinals.com) - Bitcoin ordinals protocol
- BRC-420 community - Inscription standard development

## 🔗 Links

- [Umbrel App Store Guidelines](https://github.com/getumbrel/umbrel-apps)
- [BRC-420 Standard](https://layer1.gitbook.io/layer1-foundation/protocols/brc-420)
- [Bitcoin Ordinals](https://docs.ordinals.com/)
- [Umbrel Community](https://community.getumbrel.com)

---

**⚡ Built for Bitcoin. Optimized for Privacy. Powered by Umbrel.**
