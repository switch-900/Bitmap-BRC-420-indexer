const express = require('express');
const cors = require('cors');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const net = require('net');
const config = require('./config');
const routes = require('./routes');

const app = express();
const PORT = config.WEB_PORT || 8080;

// Production-level error handlers
process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err.message);
    console.error('Stack trace:', err.stack);
    // In production, log to file and gracefully shutdown
    setTimeout(() => process.exit(1), 1000);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Global state
let dbInitialized = false;
let serverReady = false;

// Production-level port availability check
function checkPortAvailability(port) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        
        server.once('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                reject(new Error(`Port ${port} is already in use`));
            } else {
                reject(err);
            }
        });
        
        server.once('listening', () => {
            server.close();
            resolve(true);
        });
        
        server.listen(port);
    });
}

// Production database initialization with timeout and fallback
function initializeDatabase() {
    return new Promise((resolve) => {
        const DB_TIMEOUT = 30000; // 30 second timeout
        let resolved = false;
        
        console.log('[DB] Starting database initialization...');
        
        // Timeout handler
        const timeout = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                console.warn('[DB] Database initialization timed out - continuing without database');
                resolve(null);
            }
        }, DB_TIMEOUT);
        
        try {
            const DB_PATH = config.DB_PATH || './db/brc420.db';
            const dbDir = path.dirname(DB_PATH);
            
            // Ensure directory exists with proper error handling
            try {
                if (!fs.existsSync(dbDir)) {
                    fs.mkdirSync(dbDir, { recursive: true, mode: 0o755 });
                    console.log('[DB] Created database directory:', dbDir);
                }
                
                // Test write permissions
                const testFile = path.join(dbDir, '.write-test');
                fs.writeFileSync(testFile, 'test');
                fs.unlinkSync(testFile);
                console.log('[DB] Database directory is writable');
                
            } catch (dirError) {
                console.warn('[DB] Cannot write to database directory:', dirError.message);
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    resolve(null);
                }
                return;
            }
            
            // Open database with production settings
            const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
                if (err) {
                    console.error('[DB] Failed to open database:', err.message);
                    if (!resolved) {
                        resolved = true;
                        clearTimeout(timeout);
                        resolve(null);
                    }
                    return;
                }
                
                console.log('[DB] Database opened successfully');
                
                // Configure database for production
                db.serialize(() => {
                    // Production optimizations
                    db.run("PRAGMA journal_mode = WAL");
                    db.run("PRAGMA synchronous = NORMAL");
                    db.run("PRAGMA cache_size = -64000"); // 64MB cache
                    db.run("PRAGMA temp_store = MEMORY");
                    db.run("PRAGMA busy_timeout = 30000");
                    db.run("PRAGMA foreign_keys = ON");
                    
                    console.log('[DB] Database optimizations applied');
                    
                    // Create essential tables only (simplified for faster startup)
                    setupCriticalTables(db, (success) => {
                        if (!resolved) {
                            resolved = true;
                            clearTimeout(timeout);
                            
                            if (success) {
                                global.db = db;
                                dbInitialized = true;
                                console.log('[DB] Database initialization completed successfully');
                                resolve(db);
                            } else {
                                console.warn('[DB] Database setup failed - continuing without database');
                                resolve(null);
                            }
                        }
                    });
                });
            });
            
        } catch (error) {
            console.error('[DB] Database initialization error:', error.message);
            if (!resolved) {
                resolved = true;
                clearTimeout(timeout);
                resolve(null);
            }
        }
    });
}

