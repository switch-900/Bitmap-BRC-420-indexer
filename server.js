const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const config = require('./config');
const routes = require('./routes');

const app = express();
const PORT = config.WEB_PORT || 8080;

// Global error handlers to prevent crashes
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception (will not crash):', err.message);
    console.error('Stack trace:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Database initialization function with robust error handling and local node optimizations
function initializeDatabase() {
    return new Promise((resolve, reject) => {
        let DB_PATH = config.DB_PATH || './db/brc420.db';
        let dbDir = path.dirname(DB_PATH);

        console.log('Starting database initialization (optimized for local node)...');
        console.log('Target database path:', DB_PATH);
        console.log('Target database directory:', dbDir);

        // Function to try database creation
        function tryCreateDatabase(dbPath) {
            return new Promise((resolveDB, rejectDB) => {
                const testDbDir = path.dirname(dbPath);
                
                try {
                    // Ensure directory exists
                    if (!fs.existsSync(testDbDir)) {
                        fs.mkdirSync(testDbDir, { recursive: true, mode: 0o755 });
                        console.log('Created database directory:', testDbDir);
                    }

                    // Test write permissions by creating a test file
                    const testFile = path.join(testDbDir, 'test-write.tmp');
                    fs.writeFileSync(testFile, 'test');
                    fs.unlinkSync(testFile);
                    console.log('Database directory is writable:', testDbDir);                    // Try to open database with optimizations for local node
                    const db = new sqlite3.Database(dbPath, (err) => {
                        if (err) {
                            console.error('Error opening database at', dbPath, ':', err.message);
                            rejectDB(err);
                        } else {
                            console.log('Successfully opened database at:', dbPath);
                            
                            // Add comprehensive error handling to prevent crashes
                            db.on('error', (dbErr) => {
                                console.error('Database error (will not crash app):', dbErr.message);
                            });
                            
                            // Add error handler for SQLITE_BUSY specifically
                            db.on('trace', (sql) => {
                                // Log problematic SQL if needed for debugging
                                if (sql.includes('PRAGMA') || sql.includes('CREATE')) {
                                    console.log('Database operation:', sql.substring(0, 100));
                                }
                            });
                            
                            // Optimize database for local node performance
                            db.serialize(() => {
                                db.run("PRAGMA journal_mode = WAL");
                                db.run("PRAGMA synchronous = NORMAL");
                                db.run("PRAGMA cache_size = -128000"); // 128MB cache for local node
                                db.run("PRAGMA temp_store = MEMORY");
                                db.run("PRAGMA mmap_size = 268435456"); // 256MB memory map
                                db.run("PRAGMA busy_timeout = 30000"); // 30 second timeout for concurrent access
                                console.log('Database optimizations applied for local node');
                            });
                            
                            resolveDB(db);
                        }
                    });
                } catch (error) {
                    console.error('Cannot write to database directory', testDbDir, ':', error.message);
                    rejectDB(error);
                }
            });
        }        // Try primary location first, then fallback
        tryCreateDatabase(DB_PATH)
            .then(db => {
                console.log('Using primary database location');
                setupDatabaseSchema(db, (dbConnection) => {
                    if (dbConnection) {
                        // Store database connection for API routes
                        global.db = dbConnection;
                    }
                    resolve();
                });
            })
            .catch(err => {
                console.log('Primary database location failed, trying fallback...');
                const fallbackPath = path.join(__dirname, 'db', 'brc420.db');
                  tryCreateDatabase(fallbackPath)
                    .then(db => {
                        console.log('Using fallback database location:', fallbackPath);
                        // Update config for other parts of the app
                        config.DB_PATH = fallbackPath;
                        setupDatabaseSchema(db, (dbConnection) => {
                            if (dbConnection) {
                                // Store database connection for API routes
                                global.db = dbConnection;
                            }
                            resolve();
                        });
                    })
                    .catch(fallbackErr => {
                        console.error('Both database locations failed. Running in read-only mode.');
                        console.error('Primary error:', err.message);
                        console.error('Fallback error:', fallbackErr.message);
                        resolve(); // Don't crash the app, just continue without database
                    });
            });
    });
}

// Separate function to handle database schema setup
function setupDatabaseSchema(db, callback) {
    // Add error handling wrapper for all database operations
    function safeDbRun(sql, params, callback) {
        try {
            db.run(sql, params, (err) => {
                if (err) {
                    console.error('Database operation error (continuing):', err.message);
                    console.error('SQL:', sql.substring(0, 100));
                    // Don't fail the callback, just log and continue
                    if (callback) callback(null);
                } else {
                    if (callback) callback(null);
                }
            });
        } catch (syncErr) {
            console.error('Synchronous database error (continuing):', syncErr.message);
            if (callback) callback(null);
        }
    }
    
    db.serialize(() => {
        let tablesCreated = 0;
        const totalTables = 8; // Added block_stats table
        
        function checkCompletion() {
            tablesCreated++;
            if (tablesCreated >= totalTables) {
                console.log('All database tables created successfully');
                
                // Create indexes after all tables are created
                const indexes = [
                    'CREATE INDEX IF NOT EXISTS idx_deploys_block_height ON deploys(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_deploys_name ON deploys(name)',
                    'CREATE INDEX IF NOT EXISTS idx_mints_deploy_id ON mints(deploy_id)',
                    'CREATE INDEX IF NOT EXISTS idx_mints_block_height ON mints(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_bitmap_number ON bitmaps(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_block_height ON bitmaps(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_address ON bitmaps(address)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_sat ON bitmaps(sat)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmap_patterns_bitmap_number ON bitmap_patterns(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address)',
                    'CREATE INDEX IF NOT EXISTS idx_wallets_type ON wallets(type)',
                    'CREATE INDEX IF NOT EXISTS idx_blocks_processed ON blocks(processed)',
                    'CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at)',
                    'CREATE INDEX IF NOT EXISTS idx_block_stats_block_height ON block_stats(block_height)'
                ];

                let indexesCreated = 0;
                indexes.forEach((indexSql, i) => {
                    safeDbRun(indexSql, [], () => {
                        console.log(`Index ${i + 1} created or already exists`);
                        indexesCreated++;
                        if (indexesCreated === indexes.length) {
                            console.log('All database indexes created successfully');
                            console.log('Database setup completed successfully');
                            callback(db); // Pass the open database connection
                        }
                    });
                });
            }
        }

        // Create deploys table
        safeDbRun(`CREATE TABLE IF NOT EXISTS deploys (
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
        )`, [], () => {
            console.log('Deploys table created or already exists');
            checkCompletion();
        });

        // Create mints table
        safeDbRun(`CREATE TABLE IF NOT EXISTS mints (
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
        )`, [], () => {
            console.log('Mints table created or already exists');
            checkCompletion();
        });

        // Create bitmaps table with enhanced schema for Mondrian visualization
        safeDbRun(`CREATE TABLE IF NOT EXISTS bitmaps (
            inscription_id TEXT PRIMARY KEY,
            bitmap_number INTEGER NOT NULL,
            content TEXT NOT NULL,
            address TEXT NOT NULL,
            timestamp INTEGER NOT NULL,
            block_height INTEGER NOT NULL,
            sat INTEGER,
            wallet TEXT,
            UNIQUE(inscription_id),
            UNIQUE(bitmap_number)
        )`, [], () => {
            console.log('Bitmaps table created or already exists');
            checkCompletion();
        });        // Create bitmap_patterns table for storing simple transaction size strings
        safeDbRun(`CREATE TABLE IF NOT EXISTS bitmap_patterns (
            bitmap_number INTEGER PRIMARY KEY,
            pattern_string TEXT NOT NULL,
            FOREIGN KEY (bitmap_number) REFERENCES bitmaps(bitmap_number)
        )`, [], () => {
            console.log('Bitmap patterns table created or already exists');
            checkCompletion();
        });

        // Create wallets table
        safeDbRun(`CREATE TABLE IF NOT EXISTS wallets (
            inscription_id TEXT PRIMARY KEY,
            address TEXT NOT NULL,
            type TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE(inscription_id)
        )`, [], () => {
            console.log('Wallets table created or already exists');
            checkCompletion();
        });

        // Create blocks table for tracking processed blocks
        safeDbRun(`CREATE TABLE IF NOT EXISTS blocks (
            block_height INTEGER PRIMARY KEY,
            processed INTEGER NOT NULL DEFAULT 0,
            processed_at INTEGER,
            UNIQUE(block_height)
        )`, [], () => {
            console.log('Blocks table created or already exists');
            checkCompletion();
        });

        // Create error_blocks table for retry mechanism
        safeDbRun(`CREATE TABLE IF NOT EXISTS error_blocks (
            block_height INTEGER PRIMARY KEY,
            error_message TEXT,
            retry_count INTEGER DEFAULT 0,
            retry_at INTEGER,
            UNIQUE(block_height)
        )`, [], () => {
            console.log('Error blocks table created or already exists');
            checkCompletion();
        });

        // Create block_stats table for tracking transaction counts and other block metrics
        safeDbRun(`CREATE TABLE IF NOT EXISTS block_stats (
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
        )`, [], () => {
            console.log('Block stats table created or already exists');
            checkCompletion();
        });
    });
}

// Initialize database on startup with error handling
async function startServer() {
    try {
        console.log('Initializing database...');
        await initializeDatabase();
        console.log('Database initialization completed');
    } catch (error) {
        console.error('Database initialization failed:', error.message);
        console.log('Continuing without database - web interface will still be available');
    }

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
    });    // Start the server
    app.listen(PORT, '0.0.0.0', () => {
        console.log(`BRC-420 Indexer web server running on http://0.0.0.0:${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`RUN_INDEXER: ${config.RUN_INDEXER}`);
        
        // Start the indexer process if enabled
        if (config.RUN_INDEXER) {
            console.log('Starting Bitcoin inscription indexer process...');
            setTimeout(() => {
                startIndexerProcess().catch(error => {
                    console.error('Error starting indexer process:', error);
                });
            }, 2000); // Wait 2 seconds for server to fully start
        } else {
            console.log('Indexer process disabled (RUN_INDEXER=false)');
        }    });
}

// Function to start the indexer process
async function startIndexerProcess() {
    console.log('Starting indexer process...');
    console.log(`Starting from block: ${config.START_BLOCK}`);
    console.log(`API URL: ${config.getApiUrl()}`);
    
    try {        // Import and run the indexer
        const indexer = require('./index-runner.js');
        console.log('Starting Bitcoin inscription indexer...');
        await indexer.startIndexer();
    } catch (error) {
        console.error('Error starting indexer:', error.message);
        console.log('Retrying indexer in 30 seconds...');
        setTimeout(() => {
            startIndexerProcess().catch(console.error);
        }, 30000);
    }
}

// Start the server
startServer().catch(error => {
    console.error('Failed to start server:', error);
    process.exit(1);
});
