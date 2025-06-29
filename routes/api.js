const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const config = require('../config');
const router = express.Router();

// Use the same database path as the indexer
const dbPath = config.DB_PATH || './db/brc420.db';
let db = null;

// Initialize database connection with optimizations
try {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('API Routes: Error opening database:', err.message);
            console.log('API Routes: Endpoints will return errors until database is available');
        } else {
            console.log('API Routes: Connected to indexer database');
            
            // Apply performance optimizations
            db.serialize(() => {
                db.run("PRAGMA journal_mode = WAL");
                db.run("PRAGMA synchronous = NORMAL");
                db.run("PRAGMA cache_size = -32000"); // 32MB cache
                db.run("PRAGMA temp_store = MEMORY");
                console.log('API Routes: Database optimized for performance');
            });
        }
    });
} catch (error) {
    console.error('API Routes: Failed to create database connection:', error.message);
}

// Helper function for pagination
function paginate(query, params, page = 1, limit = 100) { 
    const offset = (page - 1) * limit;
    const cappedLimit = Math.min(limit, 1000); // Cap at 1000 for performance
    return {
        query: query + ` LIMIT ${cappedLimit} OFFSET ${offset}`,
        params: params
    };
}

// Health check endpoint
router.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: db ? 'connected' : 'disconnected',
        indexer: 'BRC-420 & Bitmap Complete Indexer'
    };
    res.json(health);
});

// ==================== BRC-420 ENDPOINTS ====================

// Get all BRC-420 deploys
router.get('/brc420/deploys', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 50, search = '' } = req.query;
    let query = "SELECT * FROM brc420_deploys";
    let params = [];
    
    if (search) {
        query += " WHERE tick LIKE ? OR inscription_id LIKE ?";
        params = [`%${search}%`, `%${search}%`];
    }
    
    query += " ORDER BY block_height DESC";
    
    const paginatedQuery = paginate(query, params, page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Get total count
        db.get("SELECT COUNT(*) as total FROM brc420_deploys", (countErr, countRow) => {
            if (countErr) {
                return res.status(500).json({ error: countErr.message });
            }
            
            res.json({
                deploys: rows,
                total: countRow.total,
                page: parseInt(page),
                limit: parseInt(limit)
            });
        });
    });
});

// Get BRC-420 deploy by inscription ID
router.get('/brc420/deploy/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.get("SELECT * FROM brc420_deploys WHERE inscription_id = ?", [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "BRC-420 deploy not found" });
        }
        
        // Parse deploy_data if it exists
        if (row.deploy_data) {
            try {
                row.parsed_deploy_data = JSON.parse(row.deploy_data);
            } catch (parseErr) {
                console.warn('Failed to parse deploy_data for', inscriptionId);
            }
        }
        
        return res.json(row);
    });
});

// Get all BRC-420 mints
router.get('/brc420/mints', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 50, tick = '', search = '' } = req.query;
    let query = "SELECT * FROM brc420_mints";
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
        query += " WHERE " + whereConditions.join(" AND ");
    }
    
    query += " ORDER BY block_height DESC";
    
    const paginatedQuery = paginate(query, params, page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        // Parse mint_data for each row
        const processedRows = rows.map(row => {
            if (row.mint_data) {
                try {
                    row.parsed_mint_data = JSON.parse(row.mint_data);
                } catch (parseErr) {
                    console.warn('Failed to parse mint_data for', row.inscription_id);
                }
            }
            return row;
        });
        
        res.json({
            mints: processedRows,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    });
});

// Get BRC-420 mint by inscription ID
router.get('/brc420/mint/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.get("SELECT * FROM brc420_mints WHERE inscription_id = ?", [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "BRC-420 mint not found" });
        }
        
        // Parse mint_data if it exists
        if (row.mint_data) {
            try {
                row.parsed_mint_data = JSON.parse(row.mint_data);
            } catch (parseErr) {
                console.warn('Failed to parse mint_data for', inscriptionId);
            }
        }
        
        return res.json(row);
    });
});

// Get BRC-420 summary statistics
router.get('/brc420/summary', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const query = `
        SELECT 
            (SELECT COUNT(*) FROM brc420_deploys) as total_deploys,
            (SELECT COUNT(*) FROM brc420_mints) as total_mints,
            (SELECT COUNT(DISTINCT tick) FROM brc420_deploys) as unique_ticks,
            (SELECT MAX(block_height) FROM brc420_deploys) as latest_deploy_block,
            (SELECT MAX(block_height) FROM brc420_mints) as latest_mint_block
    `;
    
    db.get(query, [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(row || {});
    });
});

// ==================== BITMAP ENDPOINTS ====================

