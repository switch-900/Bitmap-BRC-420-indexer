worker.js: const { parentPort, workerData } = require('worker_threads');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const NodeCache = require('node-cache');
const config = require('./config');
const cache = new NodeCache();
const db = new sqlite3.Database(config.DB_PATH);
const API_URL = config.API_URL;
const API_WALLET_URL = config.API_WALLET_URL;

// Function to get deployer address
async function getDeployerAddress(inscriptionId) {
    const txId = convertInscriptionIdToTxId(inscriptionId);
    try {
        const response = await axios.get(`${API_URL}/output/${txId}`, { headers: { 'Accept': 'application/json' } });
        return response.data.address;
    } catch (error) {
        console.error(`Error getting deployer address for inscription ${inscriptionId}: ${error.message}`);
        return null;
    }
}

// Function to convert Inscription ID to Transaction ID
function convertInscriptionIdToTxId(inscriptionId) {
    return `${inscriptionId.slice(0, -2)}:${inscriptionId.slice(-1)}`;
}

// Function to get deploy data by ID
function getDeployById(deployId) {
    const cachedDeploy = cache.get(deployId);
    if (cachedDeploy) return Promise.resolve(cachedDeploy);

    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                cache.set(deployId, row);
                resolve(row);
            }
        });
    });
}

// Function to validate royalty payment
async function validateRoyaltyPayment(deployInscription, mintAddress) {
    try {
        const txsRes = await axios.get(`${API_WALLET_URL}/address/${mintAddress}/txs`);
        const transactions = txsRes.data;

        let totalRoyaltyPaid = 0;

        for (const tx of transactions) {
            for (const output of tx.vout) {
                if (output.scriptpubkey_address === deployInscription.deployer_address) {
                    totalRoyaltyPaid += output.value;
                }
            }
        }

        const expectedRoyaltySatoshis = Math.floor(parseFloat(deployInscription.price) * 100000000);
        return totalRoyaltyPaid >= expectedRoyaltySatoshis;
    } catch (error) {
        console.error(`Error validating royalty payment for ${mintAddress}: ${error.message}`);
        return false;
    }
}

// Function to validate mint data
async function validateMintData(mintId, deployInscription, mintAddress, transactionId) {
    try {
        const currentMintCount = await getCurrentMintCount(deployInscription.id);
        const maxMints = parseInt(deployInscription.max);

        return mintAddress && transactionId && !isNaN(currentMintCount) && currentMintCount < maxMints;
    } catch (error) {
        console.error(`Error validating mint data for ${mintId}: ${error.message}`);
        return false;
    }
}

// Function to get current mint count for a specific deploy ID
function getCurrentMintCount(deployId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT COUNT(*) as count FROM mints WHERE deploy_id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row.count || 0);
            }
        });
    });
}

// Function to check if bitmap format is valid
function isValidBitmapFormat(content) {
    const regex = /^\d+\.bitmap$/;
    return regex.test(content);
}

