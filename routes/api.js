const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const config = require('../config');
const router = express.Router();

// Create database connection with the same path as server.js and optimize for local node
const dbPath = config.DB_PATH || './db/brc420.db';
let db = null;

// Initialize database connection with optimizations
try {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Routes: Error opening database:', err.message);
            console.log('Routes: API endpoints will return errors until database is available');
        } else {
            console.log('Routes: Connected to SQLite database for API endpoints');
            
            // Apply performance optimizations for local node
            db.serialize(() => {
                db.run("PRAGMA journal_mode = WAL");
                db.run("PRAGMA synchronous = NORMAL");
                db.run("PRAGMA cache_size = -32000"); // 32MB cache for API queries
                db.run("PRAGMA temp_store = MEMORY");
                console.log('Routes: Database optimized for local node performance');
            });
        }
    });
} catch (error) {
    console.error('Routes: Failed to create database connection:', error.message);
}

// Helper function for pagination - optimized for local node
function paginate(query, params, page = 1, limit = 100) { 
    const offset = (page - 1) * limit;
    // Cap maximum limit to prevent memory issues on very large queries
    const cappedLimit = Math.min(limit, 10000); // Increased to 10,000 for local node
    return {
        query: query + ` LIMIT ${cappedLimit} OFFSET ${offset}`,
        params: params
    };
}

// Health check endpoint for API
router.get('/health', (req, res) => {
    const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        database: db ? 'connected' : 'disconnected'
    };
    res.json(health);
});

// Configuration endpoint for frontend
router.get('/config', (req, res) => {
    const configData = {
        localOrdinalsUrl: config.getLocalOrdinalsUrl(),
        isUmbrelEnvironment: config.isUmbrelEnvironment(),
        startBlock: config.START_BLOCK
    };
    res.json(configData);
});

// Endpoint to get deploy inscriptions by ID or name - optimized for local node
router.get('/deploys', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { id, name, page = 1, limit = 100 } = req.query; // Increased default limit
    let query, params;

    if (id) {
        query = "SELECT * FROM deploys WHERE id = ?";
        params = [id];
    } else if (name) {
        query = "SELECT * FROM deploys WHERE name LIKE ?";
        params = [`%${name}%`]; // Using LIKE to allow partial name matches
    } else {
        query = "SELECT * FROM deploys ORDER BY block_height DESC";
        params = [];
    }

    const paginatedQuery = paginate(query, params, page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to validate a mint by mint ID
router.get('/mint/:mint_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const mintId = req.params.mint_id;

    db.get("SELECT * FROM mints WHERE id = ?", [mintId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Mint not found" });
        }
        return res.json(row);
    });
});

// Endpoint to get mints for a specific deploy ID
router.get('/deploy/:deploy_id/mints', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const deployId = req.params.deploy_id;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate("SELECT * FROM mints WHERE deploy_id = ? ORDER BY block_height DESC", [deployId], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get wallet information for an inscription
router.get('/wallet/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    // Updated to query deploys, mints, and bitmaps directly
    const query = `
        SELECT * FROM (
            SELECT id as inscription_id, wallet as address, 'deploy' as type FROM deploys WHERE id = ?
            UNION ALL
            SELECT id as inscription_id, wallet as address, 'mint' as type FROM mints WHERE id = ?
            UNION ALL
            SELECT inscription_id, wallet as address, 'bitmap' as type FROM bitmaps WHERE inscription_id = ?
        ) WHERE inscription_id = ?
    `;

    db.get(query, [inscriptionId, inscriptionId, inscriptionId, inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Wallet not found for this inscription" });
        }
        return res.json(row);
    });
});

// Endpoint to get all inscriptions for a specific address
router.get('/address/:address/inscriptions', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const address = req.params.address;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate(`
        SELECT * FROM (
            SELECT id as inscription_id, wallet as address, 'deploy' as type FROM deploys WHERE wallet = ?
            UNION ALL
            SELECT id as inscription_id, wallet as address, 'mint' as type FROM mints WHERE wallet = ?
            UNION ALL
            SELECT inscription_id, wallet as address, 'bitmap' as type FROM bitmaps WHERE wallet = ?
        ) WHERE address = ?
    `, [address, address, address, address], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get the processing status of a specific block
router.get('/block/:block_height/status', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const blockHeight = req.params.block_height;

    db.get("SELECT * FROM blocks WHERE block_height = ?", [blockHeight], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Block not found or not yet processed" });
        }
        return res.json({ block_height: row.block_height, processed: row.processed === 1 });
    });
});