// Get all bitmaps
router.get('/bitmaps', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 50, sort = 'bitmap_number_desc', search = '' } = req.query;
    let query = "SELECT b.*, bp.pattern_string FROM bitmaps b LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number";
    let params = [];

    if (search) {
        query += " WHERE (CAST(b.bitmap_number AS TEXT) LIKE ? OR b.inscription_id LIKE ?)";
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

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
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
            
            // Parse transaction_patterns and pattern_metadata if they exist
            if (row.transaction_patterns) {
                try {
                    row.parsed_transaction_patterns = JSON.parse(row.transaction_patterns);
                } catch (parseErr) {
                    console.warn('Failed to parse transaction_patterns for bitmap', row.bitmap_number);
                }
            }
            
            if (row.pattern_metadata) {
                try {
                    row.parsed_pattern_metadata = JSON.parse(row.pattern_metadata);
                } catch (parseErr) {
                    console.warn('Failed to parse pattern_metadata for bitmap', row.bitmap_number);
                }
            }
            
            return row;
        });
        
        // Get total count
        db.get("SELECT COUNT(*) as total FROM bitmaps", (countErr, countRow) => {
            if (countErr) {
                return res.status(500).json({ error: countErr.message });
            }
            
            res.json({
                bitmaps: processedRows,
                total: countRow.total,
                page: parseInt(page),
                limit: parseInt(limit),
                totalPages: Math.ceil(countRow.total / limit)
            });
        });
    });
});

