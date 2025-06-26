const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './db/brc420.db';
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

// Create tables
db.serialize(() => {
    // Create deploys table
    db.run(`CREATE TABLE IF NOT EXISTS deploys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        max INTEGER NOT NULL,
        price REAL NOT NULL,
        deployer_address TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        source_id TEXT NOT NULL,
        wallet TEXT,
        UNIQUE(id)
    )`, (err) => {
        if (err) {
            console.error('Error creating deploys table:', err.message);
        } else {
            console.log('Deploys table created or already exists');
        }
    });

    // Create mints table
    db.run(`CREATE TABLE IF NOT EXISTS mints (
        id TEXT PRIMARY KEY,
        deploy_id TEXT NOT NULL,
        source_id TEXT NOT NULL,
        mint_address TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        wallet TEXT,
        FOREIGN KEY (deploy_id) REFERENCES deploys(id),
        UNIQUE(id)
    )`, (err) => {
        if (err) {
            console.error('Error creating mints table:', err.message);
        } else {
            console.log('Mints table created or already exists');
        }
    });    // Create bitmaps table
    db.run(`CREATE TABLE IF NOT EXISTS bitmaps (
        inscription_id TEXT PRIMARY KEY,
        bitmap_number INTEGER NOT NULL,
        content TEXT NOT NULL,
        address TEXT NOT NULL,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        sat INTEGER,
        wallet TEXT,
        UNIQUE(inscription_id),
        UNIQUE(bitmap_number)
    )`, (err) => {
        if (err) {
            console.error('Error creating bitmaps table:', err.message);
        } else {
            console.log('Bitmaps table created or already exists');
        }
    });    // Create parcels table for tracking parcel inscriptions
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
        is_valid INTEGER DEFAULT 0,
        wallet TEXT,
        FOREIGN KEY (bitmap_inscription_id) REFERENCES bitmaps(inscription_id),
        UNIQUE(inscription_id)
    )`, (err) => {
        if (err) {
            console.error('Error creating parcels table:', err.message);
        } else {
            console.log('Parcels table created or already exists');
        }
    });    // Create bitmap_patterns table for storing simple transaction size strings
    db.run(`CREATE TABLE IF NOT EXISTS bitmap_patterns (
        bitmap_number INTEGER PRIMARY KEY,
        pattern_string TEXT NOT NULL,
        FOREIGN KEY (bitmap_number) REFERENCES bitmaps(bitmap_number)
    )`, (err) => {
        if (err) {
            console.error('Error creating bitmap_patterns table:', err.message);
        } else {
            console.log('Bitmap patterns table created or already exists');
        }
    });// Create wallets table
    db.run(`CREATE TABLE IF NOT EXISTS wallets (
        inscription_id TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        type TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(inscription_id)
    )`, (err) => {
        if (err) {
            console.error('Error creating wallets table:', err.message);
        } else {
            console.log('Wallets table created or already exists');
        }
    });

    // Create address_history table for tracking ownership changes
    db.run(`CREATE TABLE IF NOT EXISTS address_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT NOT NULL,
        old_address TEXT,
        new_address TEXT NOT NULL,
        transaction_id TEXT,
        block_height INTEGER NOT NULL,
        timestamp INTEGER NOT NULL,
        verification_status TEXT DEFAULT 'pending',
        FOREIGN KEY (inscription_id) REFERENCES bitmaps(inscription_id)
    )`, (err) => {
        if (err) {
            console.error('Error creating address_history table:', err.message);
        } else {
            console.log('Address history table created or already exists');
        }
    });

    // Create ownership_verification table for validating transfers
    db.run(`CREATE TABLE IF NOT EXISTS ownership_verification (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        inscription_id TEXT NOT NULL,
        current_address TEXT NOT NULL,
        verified_at INTEGER NOT NULL,
        verification_method TEXT NOT NULL,
        confidence_score REAL DEFAULT 1.0,
        last_verified INTEGER NOT NULL,
        FOREIGN KEY (inscription_id) REFERENCES bitmaps(inscription_id),
        UNIQUE(inscription_id)
    )`, (err) => {
        if (err) {
            console.error('Error creating ownership_verification table:', err.message);
        } else {
            console.log('Ownership verification table created or already exists');
        }
    });

    // Create blocks table for tracking processed blocks
    db.run(`CREATE TABLE IF NOT EXISTS blocks (
        block_height INTEGER PRIMARY KEY,
        processed INTEGER NOT NULL DEFAULT 0,
        processed_at INTEGER,
        UNIQUE(block_height)
    )`, (err) => {
        if (err) {
            console.error('Error creating blocks table:', err.message);
        } else {
            console.log('Blocks table created or already exists');
        }
    });

    // Create error_blocks table for retry mechanism
    db.run(`CREATE TABLE IF NOT EXISTS error_blocks (
        block_height INTEGER PRIMARY KEY,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        retry_at INTEGER,
        UNIQUE(block_height)
    )`, (err) => {
        if (err) {
            console.error('Error creating error_blocks table:', err.message);
        } else {
            console.log('Error blocks table created or already exists');
        }    });    // Create block_stats table for tracking transaction counts and other block metrics
    db.run(`CREATE TABLE IF NOT EXISTS block_stats (
        block_height INTEGER PRIMARY KEY,
        total_transactions INTEGER NOT NULL,
        total_inscriptions INTEGER DEFAULT 0,
        brc420_deploys INTEGER DEFAULT 0,
        brc420_mints INTEGER DEFAULT 0,
        bitmaps INTEGER DEFAULT 0,
        parcels INTEGER DEFAULT 0,
        processed_at INTEGER NOT NULL,
        ordinals_api_transactions INTEGER,
        UNIQUE(block_height)
    )`, (err) => {
        if (err) {
            console.error('Error creating block_stats table:', err.message);
        } else {
            console.log('Block stats table created or already exists');
        }
    });

    // Migration: Add block_height column to bitmaps table if it doesn't exist
    db.run(`PRAGMA table_info(bitmaps)`, (err, rows) => {
        if (err) {
            console.error('Error checking bitmaps table schema:', err.message);
        } else {
            // Check if block_height column exists
            db.all(`PRAGMA table_info(bitmaps)`, (err, columns) => {
                if (err) {
                    console.error('Error getting bitmaps table info:', err.message);
                    return;
                }
                
                const hasBlockHeight = columns.some(col => col.name === 'block_height');
                const hasSat = columns.some(col => col.name === 'sat');
                
                if (!hasBlockHeight) {
                    console.log('Adding missing block_height column to bitmaps table...');
                    db.run(`ALTER TABLE bitmaps ADD COLUMN block_height INTEGER NOT NULL DEFAULT 0`, (err) => {
                        if (err) {
                            console.error('Error adding block_height column to bitmaps:', err.message);
                        } else {
                            console.log('Successfully added block_height column to bitmaps table');
                        }
                    });
                } else {
                    console.log('Bitmaps table already has block_height column');
                }
                
                if (!hasSat) {
                    console.log('Adding missing sat column to bitmaps table...');
                    db.run(`ALTER TABLE bitmaps ADD COLUMN sat INTEGER`, (err) => {
                        if (err) {
                            console.error('Error adding sat column to bitmaps:', err.message);
                        } else {
                            console.log('Successfully added sat column to bitmaps table');
                        }
                    });
                } else {
                    console.log('Bitmaps table already has sat column');
                }
            });
        }
    });    // Create indexes for better performance
    const indexes = [
        'CREATE INDEX IF NOT EXISTS idx_deploys_block_height ON deploys(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_deploys_name ON deploys(name)',
        'CREATE INDEX IF NOT EXISTS idx_mints_deploy_id ON mints(deploy_id)',
        'CREATE INDEX IF NOT EXISTS idx_mints_block_height ON mints(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_bitmaps_bitmap_number ON bitmaps(bitmap_number)',
        'CREATE INDEX IF NOT EXISTS idx_bitmaps_block_height ON bitmaps(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_bitmaps_address ON bitmaps(address)',        'CREATE INDEX IF NOT EXISTS idx_bitmaps_sat ON bitmaps(sat)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_parcel_number ON parcels(parcel_number)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_bitmap_number ON parcels(bitmap_number)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_bitmap_inscription_id ON parcels(bitmap_inscription_id)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_block_height ON parcels(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_address ON parcels(address)',
        'CREATE INDEX IF NOT EXISTS idx_parcels_is_valid ON parcels(is_valid)',
        'CREATE INDEX IF NOT EXISTS idx_bitmap_patterns_bitmap_number ON bitmap_patterns(bitmap_number)',
        'CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address)',
        'CREATE INDEX IF NOT EXISTS idx_wallets_type ON wallets(type)',
        'CREATE INDEX IF NOT EXISTS idx_blocks_processed ON blocks(processed)',
        'CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at)',
        'CREATE INDEX IF NOT EXISTS idx_address_history_inscription_id ON address_history(inscription_id)',
        'CREATE INDEX IF NOT EXISTS idx_address_history_new_address ON address_history(new_address)',
        'CREATE INDEX IF NOT EXISTS idx_address_history_block_height ON address_history(block_height)',
        'CREATE INDEX IF NOT EXISTS idx_ownership_verification_inscription_id ON ownership_verification(inscription_id)',
        'CREATE INDEX IF NOT EXISTS idx_ownership_verification_current_address ON ownership_verification(current_address)',
        'CREATE INDEX IF NOT EXISTS idx_ownership_verification_last_verified ON ownership_verification(last_verified)'
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
});

db.close((err) => {
    if (err) {
        console.error('Error closing database:', err.message);
        process.exit(1);
    }
    console.log('Database setup completed successfully');
    process.exit(0);
});
