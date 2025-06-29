const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');
const router = express.Router();

// Enhanced database connection with retry logic
class DatabaseManager {
    constructor() {
        this.db = null;
        this.isConnected = false;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectDelay = 5000; // 5 seconds
        
        this.initializeConnection();
    }
    
    async initializeConnection() {
        const dbPath = config.DB_PATH || './db/brc420.db';
        
        try {
            // Check if global database connection exists
            if (global.db) {
                console.log('[API] Using existing database connection');
                this.db = global.db;
                this.isConnected = true;
                this.setupErrorHandlers();
                return;
            }
            
            // Create new connection
            console.log('[API] Creating new database connection to:', dbPath);
            
            this.db = new sqlite3.Database(dbPath, sqlite3.OPEN_READONLY, (err) => {
                if (err) {
                    console.error('[API] Database connection failed:', err.message);
                    this.handleConnectionError(err);
                } else {
                    console.log('[API] Database connected successfully');
                    this.isConnected = true;
                    this.reconnectAttempts = 0;
                    this.setupOptimizations();
                    this.setupErrorHandlers();
                }
            });
            
        } catch (error) {
            console.error('[API] Database initialization error:', error.message);
            this.handleConnectionError(error);
        }
    }
    
    setupOptimizations() {
        if (!this.db) return;
        
        try {
            this.db.serialize(() => {
                this.db.run("PRAGMA cache_size = -32000"); // 32MB cache
                this.db.run("PRAGMA temp_store = MEMORY");
                this.db.run("PRAGMA query_only = ON"); // Read-only mode for API
            });
            console.log('[API] Database optimizations applied');
        } catch (error) {
            console.warn('[API] Failed to apply database optimizations:', error.message);
        }
    }
    
    setupErrorHandlers() {
        if (!this.db) return;
        
        this.db.on('error', (err) => {
            console.error('[API] Database error:', err.message);
            this.handleConnectionError(err);
        });
    }
    