// Get bitmap by inscription ID
router.get('/bitmap/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    const query = `
        SELECT b.*, bp.pattern_string 
        FROM bitmaps b 
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number 
        WHERE b.inscription_id = ?
    `;

    db.get(query, [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
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
        
        // Parse JSON fields
        if (row.transaction_patterns) {
            try {
                row.parsed_transaction_patterns = JSON.parse(row.transaction_patterns);
            } catch (parseErr) {
                console.warn('Failed to parse transaction_patterns for bitmap', row.bitmap_number);
            }
        }
        
        if (row.pattern_metadata) {
            try {
                row.parsed_pattern_metadata = JSON.parse(row.pattern_metadata);
            } catch (parseErr) {
                console.warn('Failed to parse pattern_metadata for bitmap', row.bitmap_number);
            }
        }
        
        return res.json(row);
    });
});

// Get bitmap by bitmap number
router.get('/bitmaps/number/:bitmap_number', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const bitmapNumber = parseInt(req.params.bitmap_number);
    
    if (isNaN(bitmapNumber)) {
        return res.status(400).json({ error: 'Invalid bitmap number' });
    }

    const query = `
        SELECT b.*, bp.pattern_string 
        FROM bitmaps b 
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number 
        WHERE b.bitmap_number = ?
    `;

    db.get(query, [bitmapNumber], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
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
        
        // Parse JSON fields
        if (row.transaction_patterns) {
            try {
                row.parsed_transaction_patterns = JSON.parse(row.transaction_patterns);
            } catch (parseErr) {
                console.warn('Failed to parse transaction_patterns for bitmap', row.bitmap_number);
            }
        }
        
        if (row.pattern_metadata) {
            try {
                row.parsed_pattern_metadata = JSON.parse(row.pattern_metadata);
            } catch (parseErr) {
                console.warn('Failed to parse pattern_metadata for bitmap', row.bitmap_number);
            }
        }
        
        return res.json(row);
    });
});

// Get bitmap pattern for visualization
router.get('/bitmap/:bitmap_number/pattern', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const bitmapNumber = parseInt(req.params.bitmap_number);
    
    if (isNaN(bitmapNumber)) {
        return res.status(400).json({ error: 'Invalid bitmap number' });
    }

    db.get("SELECT * FROM bitmap_patterns WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Pattern not found for this bitmap" });
        }
        
        // Convert pattern string to array format for compatibility
        const patternString = row.pattern_string;
        const txList = patternString.split('').map(Number);
        
        const responseData = {
            bitmap_number: parseInt(row.bitmap_number),
            pattern: 'mondrian',
            pattern_string: patternString,
            txList: txList,
            squareSizes: txList // Backward compatibility
        };
        
        return res.json(responseData);
    });
});

// Get bitmap summary statistics
router.get('/bitmaps/summary', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const query = `
        SELECT 
            COUNT(*) as total_bitmaps,
            MAX(bitmap_number) as highest_bitmap_number,
            MIN(bitmap_number) as lowest_bitmap_number,
            MAX(block_height) as latest_block_height,
            MIN(block_height) as earliest_block_height,
            COUNT(CASE WHEN sat_number IS NOT NULL THEN 1 END) as bitmaps_with_sat_numbers,
            (SELECT COUNT(*) FROM bitmap_patterns) as bitmaps_with_patterns
        FROM bitmaps
    `;
    
    db.get(query, [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(row || {});
    });
});

// ==================== PARCEL ENDPOINTS ====================

// Get all parcels
router.get('/parcels', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { 
        page = 1, 
        limit = 50, 
        bitmap_number, 
        search = '',
        is_valid
    } = req.query;
    
    let query = `
        SELECT p.*, b.bitmap_number as parent_bitmap_number 
        FROM parcels p 
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
    `;
    let params = [];
    let whereConditions = [];
    
    if (bitmap_number) {
        whereConditions.push("p.bitmap_number = ?");
        params.push(parseInt(bitmap_number));
    }
    
    if (search) {
        whereConditions.push("(p.inscription_id LIKE ? OR CAST(p.parcel_number AS TEXT) LIKE ?)");
        params.push(`%${search}%`, `%${search}%`);
    }
    
    if (is_valid !== undefined) {
        whereConditions.push("p.is_valid = ?");
        params.push(is_valid === 'true' ? 1 : 0);
    }
    
    if (whereConditions.length > 0) {
        query += " WHERE " + whereConditions.join(" AND ");
    }
    
    query += " ORDER BY p.bitmap_number ASC, p.parcel_number ASC";
    
    const paginatedQuery = paginate(query, params, page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json({
            parcels: rows,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    });
});

// Get parcel by inscription ID
router.get('/parcel/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    const query = `
        SELECT p.*, b.bitmap_number as parent_bitmap_number, b.inscription_id as parent_inscription_id
        FROM parcels p 
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        WHERE p.inscription_id = ?
    `;

    db.get(query, [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Parcel not found" });
        }
        return res.json(row);
    });
});

// ==================== PROCESSING STATUS ENDPOINTS ====================

// Get processed blocks
router.get('/blocks/processed', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 100 } = req.query;
    
    const query = "SELECT * FROM processed_blocks ORDER BY block_height DESC";
    const paginatedQuery = paginate(query, [], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json({
            blocks: rows,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    });
});

// Get processing status for a specific block
router.get('/block/:block_height/status', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const blockHeight = parseInt(req.params.block_height);
    
    if (isNaN(blockHeight)) {
        return res.status(400).json({ error: 'Invalid block height' });
    }

    db.get("SELECT * FROM processed_blocks WHERE block_height = ?", [blockHeight], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Block not found or not yet processed" });
        }
        return res.json(row);
    });
});

// Get failed inscriptions
router.get('/failed-inscriptions', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 50 } = req.query;
    
    const query = "SELECT * FROM failed_inscriptions ORDER BY created_at DESC";
    const paginatedQuery = paginate(query, [], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        res.json({
            failed_inscriptions: rows,
            page: parseInt(page),
            limit: parseInt(limit)
        });
    });
});

// Get indexer statistics
router.get('/stats', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const queries = {
        brc420_deploys: "SELECT COUNT(*) as count FROM brc420_deploys",
        brc420_mints: "SELECT COUNT(*) as count FROM brc420_mints",
        bitmaps: "SELECT COUNT(*) as count FROM bitmaps",
        parcels: "SELECT COUNT(*) as count FROM parcels",
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

// ==================== SEARCH ENDPOINTS ====================

// Global search across all inscription types
router.get('/search', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
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
            type: 'brc420_mint',
            query: `SELECT 'brc420_mint' as type, inscription_id, tick as identifier, block_height FROM brc420_mints WHERE inscription_id LIKE ? OR tick LIKE ? LIMIT ?`,
            params: [searchTerm, searchTerm, searchLimit]
        },
        {
            type: 'bitmap',
            query: `SELECT 'bitmap' as type, inscription_id, CAST(bitmap_number AS TEXT) as identifier, block_height FROM bitmaps WHERE inscription_id LIKE ? OR CAST(bitmap_number AS TEXT) LIKE ? LIMIT ?`,
            params: [searchTerm, searchTerm, searchLimit]
        },
        {
            type: 'parcel',
            query: `SELECT 'parcel' as type, inscription_id, CAST(parcel_number AS TEXT) || '.' || CAST(bitmap_number AS TEXT) as identifier, block_height FROM parcels WHERE inscription_id LIKE ? OR CAST(parcel_number AS TEXT) LIKE ? LIMIT ?`,
            params: [searchTerm, searchTerm, searchLimit]
        }
    ];
    
    const results = [];
    let completed = 0;
    
    searchQueries.forEach(({ type, query, params }) => {
        db.all(query, params, (err, rows) => {
            if (!err && rows) {
                results.push(...rows);
            }
            
            completed++;
            if (completed === searchQueries.length) {
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

module.exports = router;