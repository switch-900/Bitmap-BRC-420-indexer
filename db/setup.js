const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './db/brc420.db'; // Use standard path
const dbDir = path.dirname(DB_PATH);

// Ensure database directory exists
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

console.log('Initializing database at:', DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err.message);
        process.exit(1);
    }
    console.log('Connected to SQLite database');
});

// Create tables matching index-runner.js expectations
db.serialize(() => {
    // BRC-420 deploys table (matches index-runner.js saveBrc420Deploy)
    db.run(`CREATE TABLE IF NOT EXISTS brc420_deploys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT UNIQUE NOT NULL,
        tick TEXT NOT NULL,
        max_supply INTEGER,
        limit_per_mint INTEGER,
        decimals INTEGER DEFAULT 18,
        deployer TEXT,
        block_height INTEGER,
        sat_number INTEGER,
        deploy_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating brc420_deploys table:', err.message);
        } else {
            console.log('BRC-420 deploys table created or already exists');
        }
    });

    // BRC-420 mints table (matches index-runner.js saveBrc420Mint)
    db.run(`CREATE TABLE IF NOT EXISTS brc420_mints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT UNIQUE NOT NULL,
        tick TEXT NOT NULL,
        amount INTEGER,
        block_height INTEGER,
        sat_number INTEGER,
        mint_data TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating brc420_mints table:', err.message);
        } else {
            console.log('BRC-420 mints table created or already exists');
        }
    });

    // Bitmaps table (matches index-runner.js saveBitmap)
    db.run(`CREATE TABLE IF NOT EXISTS bitmaps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT UNIQUE NOT NULL,
        bitmap_number INTEGER NOT NULL,
        block_height INTEGER,
        sat_number INTEGER,
        transaction_patterns TEXT,
        pattern_metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(bitmap_number)
    )`, (err) => {
        if (err) {
            console.error('Error creating bitmaps table:', err.message);
        } else {
            console.log('Bitmaps table created or already exists');
        }
    });

    // Processed blocks table (matches index-runner.js markBlockAsProcessed)
    db.run(`CREATE TABLE IF NOT EXISTS processed_blocks (
        block_height INTEGER PRIMARY KEY,
        inscriptions_processed INTEGER DEFAULT 0,
        inscriptions_skipped INTEGER DEFAULT 0,
        inscriptions_errors INTEGER DEFAULT 0,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating processed_blocks table:', err.message);
        } else {
            console.log('Processed blocks table created or already exists');
        }
    });

    // Failed inscriptions table (matches index-runner.js saveFailedInscription)
    db.run(`CREATE TABLE IF NOT EXISTS failed_inscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT NOT NULL,
        block_height INTEGER,
        error_message TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating failed_inscriptions table:', err.message);
        } else {
            console.log('Failed inscriptions table created or already exists');
        }
    });

    // Bitmap patterns table for visualization
    db.run(`CREATE TABLE IF NOT EXISTS bitmap_patterns (
        bitmap_number INTEGER PRIMARY KEY,
        pattern_string TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creating bitmap_patterns table:', err.message);
        } else {
            console.log('Bitmap patterns table created or already exists');
        }
    });

    // Parcels table (for bitmap-processor.js)
    db.run(`CREATE TABLE IF NOT EXISTS parcels (
        inscription_id TEXT PRIMARY KEY,
        parcel_number INTEGER NOT NULL,
        bitmap_number INTEGER NOT NULL,
        bitmap_inscription_id TEXT NOT NULL,
        content TEXT NOT NULL,
        address TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        transaction_count INTEGER,
        is_valid INTEGER DEFAULT 1,
        wallet TEXT,
        FOREIGN KEY (bitmap_inscription_id) REFERENCES bitmaps(inscription_id)
    )`, (err) => {
        if (err) {
            console.error('Error creating parcels table:', err.message);
        } else {
            console.log('Parcels table created or already exists');
        }
    });

    // Create indexes for better performance
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_brc420_deploys_tick ON brc420_deploys(tick)',
        'CREATE INDEX IF NOT EXISTS idx_brc420_deploys_block_height ON brc420_deploys(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_brc420_mints_tick ON brc420_mints(tick)',
        'CREATE INDEX IF NOT EXISTS idx_brc420_mints_block_height ON brc420_mints(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_bitmaps_number ON bitmaps(bitmap_number)',
        'CREATE INDEX IF NOT EXISTS idx_bitmaps_block_height ON bitmaps(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_processed_blocks_height ON processed_blocks(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_failed_inscriptions_block_height ON failed_inscriptions(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_parcel_number ON parcels(parcel_number)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_bitmap_number ON parcels(bitmap_number)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_block_height ON parcels(block_height)'
    ];

    indexes.forEach((indexSql, i) => {
        db.run(indexSql, (err) => {
            if (err) {
                console.error(`Error creating index ${i + 1}:`, err.message);
            } else {
                console.log(`Index ${i + 1} created or already exists`);
            }
        });
    });

    // Apply performance optimizations
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA cache_size = -64000"); // 64MB cache
    db.run("PRAGMA temp_store = MEMORY");
    db.run("PRAGMA mmap_size = 268435456"); // 256MB mmap
    console.log('Database performance optimizations applied');
});

db.close((err) => {
    if (err) {
        console.error('Error closing database:', err.message);
        process.exit(1);
    }
    console.log('Database setup completed successfully');
    process.exit(0);
});