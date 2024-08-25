import sqlite3 from 'sqlite3';
import path from 'path';
import { open } from 'sqlite';
import { fileURLToPath } from 'url';

// Setup __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
                mint_count INTEGER DEFAULT 0,
                position INTEGER  -- Add position for deploys
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
                previous_wallet TEXT,
                wallet_update_block INTEGER,
                wallet_update_timestamp INTEGER,
                position INTEGER,  -- Add position for mints
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

            -- Create bitmaps table
            CREATE TABLE IF NOT EXISTS bitmaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                inscription_id TEXT,
                block_height INTEGER,
                bitmap_number INTEGER,
                address TEXT,
                content TEXT,
                previous_address TEXT,
                address_update_block INTEGER,
                address_update_timestamp INTEGER,
                position INTEGER,  -- Add position for bitmaps
                UNIQUE(inscription_id, bitmap_number)
            );

            -- Create indexes for faster queries
            CREATE INDEX IF NOT EXISTS idx_deploy_id ON mints(deploy_id);
            CREATE INDEX IF NOT EXISTS idx_deploy_name ON deploys(name);
            CREATE INDEX IF NOT EXISTS idx_block_height ON blocks(block_height);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_address ON mints(wallet);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_updated_at ON mints(updated_at);
            CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at);
            CREATE INDEX IF NOT EXISTS idx_bitmap_block_height ON bitmaps(block_height);
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
