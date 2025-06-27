# BRC-420 Indexer Database Documentation

## Overview

The BRC-420 Indexer is a comprehensive Bitcoin Ordinals indexing system that tracks BRC-420 tokens, Bitmap inscriptions, and Parcel inscriptions. It uses SQLite as the database backend with optimizations for high-volume data processing and local node deployment.

## Database Schema

### Core Tables

#### 1. `deploys` - BRC-420 Token Deployments
Stores BRC-420 token deployment inscriptions.

**Schema:**
```sql
CREATE TABLE deploys (
    id TEXT PRIMARY KEY,              -- Inscription ID of the deploy
    name TEXT NOT NULL,               -- Token name
    max INTEGER NOT NULL,             -- Maximum supply
    price REAL NOT NULL,              -- Price per mint in BTC
    deployer_address TEXT NOT NULL,   -- Address that deployed the token
    block_height INTEGER NOT NULL,    -- Block height of deployment
    timestamp INTEGER NOT NULL,       -- Unix timestamp
    source_id TEXT NOT NULL,          -- Source inscription ID
    wallet TEXT                       -- Current wallet address
);
```

**What's Indexed:**
- BRC-420 deploy inscriptions with format: `{"p":"brc-420","op":"deploy","id":"...","name":"...","max":...,"price":...}`
- Validates deployer ownership of source inscription
- Ensures unique deployments (no duplicate source inscriptions)

**Example Data:**
```json
{
    "id": "abc123...i0",
    "name": "EXAMPLE",
    "max": 1000,
    "price": 0.001,
    "deployer_address": "bc1q...",
    "block_height": 792435,
    "timestamp": 1677123456,
    "source_id": "abc123...i0",
    "wallet": "bc1q..."
}
```

#### 2. `mints` - BRC-420 Token Mints
Stores BRC-420 token mint inscriptions.

**Schema:**
```sql
CREATE TABLE mints (
    id TEXT PRIMARY KEY,              -- Inscription ID of the mint
    deploy_id TEXT NOT NULL,          -- Reference to deploy inscription
    source_id TEXT NOT NULL,          -- Source inscription ID from deploy
    mint_address TEXT NOT NULL,       -- Address that minted the token
    transaction_id TEXT NOT NULL,     -- Transaction ID of the mint
    block_height INTEGER NOT NULL,    -- Block height of mint
    timestamp INTEGER NOT NULL,       -- Unix timestamp
    wallet TEXT                       -- Current wallet address
);
```

**What's Indexed:**
- BRC-420 mint inscriptions with format: `/content/<INSCRIPTION_ID>`
- Validates mint references valid deploy
- Validates royalty payment to deployer
- Validates content type matches source
- Enforces max supply limits

**Example Data:**
```json
{
    "id": "def456...i0",
    "deploy_id": "abc123...i0",
    "source_id": "abc123...i0",
    "mint_address": "bc1q...",
    "transaction_id": "def456...",
    "block_height": 792436,
    "timestamp": 1677123500,
    "wallet": "bc1q..."
}
```

#### 3. `bitmaps` - Bitmap Inscriptions
Stores Bitcoin block bitmap inscriptions.

**Schema:**
```sql
CREATE TABLE bitmaps (
    inscription_id TEXT PRIMARY KEY,  -- Inscription ID
    bitmap_number INTEGER NOT NULL,   -- Bitmap number (block height)
    content TEXT NOT NULL,            -- Content (e.g., "792435.bitmap")
    address TEXT NOT NULL,            -- Original mint address
    block_height INTEGER NOT NULL,    -- Block height of inscription
    timestamp INTEGER NOT NULL,       -- Unix timestamp
    sat INTEGER,                      -- Satoshi number
    wallet TEXT                       -- Current wallet address
);
```

**What's Indexed:**
- Bitmap inscriptions with format: `<NUMBER>.bitmap`
- Validates bitmap number ≤ block height
- Tracks original mint address and current wallet
- Generates visualization patterns

**Example Data:**
```json
{
    "inscription_id": "ghi789...i0",
    "bitmap_number": 792435,
    "content": "792435.bitmap",
    "address": "bc1q...",
    "block_height": 792436,
    "timestamp": 1677123600,
    "sat": 1234567890,
    "wallet": "bc1q..."
}
```