// Endpoint to get error blocks
router.get('/error-blocks', (req, res) => {
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate("SELECT * FROM error_blocks ORDER BY retry_at", [], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get a summary of a specific deploy by ID
router.get('/deploy/:deploy_id/summary', (req, res) => {
    const deployId = req.params.deploy_id;

    db.get(`SELECT 
                deploys.*, 
                COUNT(mints.id) as total_mints 
            FROM deploys 
            LEFT JOIN mints ON deploys.id = mints.deploy_id 
            WHERE deploys.id = ? 
            GROUP BY deploys.id`, 
            [deployId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Deploy not found" });
        }
        return res.json(row);
    });
});

// Endpoint to get all deploys with their mint counts
router.get('/deploys/with-mints', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate(`
        SELECT 
            deploys.*, 
            COUNT(mints.id) as total_mints 
        FROM deploys 
        LEFT JOIN mints ON deploys.id = mints.deploy_id 
        GROUP BY deploys.id`, [], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// New endpoint to get bitmap by inscription ID
router.get('/bitmap/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.get("SELECT * FROM bitmaps WHERE inscription_id = ?", [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Bitmap not found" });
        }
        return res.json(row);
    });
});

// Endpoint to get bitmaps by bitmap number
router.get('/bitmaps/number/:bitmap_number', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const bitmapNumber = req.params.bitmap_number;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate("SELECT * FROM bitmaps WHERE bitmap_number = ?", [bitmapNumber], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get all bitmaps for a specific address
router.get('/address/:address/bitmaps', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const address = req.params.address;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate("SELECT * FROM bitmaps WHERE address = ?", [address], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get a summary of bitmaps (total count, latest bitmap number, etc.)
router.get('/bitmaps/summary', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    db.get(`
        SELECT 
            COUNT(*) as total_bitmaps,
            MAX(bitmap_number) as latest_bitmap_number,
            MIN(timestamp) as earliest_timestamp,
            MAX(timestamp) as latest_timestamp
        FROM bitmaps
    `, (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(row);
    });
});

// New endpoint to get all bitmaps with optional pagination
router.get('/bitmaps', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    db.all("SELECT * FROM bitmaps LIMIT ? OFFSET ?", [limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get bitmap pattern data for visualization
router.get('/bitmap/:bitmap_number/pattern', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const bitmapNumber = req.params.bitmap_number;

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

// Endpoint to get enhanced bitmap data with sat numbers
router.get('/bitmaps/enhanced', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;    const query = `
        SELECT 
            b.*,
            bp.pattern_string
        FROM bitmaps b
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
        ORDER BY b.bitmap_number DESC
        LIMIT ? OFFSET ?
    `;

    db.all(query, [limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }        // Parse pattern data for each row
        const enhancedRows = rows.map(row => {
            if (row.pattern_string) {
                // Convert pattern string to array format
                row.pattern = 'mondrian';
                row.txList = row.pattern_string.split('').map(Number);
                row.squareSizes = row.txList; // Backward compatibility
                delete row.pattern_string; // Remove raw string
            } else {
                row.pattern = null;
                row.txList = [];
                row.squareSizes = [];
            }
            return row;
        });
        
        return res.json(enhancedRows);
    });
});

// Endpoint to search bitmaps with filters and exact counting
router.get('/bitmaps/search', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { 
        page = 1, 
        limit = 20, 
        search = '', 
        sort = 'bitmap_number_desc',
        min_bitmap,
        max_bitmap,
        min_block
    } = req.query;
    
    const offset = (page - 1) * limit;
    
    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    
    // Search conditions
    if (search) {
        whereConditions.push(`(
            b.bitmap_number LIKE ? OR 
            b.inscription_id LIKE ? OR 
            b.address LIKE ? OR 
            CAST(b.block_height AS TEXT) LIKE ?
        )`);
        const searchPattern = `%${search}%`;
        queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    // Filter conditions
    if (min_bitmap) {
        whereConditions.push('b.bitmap_number >= ?');
        queryParams.push(parseInt(min_bitmap));
    }
    
    if (max_bitmap) {
        whereConditions.push('b.bitmap_number <= ?');
        queryParams.push(parseInt(max_bitmap));
    }
    
    if (min_block) {
        whereConditions.push('b.block_height >= ?');
        queryParams.push(parseInt(min_block));
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Build ORDER BY clause
    let orderBy = 'ORDER BY b.bitmap_number DESC';
    switch (sort) {
        case 'bitmap_number_asc':
            orderBy = 'ORDER BY b.bitmap_number ASC';
            break;
        case 'bitmap_number_desc':
            orderBy = 'ORDER BY b.bitmap_number DESC';
            break;
        case 'block_height_asc':
            orderBy = 'ORDER BY b.block_height ASC';
            break;
        case 'block_height_desc':
            orderBy = 'ORDER BY b.block_height DESC';
            break;
        case 'timestamp_asc':
            orderBy = 'ORDER BY b.timestamp ASC';
            break;
        case 'timestamp_desc':
            orderBy = 'ORDER BY b.timestamp DESC';
            break;
    }
    
    // First, get total count
    const countQuery = `
        SELECT COUNT(*) as total
        FROM bitmaps b
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
        ${whereClause}
    `;
    
    db.get(countQuery, queryParams, (err, countResult) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const totalCount = countResult.total;
          // Then get the actual data with patterns
        const dataQuery = `
            SELECT 
                b.*,
                bp.pattern_string
            FROM bitmaps b
            LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
            ${whereClause}
            ${orderBy}
            LIMIT ? OFFSET ?
        `;
        
        const dataParams = [...queryParams, parseInt(limit), offset];
        
        db.all(dataQuery, dataParams, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
              // Parse pattern data for each row
            const enhancedRows = rows.map(row => {
                if (row.pattern_string) {
                    // Convert pattern string to array format
                    row.pattern = 'mondrian';
                    row.txList = row.pattern_string.split('').map(Number);
                    row.squareSizes = row.txList; // Backward compatibility
                    delete row.pattern_string; // Remove raw string
                } else {
                    row.pattern = null;
                    row.txList = [];
                    row.squareSizes = [];
                }
                return row;
            });
            
            const hasMore = (offset + rows.length) < totalCount;
            
            return res.json({
                bitmaps: enhancedRows,
                total: totalCount,
                page: parseInt(page),
                limit: parseInt(limit),
                hasMore: hasMore,
                totalPages: Math.ceil(totalCount / limit)
            });
        });
    });
});

// Endpoint to get bitmap by sat number
router.get('/bitmaps/sat/:sat_number', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const satNumber = req.params.sat_number;

    db.get("SELECT * FROM bitmaps WHERE sat = ?", [satNumber], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Bitmap not found for this sat number" });
        }
        return res.json(row);
    });
});

// Endpoint to get address history for an inscription
router.get('/inscription/:inscription_id/address-history', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.all(`
        SELECT 
            ah.*,
            ov.current_address as verified_current_address,
            ov.confidence_score,
            ov.last_verified
        FROM address_history ah
        LEFT JOIN ownership_verification ov ON ah.inscription_id = ov.inscription_id
        WHERE ah.inscription_id = ?
        ORDER BY ah.block_height DESC
    `, [inscriptionId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get current ownership verification for an inscription
router.get('/inscription/:inscription_id/ownership', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.get(`
        SELECT 
            ov.*,
            b.bitmap_number,
            b.address as bitmap_address
        FROM ownership_verification ov
        JOIN bitmaps b ON ov.inscription_id = b.inscription_id
        WHERE ov.inscription_id = ?
    `, [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "No ownership verification found for this inscription" });
        }
        return res.json(row);
    });
});

