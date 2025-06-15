const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const config = require('./config');
const routes = require('./routes');

const app = express();
const PORT = config.WEB_PORT || 8080;

// Database initialization function
function initializeDatabase() {
    const DB_PATH = config.DB_PATH || './db/brc420.db';
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
        console.log('Connected to SQLite database for setup');
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
        });

        // Create bitmaps table
        db.run(`CREATE TABLE IF NOT EXISTS bitmaps (
            inscription_id TEXT PRIMARY KEY,
            bitmap_number INTEGER NOT NULL,
            content TEXT NOT NULL,
            address TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            wallet TEXT,
            UNIQUE(inscription_id),
            UNIQUE(bitmap_number)
        )`, (err) => {
            if (err) {
                console.error('Error creating bitmaps table:', err.message);
            } else {
                console.log('Bitmaps table created or already exists');
            }
        });

        // Create wallets table
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
            }
        });

        // Create indexes for better performance
        const indexes = [
            'CREATE INDEX IF NOT EXISTS idx_deploys_block_height ON deploys(block_height)',
            'CREATE INDEX IF NOT EXISTS idx_deploys_name ON deploys(name)',
            'CREATE INDEX IF NOT EXISTS idx_mints_deploy_id ON mints(deploy_id)',
            'CREATE INDEX IF NOT EXISTS idx_mints_block_height ON mints(block_height)',
            'CREATE INDEX IF NOT EXISTS idx_bitmaps_bitmap_number ON bitmaps(bitmap_number)',
            'CREATE INDEX IF NOT EXISTS idx_bitmaps_address ON bitmaps(address)',
            'CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address)',
            'CREATE INDEX IF NOT EXISTS idx_wallets_type ON wallets(type)',
            'CREATE INDEX IF NOT EXISTS idx_blocks_processed ON blocks(processed)',
            'CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at)'
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
        } else {
            console.log('Database setup completed successfully');
        }
    });
}

// Initialize database on startup
initializeDatabase();

// Enable CORS
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// API routes
app.use('/', routes);

// Serve static files from the "public" directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the index.html for the root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve the deploy.html for the deploy details page
app.get('/deploy', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'deploy.html'));
});

// Serve the bitmaps.html for the bitmaps page
app.get('/bitmaps', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'bitmaps.html'));
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        service: 'BRC-420 Indexer'
    });
});

// Handle 404s
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`BRC-420 Indexer web server running on http://0.0.0.0:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