#### 4. `parcels` - Parcel Inscriptions
Stores parcel subdivisions of bitmap inscriptions.

**Schema:**
```sql
CREATE TABLE parcels (
    inscription_id TEXT PRIMARY KEY,      -- Inscription ID
    parcel_number INTEGER NOT NULL,       -- Parcel number within bitmap
    bitmap_number INTEGER NOT NULL,       -- Parent bitmap number
    bitmap_inscription_id TEXT NOT NULL,  -- Parent bitmap inscription ID
    content TEXT NOT NULL,                -- Content (e.g., "5.792435.bitmap")
    address TEXT NOT NULL,                -- Original mint address
    block_height INTEGER NOT NULL,        -- Block height of inscription
    timestamp INTEGER NOT NULL,           -- Unix timestamp
    transaction_count INTEGER,            -- Block transaction count
    is_valid INTEGER DEFAULT 0,           -- Validation status
    wallet TEXT                           -- Current wallet address
);
```

**What's Indexed:**
- Parcel inscriptions with format: `<PARCEL_NUMBER>.<BITMAP_NUMBER>.bitmap`
- Validates parcel is child of parent bitmap inscription
- Validates parcel number < block transaction count
- Implements tie-breaker logic (earliest wins)

**Example Data:**
```json
{
    "inscription_id": "jkl012...i0",
    "parcel_number": 5,
    "bitmap_number": 792435,
    "bitmap_inscription_id": "ghi789...i0",
    "content": "5.792435.bitmap",
    "address": "bc1q...",
    "block_height": 792437,
    "timestamp": 1677123700,
    "transaction_count": 2500,
    "is_valid": 1,
    "wallet": "bc1q..."
}
```

### Visualization & Analytics Tables

#### 5. `bitmap_patterns` - Bitmap Visualization Data
Stores pattern data for Mondrian-style bitmap visualization.

**Schema:**
```sql
CREATE TABLE bitmap_patterns (
    bitmap_number INTEGER PRIMARY KEY,   -- Bitmap number
    pattern_string TEXT NOT NULL         -- Pattern string for visualization
);
```

**What's Stored:**
- Transaction size patterns converted to numeric strings
- Used for generating Mondrian-style visual representations
- Example: "554433221" represents transaction value ranges

#### 6. `wallets` - Current Ownership Tracking
Tracks current wallet addresses for all inscriptions.

**Schema:**
```sql
CREATE TABLE wallets (
    inscription_id TEXT PRIMARY KEY,     -- Inscription ID
    address TEXT NOT NULL,               -- Current wallet address
    type TEXT NOT NULL,                  -- Type: 'deploy', 'mint', 'bitmap', 'parcel'
    updated_at INTEGER NOT NULL          -- Last update timestamp
);
```

### System & Monitoring Tables

#### 7. `blocks` - Block Processing Status
Tracks which blocks have been processed.

**Schema:**
```sql
CREATE TABLE blocks (
    block_height INTEGER PRIMARY KEY,    -- Block height
    processed INTEGER NOT NULL DEFAULT 0, -- Processing status
    processed_at INTEGER                  -- Processing timestamp
);
```

#### 8. `error_blocks` - Failed Block Processing
Tracks blocks that failed processing for retry mechanism.

**Schema:**
```sql
CREATE TABLE error_blocks (
    block_height INTEGER PRIMARY KEY,    -- Block height
    error_message TEXT,                   -- Error details
    retry_count INTEGER DEFAULT 0,       -- Number of retries
    retry_at INTEGER                      -- Next retry timestamp
);
```

#### 9. `failed_inscriptions` - Failed Inscription Processing
Tracks individual inscriptions that failed processing.

**Schema:**
```sql
CREATE TABLE failed_inscriptions (
    inscription_id TEXT PRIMARY KEY,     -- Inscription ID
    block_height INTEGER NOT NULL,       -- Block height
    error_message TEXT,                   -- Error details
    retry_count INTEGER DEFAULT 0,       -- Number of retries
    created_at INTEGER NOT NULL,         -- First failure timestamp
    last_retry_at INTEGER                 -- Last retry timestamp
);
```

