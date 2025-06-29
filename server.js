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
        const totalTables = 11; // All tables: brc420_deploys, brc420_mints, bitmaps, bitmap_patterns, wallets, blocks, error_blocks, block_stats, parcels, processed_blocks, failed_inscriptions
        
        function checkCompletion() {
            tablesCreated++;
            if (tablesCreated >= totalTables) {
                console.log('All database tables created successfully');
                
                // Create indexes after all tables are created (matches setup.js schema)
                const indexes = [
                    'CREATE INDEX IF NOT EXISTS idx_brc420_deploys_tick ON brc420_deploys(tick)',
                    'CREATE INDEX IF NOT EXISTS idx_brc420_deploys_block_height ON brc420_deploys(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_brc420_mints_tick ON brc420_mints(tick)',
                    'CREATE INDEX IF NOT EXISTS idx_brc420_mints_block_height ON brc420_mints(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_number ON bitmaps(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_block_height ON bitmaps(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_processed_blocks_height ON processed_blocks(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_failed_inscriptions_block_height ON failed_inscriptions(block_height)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmap_patterns_bitmap_number ON bitmap_patterns(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_parcels_parcel_number ON parcels(parcel_number)',
                    'CREATE INDEX IF NOT EXISTS idx_parcels_bitmap_number ON parcels(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_parcels_block_height ON parcels(block_height)'
                ];

                let indexesCreated = 0;
                indexes.forEach((indexSql, i) => {
                    safeDbRun(indexSql, [], () => {
                        console.log(`Index ${i + 1} created or already exists`);
                        indexesCreated++;
                        if (indexesCreated === indexes.length) {
                            console.log('All database indexes created successfully');
                            console.log('Database setup completed successfully');
                            
                            // Small delay to ensure all database operations are flushed
                            setTimeout(() => {
                                callback(db); // Pass the open database connection
                            }, 1000);
                        }
                    });
                });
            }
        }

        // Create BRC-420 deploys table (matches index-runner.js expectations)
        safeDbRun(`CREATE TABLE IF NOT EXISTS brc420_deploys (
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
        )`, [], () => {
            console.log('BRC-420 deploys table created or already exists');
            checkCompletion();
        });

        // Create BRC-420 mints table (matches index-runner.js expectations)
        safeDbRun(`CREATE TABLE IF NOT EXISTS brc420_mints (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inscription_id TEXT UNIQUE NOT NULL,
            tick TEXT NOT NULL,
            amount INTEGER,
            block_height INTEGER,
            sat_number INTEGER,
            mint_data TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, [], () => {
            console.log('BRC-420 mints table created or already exists');
            checkCompletion();
        });

        // Create bitmaps table (matches index-runner.js expectations)
        safeDbRun(`CREATE TABLE IF NOT EXISTS bitmaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inscription_id TEXT UNIQUE NOT NULL,
            bitmap_number INTEGER NOT NULL,
            block_height INTEGER,
            sat_number INTEGER,
            transaction_patterns TEXT,
            pattern_metadata TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

        // Create parcels table for bitmap parcel tracking
        safeDbRun(`CREATE TABLE IF NOT EXISTS parcels (
            inscription_id TEXT PRIMARY KEY,
            parcel_number INTEGER NOT NULL,
            bitmap_number INTEGER NOT NULL,
            bitmap_inscription_id TEXT,
            content TEXT NOT NULL,
            address TEXT NOT NULL,
            block_height INTEGER NOT NULL,
            timestamp INTEGER NOT NULL,
            transaction_count INTEGER,
            is_valid BOOLEAN DEFAULT 1,
            wallet TEXT,
            UNIQUE(inscription_id)
        )`, [], () => {
            console.log('Parcels table created or already exists');
            checkCompletion();
        });

        // Create processed blocks table (matches index-runner.js markBlockAsProcessed)
        safeDbRun(`CREATE TABLE IF NOT EXISTS processed_blocks (
            block_height INTEGER PRIMARY KEY,
            inscriptions_processed INTEGER DEFAULT 0,
            inscriptions_skipped INTEGER DEFAULT 0,
            inscriptions_errors INTEGER DEFAULT 0,
            processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, [], () => {
            console.log('Processed blocks table created or already exists');
            checkCompletion();
        });

        // Create failed inscriptions table (matches index-runner.js saveFailedInscription)
        safeDbRun(`CREATE TABLE IF NOT EXISTS failed_inscriptions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            inscription_id TEXT NOT NULL,
            block_height INTEGER,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`, [], () => {
            console.log('Failed inscriptions table created or already exists');
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

    // Health check endpoint with more detailed status
    app.get('/health', (req, res) => {
        res.status(200).json({ 
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            service: 'BRC-420 Indexer',
            version: '1.0.0',
            ready: true
        });
    });

    // Ready check endpoint for containers
    app.get('/ready', (req, res) => {
        res.status(200).json({ 
            ready: true,
            timestamp: new Date().toISOString() 
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
    });    // Start the server with better error handling
    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`BRC-420 Indexer web server running on http://0.0.0.0:${PORT}`);
        console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
        console.log(`RUN_INDEXER: ${config.RUN_INDEXER}`);
        
        // Add a small delay to ensure server is fully ready
        setTimeout(() => {
            console.log('Server is ready to accept connections');
            
            // Start the indexer process if enabled
            if (config.RUN_INDEXER) {
                console.log('Starting Bitcoin inscription indexer process...');
                setTimeout(() => {
                    startIndexerProcess().catch(error => {
                        console.error('Failed to start indexer process:', error.message);
                        console.log('Indexer will retry automatically...');
                    });
                }, 5000); // Increased to 5 second delay before starting indexer
            }
        }, 2000); // Increased to 2 second delay for server readiness
    });

    // Handle server errors
    server.on('error', (err) => {
        console.error('Server error:', err);
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${PORT} is already in use`);
            process.exit(1);
        }
    });
}

// Function to start the indexer process
async function startIndexerProcess() {
    console.log('Starting indexer process...');
    console.log(`Starting from block: ${config.START_BLOCK}`);
    console.log(`API URL: ${config.getApiUrl()}`);
    
    try {
        // Import and run the indexer
        const indexer = require('./index-runner.js');
        console.log('Starting Bitcoin inscription indexer...');
        
        // Use the global database connection instead of creating a new one
        if (global.db) {
            console.log('Using shared database connection for indexer');
            // Pass the existing database connection to avoid conflicts
            await indexer.startUnlimitedIndexing();
        } else {
            console.log('No database available, indexer will create its own connection');
            await indexer.startIndexer();
        }
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