// Endpoint to get all bitmaps with verified ownership for an address
router.get('/address/:address/verified-bitmaps', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const address = req.params.address;
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;    const query = `
        SELECT 
            b.*,
            ov.confidence_score,
            ov.last_verified,
            ov.verification_method,
            bp.pattern_string
        FROM bitmaps b
        JOIN ownership_verification ov ON b.inscription_id = ov.inscription_id
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
        WHERE ov.current_address = ?
        ORDER BY b.bitmap_number DESC
        LIMIT ? OFFSET ?
    `;

    db.all(query, [address, limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
          // Parse pattern data for each row
        const enhancedRows = rows.map(row => {
            if (row.pattern_string) {
                // Convert pattern string to array format
                row.pattern = 'mondrian';
                row.txList = row.pattern_string.split('').map(Number);
                delete row.pattern_string; // Remove raw string
            } else {
                row.pattern = null;
                row.txList = [];
            }
            return row;
        });
        
        return res.json(enhancedRows);
    });
});

// ==================== PARCEL ENDPOINTS ====================

// Endpoint to get all parcels with pagination and filtering
router.get('/parcels', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { 
        page = 1, 
        limit = 20, 
        search = '', 
        sort = 'parcel_number_desc',
        bitmap_number,
        min_parcel,
        max_parcel,
        is_valid
    } = req.query;
    
    const offset = (page - 1) * limit;
    
    // Build dynamic WHERE clause
    let whereConditions = [];
    let queryParams = [];
    
    // Search conditions
    if (search) {
        whereConditions.push(`(
            p.parcel_number LIKE ? OR 
            p.bitmap_number LIKE ? OR
            p.inscription_id LIKE ? OR 
            p.address LIKE ? OR 
            CAST(p.block_height AS TEXT) LIKE ?
        )`);
        const searchPattern = `%${search}%`;
        queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    // Filter conditions
    if (bitmap_number) {
        whereConditions.push('p.bitmap_number = ?');
        queryParams.push(parseInt(bitmap_number));
    }
    
    if (min_parcel) {
        whereConditions.push('p.parcel_number >= ?');
        queryParams.push(parseInt(min_parcel));
    }
    
    if (max_parcel) {
        whereConditions.push('p.parcel_number <= ?');
        queryParams.push(parseInt(max_parcel));
    }
    
    if (is_valid !== undefined) {
        whereConditions.push('p.is_valid = ?');
        queryParams.push(is_valid === 'true' ? 1 : 0);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Build ORDER BY clause
    let orderBy = 'ORDER BY p.parcel_number DESC';
    switch (sort) {
        case 'parcel_number_asc':
            orderBy = 'ORDER BY p.parcel_number ASC';
            break;
        case 'parcel_number_desc':
            orderBy = 'ORDER BY p.parcel_number DESC';
            break;
        case 'bitmap_number_asc':
            orderBy = 'ORDER BY p.bitmap_number ASC';
            break;
        case 'bitmap_number_desc':
            orderBy = 'ORDER BY p.bitmap_number DESC';
            break;
        case 'block_height_asc':
            orderBy = 'ORDER BY p.block_height ASC';
            break;
        case 'block_height_desc':
            orderBy = 'ORDER BY p.block_height DESC';
            break;
    }
    
    // First, get total count
    const countQuery = `
        SELECT COUNT(*) as total
        FROM parcels p
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        ${whereClause}
    `;
    
    db.get(countQuery, queryParams, (err, countResult) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const totalCount = countResult.total;
        
        // Then get the actual data
        const dataQuery = `
            SELECT 
                p.*,
                b.bitmap_number as bitmap_bitmap_number,
                b.content as bitmap_content,
                b.address as bitmap_address
            FROM parcels p
            LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
            ${whereClause}
            ${orderBy}
            LIMIT ? OFFSET ?
        `;
        
        const dataParams = [...queryParams, parseInt(limit), offset];
        
        db.all(dataQuery, dataParams, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            const hasMore = (offset + rows.length) < totalCount;
            
            return res.json({
                parcels: rows,
                total: totalCount,
                page: parseInt(page),
                limit: parseInt(limit),
                hasMore: hasMore,
                totalPages: Math.ceil(totalCount / limit)
            });
        });
    });
});

