const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { open } = require('sqlite');

const DB_PATH = path.join(__dirname, './db/brc420.db');

async function setupDatabase() {
    try {
        const db = await open({
            filename: DB_PATH,
            driver: sqlite3.Database
        });

        console.log('Connected to the BRC-420 database for setup.');

        await db.exec(`
            -- Create deploys table
            CREATE TABLE IF NOT EXISTS deploys (
                id TEXT PRIMARY KEY,
                p TEXT,
                op TEXT,
                name TEXT,
                max INTEGER,
                price REAL,
                deployer_address TEXT,
                block_height INTEGER,
                timestamp INTEGER,
                source_id TEXT,
                wallet TEXT,
                updated_at INTEGER,
                mint_count INTEGER DEFAULT 0
            );

            -- Create mints table
            CREATE TABLE IF NOT EXISTS mints (
                id TEXT PRIMARY KEY,
                deploy_id TEXT,
                source_id TEXT,
                mint_address TEXT,
                transaction_id TEXT,
                block_height INTEGER,
                timestamp INTEGER,
                inscription_id TEXT,
                wallet TEXT,
                updated_at INTEGER,
                FOREIGN KEY (deploy_id) REFERENCES deploys(id)
            );

            -- Create blocks table
            CREATE TABLE IF NOT EXISTS blocks (
                block_height INTEGER PRIMARY KEY,
                processed INTEGER DEFAULT 0
            );

            -- Create error_blocks table
            CREATE TABLE IF NOT EXISTS error_blocks (
                block_height INTEGER PRIMARY KEY,
                retry_at INTEGER
            );

            -- Drop existing bitmaps table if it exists
            DROP TABLE IF EXISTS bitmaps;

            -- Create new bitmaps table with wallet column
            CREATE TABLE IF NOT EXISTS bitmaps (
                inscription_id TEXT PRIMARY KEY,
                bitmap_number INTEGER,
                content TEXT,
                address TEXT,
                timestamp INTEGER,
                block_height INTEGER,
                wallet TEXT,
                updated_at INTEGER
            );

            -- Create indexes for faster queries
            CREATE INDEX IF NOT EXISTS idx_bitmap_number ON bitmaps(bitmap_number);
            CREATE INDEX IF NOT EXISTS idx_deploy_id ON mints(deploy_id);
            CREATE INDEX IF NOT EXISTS idx_deploy_name ON deploys(name);
            CREATE INDEX IF NOT EXISTS idx_block_height ON blocks(block_height);
            CREATE INDEX IF NOT EXISTS idx_wallet_address ON deploys(wallet);
            CREATE INDEX IF NOT EXISTS idx_wallet_updated_at ON deploys(updated_at);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_address ON mints(wallet);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_updated_at ON mints(updated_at);
            CREATE INDEX IF NOT EXISTS idx_bitmap_wallet_address ON bitmaps(wallet);
            CREATE INDEX IF NOT EXISTS idx_bitmap_wallet_updated_at ON bitmaps(updated_at);
            CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at);
        `);

        console.log('Database setup completed successfully.');
        await db.close();
        console.log('Database connection closed.');
    } catch (err) {
        console.error('Error during database setup:', err.message);
        process.exit(1);
    }
}

setupDatabase();