// Setup only critical tables for faster startup
function setupCriticalTables(db, callback) {
    const tables = [
        {
            name: 'brc420_deploys',
            sql: `CREATE TABLE IF NOT EXISTS brc420_deploys (
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
            )`
        },
        {
            name: 'brc420_mints',
            sql: `CREATE TABLE IF NOT EXISTS brc420_mints (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                inscription_id TEXT UNIQUE NOT NULL,
                tick TEXT NOT NULL,
                amount INTEGER,
                block_height INTEGER,
                sat_number INTEGER,
                mint_data TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        },
        {
            name: 'bitmaps',
            sql: `CREATE TABLE IF NOT EXISTS bitmaps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                inscription_id TEXT UNIQUE NOT NULL,
                bitmap_number INTEGER NOT NULL,
                block_height INTEGER,
                sat_number INTEGER,
                transaction_patterns TEXT,
                pattern_metadata TEXT,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(bitmap_number)
            )`
        },
        {
            name: 'bitmap_patterns',
            sql: `CREATE TABLE IF NOT EXISTS bitmap_patterns (
                bitmap_number INTEGER PRIMARY KEY,
                pattern_string TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        },
        {
            name: 'processed_blocks',
            sql: `CREATE TABLE IF NOT EXISTS processed_blocks (
                block_height INTEGER PRIMARY KEY,
                inscriptions_processed INTEGER DEFAULT 0,
                inscriptions_skipped INTEGER DEFAULT 0,
                inscriptions_errors INTEGER DEFAULT 0,
                processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
            )`
        }
    ];
    
    let completed = 0;
    let hasError = false;
    
    tables.forEach((table) => {
        db.run(table.sql, (err) => {
            if (err && !hasError) {
                hasError = true;
                console.error(`[DB] Error creating table ${table.name}:`, err.message);
                callback(false);
                return;
            }
            
            completed++;
            if (completed === tables.length && !hasError) {
                console.log('[DB] Critical tables created successfully');
                
                // Create essential indexes
                const indexes = [
                    'CREATE INDEX IF NOT EXISTS idx_brc420_deploys_tick ON brc420_deploys(tick)',
                    'CREATE INDEX IF NOT EXISTS idx_bitmaps_number ON bitmaps(bitmap_number)',
                    'CREATE INDEX IF NOT EXISTS idx_processed_blocks_height ON processed_blocks(block_height)'
                ];
                
                let indexCompleted = 0;
                indexes.forEach((indexSql) => {
                    db.run(indexSql, (indexErr) => {
                        indexCompleted++;
                        if (indexCompleted === indexes.length) {
                            console.log('[DB] Essential indexes created');
                            callback(true);
                        }
                    });
                });
            }
        });
    });
}

// Setup Express middleware and routes
function setupExpress() {
    // Security and CORS
    app.use(cors({
        origin: process.env.NODE_ENV === 'production' ? false : true,
        credentials: true
    }));
    
    // Body parsing
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    
    // Static files with proper headers
    app.use(express.static(path.join(__dirname, 'public'), {
        maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
        etag: true,
        lastModified: true
    }));
    
    // API routes
    app.use('/', routes);
    
    // Main application routes
    app.get('/', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
    
    app.get('/deploy', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'deploy.html'));
    });
    
    app.get('/bitmaps', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'bitmaps.html'));
    });
    
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(__dirname, 'public', 'admin.html'));
    });
    
    // Health check with detailed status
    app.get('/health', (req, res) => {
        const health = {
            status: 'healthy',
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            memory: process.memoryUsage(),
            database: dbInitialized ? 'connected' : 'disconnected',
            server: serverReady ? 'ready' : 'starting',
            version: '1.0.0'
        };
        
        res.status(200).json(health);
    });
    
    // Readiness check for load balancers
    app.get('/ready', (req, res) => {
        if (serverReady) {
            res.status(200).json({ ready: true, timestamp: new Date().toISOString() });
        } else {
            res.status(503).json({ ready: false, reason: 'Server still starting' });
        }
    });
    
    // Configuration endpoint for frontend
    app.get('/api/config', (req, res) => {
        const frontendConfig = {
            localOrdinalsUrl: config.getLocalOrdinalsUrl(),
            apiUrl: '/api',
            features: {
                brc420: true,
                bitmaps: true,
                patterns: dbInitialized
            }
        };
        res.json(frontendConfig);
    });
    
    // Graceful 404 handling
    app.use((req, res) => {
        if (req.path.startsWith('/api/')) {
            res.status(404).json({ 
                error: 'API endpoint not found',
                path: req.path,
                method: req.method
            });
        } else {
            // Serve index.html for SPA routes
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        }
    });
    
    // Global error handler
    app.use((err, req, res, next) => {
        console.error('[EXPRESS] Unhandled error:', err.message);
        console.error('Stack trace:', err.stack);
        
        res.status(500).json({ 
            error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
            timestamp: new Date().toISOString()
        });
    });
}

