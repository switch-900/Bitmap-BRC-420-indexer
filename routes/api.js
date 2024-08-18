const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const router = express.Router();

const db = new sqlite3.Database('./db/brc420.db');

// Helper function for pagination
function paginate(query, params, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return {
        query: query + ` LIMIT ${limit} OFFSET ${offset}`,
        params: params
    };
}

// Endpoint to get deploy inscriptions by ID or name
router.get('/deploys', (req, res) => {
    const { id, name, page = 1, limit = 20 } = req.query;
    let query, params;

    if (id) {
        query = "SELECT * FROM deploys WHERE id = ?";
        params = [id];
    } else if (name) {
        query = "SELECT * FROM deploys WHERE name LIKE ?";
        params = [`%${name}%`]; // Using LIKE to allow partial name matches
    } else {
        query = "SELECT * FROM deploys";
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
    const deployId = req.params.deploy_id;
    const { page = 1, limit = 20 } = req.query;

    const paginatedQuery = paginate("SELECT * FROM mints WHERE deploy_id = ?", [deployId], page, limit);

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

    db.get("SELECT * FROM wallets WHERE inscription_id = ?", [inscriptionId], (err, row) => {
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

    const paginatedQuery = paginate("SELECT * FROM wallets WHERE address = ?", [address], page, limit);

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

// Endpoint to get all mints for a specific deploy mint ID
router.get('/deploy-mint/:deploy_mint_id/mints', (req, res) => {
    const deployMintId = req.params.deploy_mint_id;
    const { page = 1, limit = 20 } = req.query;

    // SQL query to retrieve all mints associated with the given deploy mint ID
    const paginatedQuery = paginate("SELECT * FROM mints WHERE deploy_id = ?", [deployMintId], page, limit);

    db.all(paginatedQuery.query, paginatedQuery.params, (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        return res.json(rows);
    });
});

module.exports = router;
