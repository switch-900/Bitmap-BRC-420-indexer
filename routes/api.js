const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const config = require('../config');
const router = express.Router();

// Create database connection with the same path as server.js
const dbPath = config.DB_PATH || './db/brc420.db';
let db = null;

// Initialize database connection
try {
    db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
            console.error('Routes: Error opening database:', err.message);
            console.log('Routes: API endpoints will return errors until database is available');
        } else {
            console.log('Routes: Connected to SQLite database for API endpoints');
        }
    });
} catch (error) {
    console.error('Routes: Failed to create database connection:', error.message);
}

// Helper function for pagination
function paginate(query, params, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return {
        query: query + ` LIMIT ${limit} OFFSET ${offset}`,
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

// Endpoint to get deploy inscriptions by ID or name
router.get('/deploys', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { id, name, page = 1, limit = 20 } = req.query;
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
          // Parse the pattern data JSON
        try {
            const patternData = JSON.parse(row.pattern_data);
            
            // Handle both old and new pattern data formats
            let responseData = {
                bitmap_number: row.bitmap_number,
                block_height: row.block_height,
                transaction_count: row.transaction_count,
                generated_at: row.generated_at
            };
              // New enhanced format with pattern string and txList
            if (patternData.pattern && patternData.txList) {
                responseData.pattern = patternData.pattern; // String like "554433221"
                responseData.txList = patternData.txList; // Array like [5,5,4,4,3,3,2,2,1]
                responseData.squareSizes = patternData.txList; // Backward compatibility
                responseData.transactions = patternData.transactions; // Detailed transaction data
            } else if (patternData.pattern && patternData.squareSizes) {
                // Handle old squareSizes naming for backward compatibility
                responseData.pattern = patternData.pattern;
                responseData.txList = patternData.squareSizes;
                responseData.squareSizes = patternData.squareSizes;
                responseData.transactions = patternData.transactions;
            } else {
                // Old format - convert to new format for compatibility
                responseData.pattern = null;
                responseData.txList = [];
                responseData.squareSizes = [];
                responseData.transactions = patternData; // Old format was just transaction array
            }
            
            return res.json(responseData);
        } catch (parseErr) {
            return res.status(500).json({ error: 'Invalid pattern data format' });
        }
    });
});

// Endpoint to get enhanced bitmap data with sat numbers
router.get('/bitmaps/enhanced', (req, res) => {
    if (!db) {
        return res.status(500).json({ error: 'Database not available' });
    }
    
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const query = `
        SELECT 
            b.*,
            bp.pattern_data,
            bp.transaction_count,
            bp.generated_at as pattern_generated_at
        FROM bitmaps b
        LEFT JOIN bitmap_patterns bp ON b.bitmap_number = bp.bitmap_number
        ORDER BY b.bitmap_number DESC
        LIMIT ? OFFSET ?
    `;

    db.all(query, [limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
          // Parse pattern data for each row
        const enhancedRows = rows.map(row => {
            if (row.pattern_data) {
                try {
                    const patternData = JSON.parse(row.pattern_data);
                      // Handle both old and new pattern data formats
                    if (patternData.pattern && patternData.txList) {
                        // New enhanced format with txList
                        row.pattern = patternData.pattern; // String like "554433221"
                        row.txList = patternData.txList; // Array like [5,5,4,4,3,3,2,2,1]
                        row.squareSizes = patternData.txList; // Backward compatibility
                        row.transactions = patternData.transactions; // Detailed transaction data
                    } else if (patternData.pattern && patternData.squareSizes) {
                        // Handle old squareSizes naming for backward compatibility
                        row.pattern = patternData.pattern;
                        row.txList = patternData.squareSizes;
                        row.squareSizes = patternData.squareSizes;
                        row.transactions = patternData.transactions;
                    } else {
                        // Old format - just set as transactions for compatibility
                        row.pattern = null;
                        row.txList = [];
                        row.squareSizes = [];
                        row.transactions = patternData;                    }
                    delete row.pattern_data; // Remove raw JSON string
                } catch (parseErr) {
                    row.pattern = null;
                    row.txList = [];
                    row.squareSizes = [];
                    row.transactions = null;
                }
            }
            return row;
        });
        
        return res.json(enhancedRows);
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

module.exports = router;