// Start server with production-level error handling
async function startServer() {
    try {
        console.log('[SERVER] Starting BRC-420 Indexer Server...');
        console.log('[SERVER] Environment:', process.env.NODE_ENV || 'development');
        console.log('[SERVER] Port:', PORT);
        console.log('[SERVER] PID:', process.pid);
        
        // Check port availability
        try {
            await checkPortAvailability(PORT);
            console.log('[SERVER] Port', PORT, 'is available');
        } catch (portError) {
            console.error('[SERVER] Port check failed:', portError.message);
            process.exit(1);
        }
        
        // Setup Express app
        setupExpress();
        
        // Start HTTP server immediately
        const server = app.listen(PORT, '0.0.0.0', () => {
            console.log(`[SERVER] ✅ HTTP Server running on http://0.0.0.0:${PORT}`);
            console.log(`[SERVER] ✅ Server PID: ${process.pid}`);
            console.log(`[SERVER] ✅ Memory usage: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB`);
            serverReady = true;
        });
        
        // Server error handling
        server.on('error', (err) => {
            console.error('[SERVER] Server error:', err.message);
            if (err.code === 'EADDRINUSE') {
                console.error(`[SERVER] Port ${PORT} is already in use`);
                process.exit(1);
            }
        });
        
        // Setup graceful shutdown
        setupGracefulShutdown(server);
        
        // Initialize database in background (non-blocking)
        setTimeout(async () => {
            try {
                await initializeDatabase();
                
                // Start indexer if enabled and database is ready
                if (config.RUN_INDEXER && dbInitialized) {
                    setTimeout(() => {
                        startIndexerProcess().catch(err => {
                            console.error('[INDEXER] Failed to start:', err.message);
                        });
                    }, 5000);
                } else if (config.RUN_INDEXER) {
                    console.log('[INDEXER] Disabled - database not available');
                }
                
            } catch (dbError) {
                console.error('[DB] Background initialization failed:', dbError.message);
            }
        }, 2000);
        
        console.log('[SERVER] ✅ Server startup completed successfully');
        
    } catch (error) {
        console.error('[SERVER] ❌ Failed to start server:', error.message);
        process.exit(1);
    }
}

// Graceful shutdown handling
function setupGracefulShutdown(server) {
    const shutdown = async (signal) => {
        console.log(`[SERVER] Received ${signal}, starting graceful shutdown...`);
        
        try {
            // Stop accepting new connections
            server.close(() => {
                console.log('[SERVER] HTTP server closed');
            });
            
            // Close database connection
            if (global.db) {
                global.db.close((err) => {
                    if (err) {
                        console.error('[DB] Error closing database:', err.message);
                    } else {
                        console.log('[DB] Database connection closed');
                    }
                });
            }
            
            // Force exit after 10 seconds
            setTimeout(() => {
                console.log('[SERVER] Force exit after timeout');
                process.exit(1);
            }, 10000);
            
            console.log('[SERVER] ✅ Graceful shutdown completed');
            process.exit(0);
            
        } catch (error) {
            console.error('[SERVER] Error during shutdown:', error.message);
            process.exit(1);
        }
    };
    
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGUSR2', () => shutdown('SIGUSR2'));
}

// Start indexer process (if enabled)
async function startIndexerProcess() {
    if (!dbInitialized) {
        console.log('[INDEXER] Cannot start - database not initialized');
        return;
    }
    
    try {
        console.log('[INDEXER] Starting Bitcoin inscription indexer...');
        const indexer = require('./index-runner.js');
        await indexer.startUnlimitedIndexing();
    } catch (error) {
        console.error('[INDEXER] Error:', error.message);
        
        // Retry indexer after delay
        setTimeout(() => {
            console.log('[INDEXER] Retrying in 60 seconds...');
            startIndexerProcess().catch(console.error);
        }, 60000);
    }
}

// Start the server
if (require.main === module) {
    startServer().catch(error => {
        console.error('[SERVER] ❌ Startup failed:', error.message);
        process.exit(1);
    });
}

module.exports = { app, startServer };