#### 10. `block_stats` - Block Statistics
Comprehensive statistics for each processed block.

**Schema:**
```sql
CREATE TABLE block_stats (
    block_height INTEGER PRIMARY KEY,    -- Block height
    total_transactions INTEGER NOT NULL, -- Total transactions in block
    total_inscriptions INTEGER DEFAULT 0, -- Total inscriptions found
    brc420_deploys INTEGER DEFAULT 0,    -- BRC-420 deploys found
    brc420_mints INTEGER DEFAULT 0,      -- BRC-420 mints found
    bitmaps INTEGER DEFAULT 0,           -- Bitmap inscriptions found
    parcels INTEGER DEFAULT 0,           -- Parcel inscriptions found
    processed_at INTEGER NOT NULL,       -- Processing timestamp
    ordinals_api_transactions INTEGER    -- Ordinals API transaction count
);
```

### Ownership & History Tables

#### 11. `address_history` - Ownership Change History
Tracks ownership changes over time.

**Schema:**
```sql
CREATE TABLE address_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- Unique ID
    inscription_id TEXT NOT NULL,         -- Inscription ID
    old_address TEXT,                     -- Previous address
    new_address TEXT NOT NULL,            -- New address
    transaction_id TEXT,                  -- Transaction ID
    block_height INTEGER NOT NULL,        -- Block height
    timestamp INTEGER NOT NULL,           -- Timestamp
    verification_status TEXT DEFAULT 'pending' -- Verification status
);
```

#### 12. `ownership_verification` - Ownership Verification
Tracks verification of current ownership.

**Schema:**
```sql
CREATE TABLE ownership_verification (
    id INTEGER PRIMARY KEY AUTOINCREMENT, -- Unique ID
    inscription_id TEXT NOT NULL,         -- Inscription ID
    current_address TEXT NOT NULL,        -- Current verified address
    verified_at INTEGER NOT NULL,         -- Verification timestamp
    verification_method TEXT NOT NULL,    -- Verification method
    confidence_score REAL DEFAULT 1.0,   -- Confidence score
    last_verified INTEGER NOT NULL       -- Last verification timestamp
);
```

## Indexing Process

### 1. Block Processing Flow
```
1. getInscriptionsForBlock(blockHeight) - Fetch all inscriptions with pagination
2. processAllInscriptionsCompletely() - Process each inscription
3. processInscription() - Determine inscription type and validate
4. bitmapProcessor.processBitmapOrParcel() - Handle bitmap/parcel processing
5. Save to appropriate database table
```

### 2. Inscription Type Detection
- **BRC-420 Deploy**: Content starts with `{"p":"brc-420","op":"deploy"`
- **BRC-420 Mint**: Content starts with `/content/` and matches inscription ID pattern
- **Bitmap**: Content matches `<NUMBER>.bitmap` pattern
- **Parcel**: Content matches `<PARCEL>.<BITMAP>.bitmap` pattern

### 3. Validation Rules

#### BRC-420 Deploys:
- ✅ Deployer must own the source inscription
- ✅ Source inscription must not be used in previous deploys
- ✅ Valid JSON structure with required fields

#### BRC-420 Mints:
- ✅ Must reference valid deploy inscription
- ✅ Must pay royalty to deployer address
- ✅ Content type must match source inscription
- ✅ Must not exceed deploy max supply

#### Bitmaps:
- ✅ Bitmap number must be ≤ current block height
- ✅ Bitmap number must be unique
- ✅ Valid format: `<NUMBER>.bitmap`

#### Parcels:
- ✅ Must be child inscription of parent bitmap
- ✅ Parcel number must be < block transaction count
- ✅ Tie-breaker: earliest block height and inscription ID wins
- ✅ Valid format: `<PARCEL>.<BITMAP>.bitmap`

## API Endpoints

### BRC-420 Token Endpoints
- `GET /api/deploys` - List BRC-420 deploys (with pagination, search by name/id)
- `GET /api/deploys?id=<ID>` - Get specific deploy by ID
- `GET /api/deploys?name=<NAME>` - Search deploys by name
- `GET /api/deploys/with-mints` - Get deploys that have mints
- `GET /api/mint/<mint_id>` - Get specific mint by ID
- `GET /api/deploy/<deploy_id>/mints` - Get all mints for a specific deploy
- `GET /api/deploy/<deploy_id>/summary` - Get deploy summary with mint count

