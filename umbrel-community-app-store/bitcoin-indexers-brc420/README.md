# BRC-420 & Bitmap Indexer for Umbrel

A comprehensive Bitcoin inscription indexer that runs on your Umbrel node, specifically designed to index and track BRC-420 inscriptions and Bitcoin bitmap inscriptions.

## Features

- **Real-time Indexing**: Continuously monitors the Bitcoin blockchain for new BRC-420 and bitmap inscriptions
- **Robust Validation**: Implements strict validation rules for BRC-420 deploys and mints including royalty payment verification
- **Web Interface**: Clean, responsive web interface for browsing indexed inscriptions
- **REST API**: Complete API for programmatic access to indexed data
- **Error Recovery**: Automatic retry mechanism for failed blocks
- **Resource Efficient**: Optimized for running on Umbrel nodes

## How it Works

The indexer consists of two main components:

1. **Web Server** (`web` service): Serves the web interface and API endpoints
2. **Indexer Process** (`indexer` service): Continuously processes Bitcoin blocks for inscriptions

### Validation Process

- **BRC-420 Deploys**: Validates JSON structure, required fields, and deployer address
- **BRC-420 Mints**: Validates against corresponding deploy limits and verifies royalty payments
- **Bitmaps**: Validates format and bitmap number uniqueness

## Data Storage

All data is stored in a SQLite database with the following tables:
- `deploys`: BRC-420 deploy inscriptions
- `mints`: BRC-420 mint inscriptions  
- `bitmaps`: Bitmap inscriptions
- `wallets`: Wallet ownership tracking
- `blocks`: Block processing status
- `error_blocks`: Failed blocks for retry

## API Endpoints

- `GET /api/deploys` - List deploy inscriptions
- `GET /api/deploys/with-mints` - Deploys with mint counts
- `GET /api/deploy/:id/mints` - Mints for specific deploy
- `GET /api/bitmaps` - List bitmap inscriptions
- `GET /api/address/:address/inscriptions` - Inscriptions by address

## Configuration

The app uses environment variables for configuration:

- `API_URL`: Ordinals API endpoint (default: https://ordinals.com/api)
- `API_WALLET_URL`: Mempool API endpoint (default: https://mempool.space/api)
- `START_BLOCK`: Starting block height for indexing (default: 792435)
- `CONCURRENCY_LIMIT`: Number of concurrent API requests (default: 5)

## Development

Built with:
- Node.js & Express.js
- SQLite database
- Docker containerization
- Responsive HTML/CSS/JavaScript frontend

## Support

For issues and support, please visit: https://github.com/switch-900/brc-420-indexer/issues

---

**Developed with 🧡 by Switch9**