    handleConnectionError(error) {
        this.isConnected = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            console.log(`[API] Attempting to reconnect (${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
            
            setTimeout(() => {
                this.initializeConnection();
            }, this.reconnectDelay * this.reconnectAttempts);
        } else {
            console.error('[API] Max reconnection attempts reached. Database unavailable.');
        }
    }
    
    isHealthy() {
        return this.isConnected && this.db;
    }
    
    getConnection() {
        return this.isHealthy() ? this.db : null;
    }
}

// Initialize database manager
const dbManager = new DatabaseManager();

// Middleware to check database availability
const requireDatabase = (req, res, next) => {
    if (!dbManager.isHealthy()) {
        return res.status(503).json({ 
            error: 'Database temporarily unavailable',
            code: 'DB_UNAVAILABLE',
            timestamp: new Date().toISOString()
        });
    }
    req.db = dbManager.getConnection();
    next();
};

// Enhanced error handler
const handleDatabaseError = (err, req, res, operation = 'database operation') => {
    console.error(`[API] ${operation} failed:`, err.message);
    
    if (err.code === 'SQLITE_BUSY') {
        return res.status(503).json({
            error: 'Database is busy, please try again',
            code: 'DB_BUSY',
            retryAfter: 1000
        });
    }
    
    if (err.code === 'SQLITE_LOCKED') {
        return res.status(503).json({
            error: 'Database is locked, please try again',
            code: 'DB_LOCKED',
            retryAfter: 2000
        });
    }
    
    return res.status(500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
        code: 'DB_ERROR',
        operation: operation
    });
};

// Helper function for pagination with validation
function paginate(query, params, page = 1, limit = 100) {
    const pageNum = Math.max(1, parseInt(page) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit) || 100), 1000); // Cap at 1000
    const offset = (pageNum - 1) * limitNum;
    
    return {
        query: query + ` LIMIT ${limitNum} OFFSET ${offset}`,
        params: params,
        page: pageNum,
        limit: limitNum
    };
}

// Enhanced health check endpoint
router.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: dbManager.isHealthy() ? 'connected' : 'disconnected',
        indexer: 'BRC-420 & Bitmap Complete Indexer',
        version: '1.0.0',
        uptime: process.uptime(),
        memory: {
            used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        }
    };
    
    const statusCode = dbManager.isHealthy() ? 200 : 503;
    res.status(statusCode).json(health);
});

// Configuration endpoint for frontend
router.get('/config', (req, res) => {
    try {
        const frontendConfig = config.getFrontendConfig();
        res.json(frontendConfig);
    } catch (error) {
        console.error('[API] Config endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to get configuration' });
    }
});

// ==================== BRC-420 ENDPOINTS ====================

// Get all BRC-420 deploys with enhanced error handling
router.get('/brc420/deploys', requireDatabase, (req, res) => {
    const { page = 1, limit = 50, search = '' } = req.query;
    
    try {
        let query = "SELECT * FROM brc420_deploys";
        let countQuery = "SELECT COUNT(*) as total FROM brc420_deploys";
        let params = [];
        
        if (search) {
            const whereClause = " WHERE tick LIKE ? OR inscription_id LIKE ?";
            query += whereClause;
            countQuery += whereClause;
            params = [`%${search}%`, `%${search}%`];
        }
        
        query += " ORDER BY block_height DESC";
        const paginatedQuery = paginate(query, params, page, limit);

        // Get total count first
        req.db.get(countQuery, params, (countErr, countRow) => {
            if (countErr) {
                return handleDatabaseError(countErr, req, res, 'count query');
            }
            
            // Get paginated results
            req.db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
                if (err) {
                    return handleDatabaseError(err, req, res, 'deploys query');
                }
                
                // Process deploy data
                const processedRows = rows.map(row => {
                    if (row.deploy_data) {
                        try {
                            row.parsed_deploy_data = JSON.parse(row.deploy_data);
                        } catch (parseErr) {
                            console.warn('[API] Failed to parse deploy_data for', row.inscription_id);
                        }
                    }
                    return row;
                });
                
                res.json({
                    deploys: processedRows,
                    total: countRow?.total || 0,
                    page: paginatedQuery.page,
                    limit: paginatedQuery.limit,
                    totalPages: Math.ceil((countRow?.total || 0) / paginatedQuery.limit)
                });
            });
        });
        
    } catch (error) {
        console.error('[API] BRC-420 deploys endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch deploys' });
    }
});

// Get BRC-420 deploy by inscription ID
router.get('/brc420/deploy/:inscription_id', requireDatabase, (req, res) => {
    const inscriptionId = req.params.inscription_id;

    if (!inscriptionId || inscriptionId.length < 10) {
        return res.status(400).json({ error: 'Invalid inscription ID' });
    }

    req.db.get("SELECT * FROM brc420_deploys WHERE inscription_id = ?", [inscriptionId], (err, row) => {
        if (err) {
            return handleDatabaseError(err, req, res, 'deploy lookup');
        }
        
        if (!row) {
            return res.status(404).json({ error: "BRC-420 deploy not found" });
        }
        
        // Parse deploy_data if it exists
        if (row.deploy_data) {
            try {
                row.parsed_deploy_data = JSON.parse(row.deploy_data);
            } catch (parseErr) {
                console.warn('[API] Failed to parse deploy_data for', inscriptionId);
            }
        }
        
        res.json(row);
    });
});

// Get all BRC-420 mints
router.get('/brc420/mints', requireDatabase, (req, res) => {
    const { page = 1, limit = 50, tick = '', search = '' } = req.query;
    
    try {
        let query = "SELECT * FROM brc420_mints";
        let countQuery = "SELECT COUNT(*) as total FROM brc420_mints";
        let params = [];
        let whereConditions = [];
        
        if (tick) {
            whereConditions.push("tick = ?");
            params.push(tick);
        }
        
        if (search) {
            whereConditions.push("(inscription_id LIKE ? OR tick LIKE ?)");
            params.push(`%${search}%`, `%${search}%`);
        }
        
        if (whereConditions.length > 0) {
            const whereClause = " WHERE " + whereConditions.join(" AND ");
            query += whereClause;
            countQuery += whereClause;
        }
        
        query += " ORDER BY block_height DESC";
        const paginatedQuery = paginate(query, params, page, limit);

        // Get total count
        req.db.get(countQuery, params, (countErr, countRow) => {
            if (countErr) {
                return handleDatabaseError(countErr, req, res, 'mints count query');
            }
            
            // Get paginated results
            req.db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
                if (err) {
                    return handleDatabaseError(err, req, res, 'mints query');
                }
                
                // Parse mint_data for each row
                const processedRows = rows.map(row => {
                    if (row.mint_data) {
                        try {
                            row.parsed_mint_data = JSON.parse(row.mint_data);
                        } catch (parseErr) {
                            console.warn('[API] Failed to parse mint_data for', row.inscription_id);
                        }
                    }
                    return row;
                });
                
                res.json({
                    mints: processedRows,
                    total: countRow?.total || 0,
                    page: paginatedQuery.page,
                    limit: paginatedQuery.limit,
                    totalPages: Math.ceil((countRow?.total || 0) / paginatedQuery.limit)
                });
            });
        });
        
    } catch (error) {
        console.error('[API] BRC-420 mints endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to fetch mints' });
    }
});

// ==================== BITMAP ENDPOINTS ====================

// Get bitmaps with search functionality
router.get('/bitmaps/search', (req, res) => {
    // Provide fallback data if database is unavailable
    if (!dbManager.isHealthy()) {
        console.warn('[API] Database unavailable, returning sample data');
        return res.json({
            bitmaps: [],
            total: 0,
            page: 1,
            limit: 50,
            totalPages: 0,
            message: 'Database temporarily unavailable'
        });
    }

    const { page = 1, limit = 50, sort = 'bitmap_number_desc', search = '' } = req.query;
    
    try {
        let query = `
            SELECT b.*, bp.pattern_string 
            FROM bitmaps b 
            LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
        `;
        let countQuery = "SELECT COUNT(*) as total FROM bitmaps b";
        let params = [];

        if (search) {
            const whereClause = " WHERE (CAST(b.bitmap_number AS TEXT) LIKE ? OR b.inscription_id LIKE ?)";
            query += whereClause;
            countQuery += whereClause;
            params = [`%${search}%`, `%${search}%`];
        }

        // Build ORDER BY clause
        let orderBy = ' ORDER BY b.bitmap_number DESC';
        switch (sort) {
            case 'bitmap_number_asc':
                orderBy = ' ORDER BY b.bitmap_number ASC';
                break;
            case 'bitmap_number_desc':
                orderBy = ' ORDER BY b.bitmap_number DESC';
                break;
            case 'block_height_asc':
                orderBy = ' ORDER BY b.block_height ASC';
                break;
            case 'block_height_desc':
                orderBy = ' ORDER BY b.block_height DESC';
                break;
            case 'random':
                orderBy = ' ORDER BY RANDOM()';
                break;
        }
        
        query += orderBy;
        const paginatedQuery = paginate(query, params, page, limit);

        // Get total count
        req.db.get(countQuery, params, (countErr, countRow) => {
            if (countErr) {
                return handleDatabaseError(countErr, req, res, 'bitmaps count query');
            }
            
            // Get paginated results
            req.db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
                if (err) {
                    return handleDatabaseError(err, req, res, 'bitmaps query');
                }
                
                // Process pattern data for each bitmap
                const processedRows = rows.map(row => {
                    if (row.pattern_string) {
                        row.pattern = 'mondrian';
                        row.txList = row.pattern_string.split('').map(Number);
                        delete row.pattern_string; // Remove raw string from response
                    } else {
                        row.pattern = null;
                        row.txList = [];
                    }
                    
                    // Parse JSON fields safely
                    ['transaction_patterns', 'pattern_metadata'].forEach(field => {
                        if (row[field]) {
                            try {
                                row[`parsed_${field}`] = JSON.parse(row[field]);
                            } catch (parseErr) {
                                console.warn(`[API] Failed to parse ${field} for bitmap`, row.bitmap_number);
                            }
                        }
                    });
                    
                    return row;
                });
                
                const total = countRow?.total || 0;
                
                res.json({
                    bitmaps: processedRows,
                    total: total,
                    page: paginatedQuery.page,
                    limit: paginatedQuery.limit,
                    totalPages: Math.ceil(total / paginatedQuery.limit)
                });
            });
        });
        
    } catch (error) {
        console.error('[API] Bitmaps search endpoint error:', error.message);
        res.status(500).json({ error: 'Failed to search bitmaps' });
    }
});

// Legacy endpoint for backward compatibility
router.get('/bitmaps', (req, res) => {
    // Redirect to search endpoint
    const queryString = new URLSearchParams(req.query).toString();
    const redirectUrl = `/api/bitmaps/search${queryString ? '?' + queryString : ''}`;
    res.redirect(301, redirectUrl);
});

// Get bitmap by number
router.get('/bitmaps/number/:bitmap_number', requireDatabase, (req, res) => {
    const bitmapNumber = parseInt(req.params.bitmap_number);
    
    if (isNaN(bitmapNumber) || bitmapNumber < 0) {
        return res.status(400).json({ error: 'Invalid bitmap number' });
    }

    const query = `
        SELECT b.*, bp.pattern_string 
        FROM bitmaps b 
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number 
        WHERE b.bitmap_number = ?
    `;

    req.db.get(query, [bitmapNumber], (err, row) => {
        if (err) {
            return handleDatabaseError(err, req, res, 'bitmap lookup');
        }
        
        if (!row) {
            return res.status(404).json({ error: "Bitmap not found" });
        }
        
        // Process pattern data
        if (row.pattern_string) {
            row.pattern = 'mondrian';
            row.txList = row.pattern_string.split('').map(Number);
            delete row.pattern_string;
        } else {
            row.pattern = null;
            row.txList = [];
        }
        
        // Parse JSON fields safely
        ['transaction_patterns', 'pattern_metadata'].forEach(field => {
            if (row[field]) {
                try {
                    row[`parsed_${field}`] = JSON.parse(row[field]);
                } catch (parseErr) {
                    console.warn(`[API] Failed to parse ${field} for bitmap`, row.bitmap_number);
                }
            }
        });
        
        res.json(row);
    });
});

// Get bitmap pattern for visualization
router.get('/bitmap/:bitmap_number/pattern', requireDatabase, (req, res) => {
    const bitmapNumber = parseInt(req.params.bitmap_number);
    
    if (isNaN(bitmapNumber) || bitmapNumber < 0) {
        return res.status(400).json({ error: 'Invalid bitmap number' });
    }

    req.db.get("SELECT * FROM bitmap_patterns WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
        if (err) {
            return handleDatabaseError(err, req, res, 'pattern lookup');
        }
        
        if (!row) {
            return res.status(404).json({ error: "Pattern not found for this bitmap" });
        }
        
        // Convert pattern string to array format for compatibility
        const patternString = row.pattern_string;
        const txList = patternString ? patternString.split('').map(Number) : [];
        
        const responseData = {
            bitmap_number: parseInt(row.bitmap_number),
            pattern: 'mondrian',
            pattern_string: patternString,
            txList: txList,
            squareSizes: txList, // Backward compatibility
            created_at: row.created_at
        };
        
        res.json(responseData);
    });
});

// ==================== STATISTICS ENDPOINTS ====================

// Get comprehensive statistics
router.get('/stats', (req, res) => {
    if (!dbManager.isHealthy()) {
        return res.json({
            indexer_stats: {
                brc420_deploys: 0,
                brc420_mints: 0,
                bitmaps: 0,
                processed_blocks: 0,
                failed_inscriptions: 0,
                latest_block: 0
            },
            timestamp: new Date().toISOString(),
            status: 'database_unavailable'
        });
    }

    const db = dbManager.getConnection();
    if (!db) {
        return res.status(503).json({ 
            error: 'Database connection unavailable',
            timestamp: new Date().toISOString()
        });
    }

    const queries = {
        brc420_deploys: "SELECT COUNT(*) as count FROM brc420_deploys",
        brc420_mints: "SELECT COUNT(*) as count FROM brc420_mints",
        bitmaps: "SELECT COUNT(*) as count FROM bitmaps",
        processed_blocks: "SELECT COUNT(*) as count FROM processed_blocks",
        failed_inscriptions: "SELECT COUNT(*) as count FROM failed_inscriptions",
        latest_block: "SELECT MAX(block_height) as latest FROM processed_blocks"
    };
    
    const stats = {};
    let completed = 0;
    const total = Object.keys(queries).length;
    
    Object.entries(queries).forEach(([key, query]) => {
        db.get(query, [], (err, row) => {
            if (!err && row) {
                stats[key] = row.count !== undefined ? row.count : row.latest;
            } else {
                stats[key] = 0;
            }
            
            completed++;
            if (completed === total) {
                res.json({
                    indexer_stats: stats,
                    timestamp: new Date().toISOString()
                });
            }
        });
    });
});

// ==================== FALLBACK AND ERROR HANDLING ====================

// Global search endpoint with fallback
router.get('/search', (req, res) => {
    if (!dbManager.isHealthy()) {
        return res.json({
            query: req.query.q || '',
            results: [],
            total_found: 0,
            message: 'Database temporarily unavailable'
        });
    }

    const { q: query, limit = 20 } = req.query;
    
    if (!query || query.trim().length === 0) {
        return res.status(400).json({ error: 'Search query required' });
    }
    
    const searchTerm = `%${query.trim()}%`;
    const searchLimit = Math.min(parseInt(limit), 100);
    
    const searchQueries = [
        {
            type: 'brc420_deploy',
            query: `SELECT 'brc420_deploy' as type, inscription_id, tick as identifier, block_height FROM brc420_deploys WHERE inscription_id LIKE ? OR tick LIKE ? LIMIT ?`,
            params: [searchTerm, searchTerm, searchLimit]
        },
        {
            type: 'bitmap',
            query: `SELECT 'bitmap' as type, inscription_id, CAST(bitmap_number AS TEXT) as identifier, block_height FROM bitmaps WHERE inscription_id LIKE ? OR CAST(bitmap_number AS TEXT) LIKE ? LIMIT ?`,
            params: [searchTerm, searchTerm, searchLimit]
        }
    ];
    
    const results = [];
    let completed = 0;
    let hasError = false;
    
    searchQueries.forEach(({ type, query, params }) => {
        req.db.all(query, params, (err, rows) => {
            if (!err && rows && !hasError) {
                results.push(...rows);
            } else if (err && !hasError) {
                hasError = true;
                return handleDatabaseError(err, req, res, 'search query');
            }
            
            completed++;
            if (completed === searchQueries.length && !hasError) {
                // Sort by block height descending
                results.sort((a, b) => (b.block_height || 0) - (a.block_height || 0));
                
                res.json({
                    query: query,
                    results: results.slice(0, searchLimit),
                    total_found: results.length
                });
            }
        });
    });
});

// Catch-all error handler for API routes
router.use((err, req, res, next) => {
    console.error('[API] Unhandled error:', err.message);
    res.status(500).json({
        error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message,
        timestamp: new Date().toISOString()
    });
});

// 404 handler for API routes
router.use((req, res) => {
    res.status(404).json({
        error: 'API endpoint not found',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

module.exports = router;