### Bitmap Endpoints
- `GET /api/bitmaps` - List all bitmap inscriptions (with pagination)
- `GET /api/bitmaps/enhanced` - List bitmaps with enhanced data (patterns, stats)
- `GET /api/bitmaps/search` - Search bitmaps with filters
- `GET /api/bitmaps/summary` - Get bitmap statistics summary
- `GET /api/bitmap/<inscription_id>` - Get bitmap by inscription ID
- `GET /api/bitmaps/number/<bitmap_number>` - Get bitmap by number
- `GET /api/bitmap/<bitmap_number>/pattern` - Get visualization pattern for bitmap
- `GET /api/bitmaps/sat/<sat_number>` - Get bitmap by satoshi number

### Parcel Endpoints
- `GET /api/parcels` - List all parcel inscriptions (with pagination, filtering)
- `GET /api/parcels/summary` - Get parcel statistics summary
- `GET /api/parcel/<inscription_id>` - Get parcel by inscription ID
- `GET /api/parcels/number/<parcel_number>` - Find parcels by parcel number across all bitmaps
- `GET /api/bitmap/<bitmap_number>/parcels` - Get all parcels for a specific bitmap
- `GET /api/parcel/<inscription_id>/address-history` - Get ownership history for parcel

### Address & Wallet Endpoints
- `GET /api/wallet/<inscription_id>` - Get current wallet for inscription
- `GET /api/address/<address>/inscriptions` - Get all inscriptions for address
- `GET /api/address/<address>/bitmaps` - Get bitmaps owned by address
- `GET /api/address/<address>/parcels` - Get parcels owned by address
- `GET /api/address/<address>/verified-bitmaps` - Get verified bitmap ownership

### Ownership & History Endpoints
- `GET /api/inscription/<inscription_id>/address-history` - Get ownership change history
- `GET /api/inscription/<inscription_id>/ownership` - Get current ownership verification

### Block & System Endpoints
- `GET /api/block/<height>/status` - Get block processing status
- `GET /api/block/<height>/stats` - Get detailed block statistics
- `GET /api/blocks/stats` - Get statistics for block range
- `GET /api/error-blocks` - Get blocks that failed processing
- `GET /api/health` - API health check
- `GET /api/config` - Get system configuration

### Search & Discovery
- All list endpoints support pagination with `?page=<N>&limit=<N>` parameters
- Search endpoints support filtering by various criteria
- Sort options available on most endpoints

## Performance Optimizations

### Database Optimizations
- **WAL Mode**: Write-Ahead Logging for better concurrency
- **Memory Caching**: 128MB cache for server, 32MB for API queries
- **Comprehensive Indexing**: 25+ indexes for fast queries
- **Batch Operations**: Efficient bulk inserts and updates

### API Features
- **Pagination**: All endpoints support pagination (default 100 items)
- **Caching**: 5-minute API response caching
- **Concurrency**: Adaptive concurrency management (1-50 concurrent requests)
- **Retry Logic**: Exponential backoff for failed requests

### Local Node Optimizations
- **Umbrel Integration**: Automatic detection of local Ordinals API
- **Memory Management**: Smart memory cleanup and garbage collection
- **Connection Pooling**: Efficient database connection management

## File Locations

- **Database**: `./db/brc420.db`
- **Logs**: `./app.log`, `./processing.log`
- **Config**: `./config.js`, `./.env`
- **Web Interface**: `./public/`
- **API Routes**: `./routes/api.js`

## Usage Examples

### Query All Bitmaps
```bash
curl http://localhost:8080/api/bitmaps
```

### Get Specific Bitmap
```bash
curl http://localhost:8080/api/bitmaps/792435
```

### Search BRC-420 Tokens
```bash
curl http://localhost:8080/api/deploys?name=EXAMPLE
```

### Get Address Holdings
```bash
curl http://localhost:8080/api/address/bc1q.../inscriptions
```

This comprehensive indexing system provides complete coverage of the Bitcoin Ordinals ecosystem with focus on BRC-420 tokens, Bitmap theory, and related inscription types.