// Endpoint to get parcel by inscription ID
router.get('/parcel/:inscription_id', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.get(`
        SELECT 
            p.*,
            b.bitmap_number as bitmap_bitmap_number,
            b.content as bitmap_content,
            b.address as bitmap_address,
            b.inscription_id as bitmap_inscription_id
        FROM parcels p
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        WHERE p.inscription_id = ?
    `, [inscriptionId], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Parcel not found" });
        }
        return res.json(row);
    });
});

// Endpoint to get parcels for a specific bitmap
router.get('/bitmap/:bitmap_number/parcels', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const bitmapNumber = req.params.bitmap_number;
    const { page = 1, limit = 20, sort = 'parcel_number_asc' } = req.query;
    const offset = (page - 1) * limit;
    
    // Build ORDER BY clause
    let orderBy = 'ORDER BY p.parcel_number ASC';
    switch (sort) {
        case 'parcel_number_asc':
            orderBy = 'ORDER BY p.parcel_number ASC';
            break;
        case 'parcel_number_desc':
            orderBy = 'ORDER BY p.parcel_number DESC';
            break;
        case 'block_height_asc':
            orderBy = 'ORDER BY p.block_height ASC';
            break;
        case 'block_height_desc':
            orderBy = 'ORDER BY p.block_height DESC';
            break;
    }

    db.all(`
        SELECT 
            p.*,
            b.bitmap_number as bitmap_bitmap_number,
            b.content as bitmap_content,
            b.address as bitmap_address
        FROM parcels p
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        WHERE p.bitmap_number = ?
        ${orderBy}
        LIMIT ? OFFSET ?
    `, [bitmapNumber, limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get parcels by address
router.get('/address/:address/parcels', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const address = req.params.address;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate(`
        SELECT 
            p.*,
            b.bitmap_number as bitmap_bitmap_number,
            b.content as bitmap_content,
            b.address as bitmap_address
        FROM parcels p
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        WHERE p.wallet = ? OR p.address = ?
        ORDER BY p.parcel_number DESC
    `, [address, address], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get parcel summary statistics
router.get('/parcels/summary', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    db.get(`
        SELECT 
            COUNT(*) as total_parcels,
            COUNT(DISTINCT bitmap_number) as unique_bitmaps_with_parcels,
            COUNT(CASE WHEN is_valid = 1 THEN 1 END) as valid_parcels,
            COUNT(CASE WHEN is_valid = 0 THEN 1 END) as invalid_parcels,
            MIN(parcel_number) as min_parcel_number,
            MAX(parcel_number) as max_parcel_number,
            MIN(timestamp) as earliest_timestamp,
            MAX(timestamp) as latest_timestamp
        FROM parcels
    `, (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(row);
    });
});

// Endpoint to search parcels by parcel number across all bitmaps
router.get('/parcels/number/:parcel_number', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const parcelNumber = req.params.parcel_number;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate(`
        SELECT 
            p.*,
            b.bitmap_number as bitmap_bitmap_number,
            b.content as bitmap_content,
            b.address as bitmap_address
        FROM parcels p
        LEFT JOIN bitmaps b ON p.bitmap_inscription_id = b.inscription_id
        WHERE p.parcel_number = ?
        ORDER BY p.bitmap_number ASC
    `, [parcelNumber], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// Endpoint to get address history for a parcel
router.get('/parcel/:inscription_id/address-history', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const inscriptionId = req.params.inscription_id;

    db.all(`
        SELECT 
            ah.*,
            ov.current_address as verified_current_address,
            ov.confidence_score,
            ov.last_verified
        FROM address_history ah
        LEFT JOIN ownership_verification ov ON ah.inscription_id = ov.inscription_id
        WHERE ah.inscription_id = ?
        ORDER BY ah.block_height DESC
    `, [inscriptionId], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// ==================== END PARCEL ENDPOINTS ====================

// ==================== BLOCK STATISTICS ENDPOINTS ====================

// Endpoint to get block statistics for a specific block
router.get('/block/:block_height/stats', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const blockHeight = parseInt(req.params.block_height);
    
    if (isNaN(blockHeight) || blockHeight < 0) {
        return res.status(400).json({ error: 'Invalid block height' });
    }
    
    const query = `
        SELECT 
            block_height,
            total_transactions,
            total_inscriptions,
            brc420_deploys,
            brc420_mints,
            bitmaps,
            parcels,
            processed_at
        FROM block_stats
        WHERE block_height = ?
    `;
    
    db.get(query, [blockHeight], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Block statistics not found" });
        }
        return res.json(row);
    });
});

// Endpoint to get block statistics for a range of blocks
router.get('/blocks/stats', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { 
        start_height, 
        end_height, 
        page = 1, 
        limit = 100,
        sort = 'block_height_desc'
    } = req.query;
    
    const offset = (page - 1) * parseInt(limit);
    let whereClause = '';
    let queryParams = [];
    
    if (start_height && end_height) {
        whereClause = 'WHERE block_height BETWEEN ? AND ?';
        queryParams = [parseInt(start_height), parseInt(end_height)];
    } else if (start_height) {
        whereClause = 'WHERE block_height >= ?';
        queryParams = [parseInt(start_height)];
    } else if (end_height) {
        whereClause = 'WHERE block_height <= ?';
        queryParams = [parseInt(end_height)];
    }
    
    let orderBy = 'ORDER BY block_height DESC';
    if (sort === 'block_height_asc') {
        orderBy = 'ORDER BY block_height ASC';
    } else if (sort === 'total_transactions_desc') {
        orderBy = 'ORDER BY total_transactions DESC';
    } else if (sort === 'total_inscriptions_desc') {
        orderBy = 'ORDER BY total_inscriptions DESC';
    }
    
    // First get total count
    const countQuery = `
        SELECT COUNT(*) as total
        FROM block_stats
        ${whereClause}
    `;
    
    db.get(countQuery, queryParams, (err, countResult) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        
        const totalCount = countResult.total;
        
        // Get the actual data
        const dataQuery = `
            SELECT 
                block_height,
                total_transactions,
                total_inscriptions,
                brc420_deploys,
                brc420_mints,
                bitmaps,
                parcels,
                processed_at
            FROM block_stats
            ${whereClause}
            ${orderBy}
            LIMIT ? OFFSET ?
        `;
        
        const dataParams = [...queryParams, parseInt(limit), offset];
        
        db.all(dataQuery, dataParams, (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            
            res.json({
                total: totalCount,
                page: parseInt(page),
                limit: parseInt(limit),
                blocks: rows
            });
        });
    });
});

// Endpoint to get summary statistics across all blocks
router.get('/blocks/summary', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const query = `
        SELECT 
            COUNT(*) as total_blocks_processed,
            MIN(block_height) as first_block,
            MAX(block_height) as latest_block,
            SUM(total_transactions) as total_transactions,
            SUM(total_inscriptions) as total_inscriptions,
            SUM(brc420_deploys) as total_brc420_deploys,
            SUM(brc420_mints) as total_brc420_mints,
            SUM(bitmaps) as total_bitmaps,
            SUM(parcels) as total_parcels,
            AVG(total_transactions) as avg_transactions_per_block,
            AVG(total_inscriptions) as avg_inscriptions_per_block
        FROM block_stats
        WHERE total_transactions > 0
    `;
    
    db.get(query, [], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(row || {});
    });
});

// Endpoint to get blocks with high activity
router.get('/blocks/high-activity', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { metric = 'total_inscriptions', limit = 10 } = req.query;
    
    const validMetrics = ['total_transactions', 'total_inscriptions', 'brc420_deploys', 'brc420_mints', 'bitmaps', 'parcels'];
    if (!validMetrics.includes(metric)) {
        return res.status(400).json({ error: 'Invalid metric. Must be one of: ' + validMetrics.join(', ') });
    }
    
    const query = `
        SELECT 
            block_height,
            total_transactions,
            total_inscriptions,
            brc420_deploys,
            brc420_mints,
            bitmaps,
            parcels,
            processed_at
        FROM block_stats
        WHERE ${metric} > 0
        ORDER BY ${metric} DESC
        LIMIT ?
    `;
    
    db.all(query, [parseInt(limit)], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

// ==================== END BLOCK STATISTICS ENDPOINTS ====================

module.exports = router;