// Function to save deploy data
function saveDeploy(deployData) {
    const sql = `INSERT OR REPLACE INTO deploys 
                (id, p, op, name, max, price, deployer_address, block_height, timestamp, source_id, wallet, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    return new Promise((resolve, reject) => {
        db.run(sql, [
            deployData.id,
            deployData.p,
            deployData.op,
            deployData.name,
            deployData.max,
            deployData.price,
            deployData.deployer_address,
            deployData.block_height,
            deployData.timestamp,
            deployData.source_id,
            deployData.wallet,
            deployData.updated_at
        ], function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to save mint data
function saveMint(mintData) {
    const sql = `INSERT OR REPLACE INTO mints 
                (id, deploy_id, source_id, mint_address, transaction_id, block_height, timestamp, wallet, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    return new Promise((resolve, reject) => {
        db.run(sql, [
            mintData.id,
            mintData.deploy_id,
            mintData.source_id,
            mintData.mint_address,
            mintData.transaction_id,
            mintData.block_height,
            mintData.timestamp,
            mintData.wallet,
            mintData.updated_at
        ], function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to save bitmap data
function saveBitmap(bitmapData) {
    const sql = `INSERT OR IGNORE INTO bitmaps 
                (inscription_id, bitmap_number, content, address, timestamp, block_height)
                VALUES (?, ?, ?, ?, ?, ?)`;

    return new Promise((resolve, reject) => {
        db.run(sql, [
            bitmapData.inscription_id,
            bitmapData.bitmap_number,
            bitmapData.content,
            bitmapData.address,
            bitmapData.timestamp,
            bitmapData.block_height
        ], function (err) {
            if (err) {
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to check if bitmap number already exists
function bitmapNumberExists(bitmapNumber) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT COUNT(*) as count FROM bitmaps WHERE bitmap_number = ?`;
        db.get(sql, [bitmapNumber], (err, row) => {
            if (err) {
                reject(err);
            } else {
                resolve(row.count > 0);
            }
        });
    });
}

// Function to process a single inscription
async function processInscription(inscriptionId, blockHeight, counters) {
    try {
        const res = await axios.get(`${API_URL}/content/${inscriptionId}`, { headers: { 'Accept': 'text/plain;charset=utf-8' } });
        let content = res.data;

        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }

        if (content.startsWith('{"p":"brc-420"')) {
            if (content.includes('"op":"deploy"')) {
                const deployData = JSON.parse(content);
                deployData.deployer_address = await getDeployerAddress(inscriptionId);
                deployData.block_height = blockHeight;
                deployData.timestamp = Date.now();
                deployData.source_id = deployData.id;

                await saveDeploy(deployData);
                counters.deploys++;
                return { type: 'deploy' };

            } else if (content.includes('/content/')) { // Corrected from /conent/
                const mintId = JSON.parse(content).id;
                const deployInscription = await getDeployById(mintId);

                if (deployInscription) {
                    const mintAddress = await getDeployerAddress(inscriptionId);
                    const transactionId = convertInscriptionIdToTxId(inscriptionId);

                    if (mintAddress) {
                        const isRoyaltyPaid = await validateRoyaltyPayment(deployInscription, mintAddress);
                        const isMintValid = await validateMintData(mintId, deployInscription, mintAddress, transactionId);

                        if (isRoyaltyPaid && isMintValid) {
                            await saveMint({
                                id: inscriptionId,
                                deploy_id: deployInscription.id,
                                source_id: mintId,
                                mint_address: mintAddress,
                                transaction_id: transactionId,
                                block_height: blockHeight,
                                timestamp: Date.now()
                            });
                            counters.mints++;
                            return { type: 'mint' };
                        }
                    }
                }
            }
        } else if (content.includes('.bitmap')) {
            if (isValidBitmapFormat(content)) {
                const bitmapNumber = parseInt(content.split('.')[0], 10);
                if (!isNaN(bitmapNumber) && bitmapNumber >= 0 && bitmapNumber <= blockHeight) {
                    const address = await getDeployerAddress(inscriptionId);
                    if (address) {
                        const saved = await saveBitmap({
                            inscription_id: inscriptionId,
                            bitmap_number: bitmapNumber,
                            content: content,
                            address: address,
                            timestamp: Date.now(),
                            block_height: blockHeight
                        });
                        if (saved) {
                            counters.bitmaps++;
                            return { type: 'bitmap' };
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        console.error(`Error processing inscription ${inscriptionId}: ${error.message}`);
        return null;
    }
}

// Main function to process a block
async function processBlock(blockHeight) {
    const counters = { mints: 0, deploys: 0, bitmaps: 0 };

    try {
        const response = await axios.get(`${API_URL}/block/${blockHeight}`, {
            headers: { 'Accept': 'application/json' }
        });

        const { inscriptions } = response.data;

        if (Array.isArray(inscriptions) && inscriptions.length > 0) {
            for (const inscriptionId of inscriptions) {
                await processInscription(inscriptionId, blockHeight, counters);
            }
        }

        parentPort.postMessage({ blockHeight, ...counters });
    } catch (error) {
        parentPort.postMessage({ blockHeight, error: error.message });
    }
}

// Start processing the block provided by the workerData
processBlock(workerData.blockHeight);
setgroups.js: const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const { open } = require('sqlite');

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
                mint_count INTEGER DEFAULT 0
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

            -- Drop existing bitmaps table if it exists
            DROP TABLE IF EXISTS bitmaps;

            -- Create new bitmaps table with wallet column
            CREATE TABLE IF NOT EXISTS bitmaps (
                inscription_id TEXT PRIMARY KEY,
                bitmap_number INTEGER,
                content TEXT,
                address TEXT,
                timestamp INTEGER,
                block_height INTEGER,
                wallet TEXT,
                updated_at INTEGER
            );

            -- Create indexes for faster queries
            CREATE INDEX IF NOT EXISTS idx_bitmap_number ON bitmaps(bitmap_number);
            CREATE INDEX IF NOT EXISTS idx_deploy_id ON mints(deploy_id);
            CREATE INDEX IF NOT EXISTS idx_deploy_name ON deploys(name);
            CREATE INDEX IF NOT EXISTS idx_block_height ON blocks(block_height);
            CREATE INDEX IF NOT EXISTS idx_wallet_address ON deploys(wallet);
            CREATE INDEX IF NOT EXISTS idx_wallet_updated_at ON deploys(updated_at);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_address ON mints(wallet);
            CREATE INDEX IF NOT EXISTS idx_mint_wallet_updated_at ON mints(updated_at);
            CREATE INDEX IF NOT EXISTS idx_bitmap_wallet_address ON bitmaps(wallet);
            CREATE INDEX IF NOT EXISTS idx_bitmap_wallet_updated_at ON bitmaps(updated_at);
            CREATE INDEX IF NOT EXISTS idx_error_blocks_retry_at ON error_blocks(retry_at);
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
index.js: 
require('dotenv').config();
const express = require('express');
const os = require('os');
const { Worker } = require('worker_threads');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const config = require('./config');  

const app = express();
const db = new sqlite3.Database(config.DB_PATH);
const PORT = config.PORT || 3000;

const maxConcurrentWorkers = os.cpus().length;  // Number of CPU cores
let currentBlock = config.START_BLOCK;  // Start block from the config
let latestKnownBlock = 0;  // Variable to keep track of the latest known block height

const API_URL = config.API_URL;

// Function to get the latest block height
async function getLatestBlockHeight() {
    try {
        console.log(`Requesting latest block height from: ${API_URL}/r/blockheight`);
        const response = await axios.get(`${API_URL}/r/blockheight`);
        console.log('API Response:', response.data);
        
        // Assuming the response data is the block height directly
        const blockHeight = response.data;
        
        if (typeof blockHeight === 'number') {
            return blockHeight;
        } else {
            console.error('Unexpected response format:', response.data);
            return null;
        }
    } catch (error) {
        console.error('Error fetching the latest block height:', error.message);
        console.error('Error details:', error.response ? error.response.data : 'No response from API');
        return null;
    }
}



// Function to process a block in a worker thread
function processBlockInWorker(blockHeight) {
    return new Promise((resolve, reject) => {
        const worker = new Worker('./worker.js', { workerData: { blockHeight } });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}

// Main processing loop
async function startProcessing() {
    console.log("Starting continuous block processing...");

    // Get the latest known block height
    latestKnownBlock = await getLatestBlockHeight();

    if (!latestKnownBlock) {
        console.error('Failed to retrieve the latest block height. Exiting...');
        process.exit(1);
    }

    while (true) {
        // If we have not reached the latest known block, process the next block
        if (currentBlock <= latestKnownBlock) {
            const activeWorkers = [];

            for (let i = 0; i < maxConcurrentWorkers; i++) {
                if (currentBlock <= latestKnownBlock) {
                    activeWorkers.push(processBlockInWorker(currentBlock));
                    currentBlock++;
                }
            }

            const results = await Promise.all(activeWorkers);

            results.forEach(result => {
                if (result.error) {
                    console.error(`Error processing block ${result.blockHeight}: ${result.error}`);
                } else {
                    console.log(`Block ${result.blockHeight} processed. Deploys: ${result.deploys}, Mints: ${result.mints}, Bitmaps: ${result.bitmaps}`);
                }
            });

            // Check if we have reached the latest known block
            if (currentBlock > latestKnownBlock) {
                console.log(`Reached the latest known block ${latestKnownBlock}. Switching to monitoring mode...`);
            }
        } else {
            // Wait for 60 seconds and then check for new blocks
            console.log('No new blocks to process. Waiting for 60 seconds before checking again...');
            await new Promise(resolve => setTimeout(resolve, 60000));

            // Update the latest known block height
            const newLatestBlock = await getLatestBlockHeight();
            if (newLatestBlock > latestKnownBlock) {
                console.log(`New blocks detected. Latest block height is now ${newLatestBlock}`);
                latestKnownBlock = newLatestBlock;
            }
        }
    }
}

// Setup and start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    startProcessing();
});

useImperativeHandle.js: 
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const NodeCache = require('node-cache');
const cache = new NodeCache();
const db = new sqlite3.Database('./db/brc420.db');
const config = require('./config'); 
const API_URL = config.API_URL;
const API_WALLET_URL = config.API_WALLET_URL;

// Function to get a deploy by ID with caching
function getDeployById(deployId) {
    const cachedDeploy = cache.get(deployId);
    if (cachedDeploy) return Promise.resolve(cachedDeploy);

    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                reject(err);
            } else {
                cache.set(deployId, row);
                resolve(row);
            }
        });
    });
}

// Function to get the deployer address for a given inscription ID
function getDeployerAddress(inscriptionId) {
    const txId = convertInscriptionIdToTxId(inscriptionId);
    return axios.get(`${API_URL}/output/${txId}`, { headers: { 'Accept': 'application/json' } })
        .then(outputRes => outputRes.data.address || null)
        .catch(error => {
            console.error(`Error getting deployer address for inscription ${inscriptionId}: ${error.message}`);
            return null;
        });
}

// Convert Inscription ID to Tx ID
function convertInscriptionIdToTxId(inscriptionId) {
    return `${inscriptionId.slice(0, -2)}:${inscriptionId.slice(-1)}`;
}

// Function to get the mint address for a given inscription ID
function getMintAddress(inscriptionId) {
    const txId = convertInscriptionIdToTxId(inscriptionId);
    return axios.get(`${API_URL}/output/${txId}`, { headers: { 'Accept': 'application/json' } })
        .then(outputRes => outputRes.data.address || null)
        .catch(error => {
            console.error(`Error getting mint address for inscription ${inscriptionId}: ${error.message}`);
            return null;
        });
}

// Function to validate royalty payment
async function validateRoyaltyPayment(deployInscription, mintAddress) {
    try {
        const txsRes = await axios.get(`${API_WALLET_URL}/address/${mintAddress}/txs`);
        const transactions = txsRes.data;

        let totalRoyaltyPaid = 0;

        for (const tx of transactions) {
            for (const output of tx.vout) {
                if (output.scriptpubkey_address === deployInscription.deployer_address) {
                    totalRoyaltyPaid += output.value;
                }
            }
        }

        const expectedRoyaltySatoshis = Math.floor(parseFloat(deployInscription.price) * 100000000);
        return totalRoyaltyPaid >= expectedRoyaltySatoshis;
    } catch (error) {
        console.error(`Error validating royalty payment from ${mintAddress} to ${deployInscription.deployer_address}: ${error.message}`);
        return false;
    }
}

// Function to validate mint data
async function validateMintData(mintId, deployInscription, mintAddress, transactionId) {
    try {
        const currentMintCount = await getCurrentMintCount(deployInscription.id);
        const maxMints = parseInt(deployInscription.max);

        return mintAddress && transactionId && !isNaN(currentMintCount) && currentMintCount < maxMints;
    } catch (error) {
        console.error(`Error validating mint data for mint ID ${mintId}: ${error.message}`);
        return false;
    }
}

// Function to get the current mint count for a specific deploy ID
function getCurrentMintCount(deployId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT COUNT(*) as count FROM mints WHERE deploy_id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                console.error(`Error getting mint count for deploy ID ${deployId}: ${err.message}`);
                reject(err);
            } else {
                resolve(row.count || 0);
            }
        });
    });
}

// Function to save a deploy inscription
function saveDeploy(deployData) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO deploys 
                    (id, p, op, name, max, price, deployer_address, block_height, timestamp, source_id, wallet, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(sql, [
            deployData.id,
            deployData.p,
            deployData.op,
            deployData.name,
            deployData.max,
            deployData.price,
            deployData.deployer_address,
            deployData.block_height,
            deployData.timestamp,
            deployData.source_id,
            deployData.wallet,
            deployData.updated_at
        ], function (err) {
            if (err) {
                console.error(`Error saving deploy: ${err.message}`);
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to save mint data
function saveMint(mintData) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO mints 
                    (id, deploy_id, source_id, mint_address, transaction_id, block_height, timestamp, wallet, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(sql, [
            mintData.id,
            mintData.deploy_id,
            mintData.source_id,
            mintData.mint_address,
            mintData.transaction_id,
            mintData.block_height,
            mintData.timestamp,
            mintData.wallet,
            mintData.updated_at
        ], function (err) {
            if (err) {
                console.error(`Error saving mint: ${err.message}`);
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to check if a bitmap number already exists
function bitmapNumberExists(bitmapNumber) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as count FROM bitmaps WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
            if (err) {
                if (err.message.includes('no such table')) {
                    resolve(false);
                } else {
                    console.error(`Error checking bitmap number existence: ${err.message}`);
                    reject(err);
                }
            } else {
                resolve(row.count > 0);
            }
        });
    });
}

// Function to validate bitmap format
function isValidBitmapFormat(content) {
    const regex = /^\d+\.bitmap$/;
    return regex.test(content);
}

// Function to save bitmap data
function saveBitmap(bitmapData) {
    return new Promise((resolve, reject) => {
        const sql = `INSERT OR REPLACE INTO bitmaps 
                    (inscription_id, bitmap_number, content, address, timestamp, block_height, wallet, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

        db.run(sql, [
            bitmapData.inscription_id,
            bitmapData.bitmap_number,
            bitmapData.content,
            bitmapData.address,
            bitmapData.timestamp,
            bitmapData.block_height,
            bitmapData.wallet,
            bitmapData.updated_at
        ], function (err) {
            if (err) {
                console.error(`Error saving bitmap: ${err.message}`);
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

module.exports = {
    getDeployById,
    getDeployerAddress,
    convertInscriptionIdToTxId,
    getMintAddress,
    validateRoyaltyPayment,
    validateMintData,
    getCurrentMintCount,
    saveDeploy,
    saveMint,
    saveBitmap,
    bitmapNumberExists,
    isValidBitmapFormat
};

///////////////////////////////////////////////////////
API.js: 
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





module.exports = router;
