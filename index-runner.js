const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const Joi = require('joi');
const pLimit = require('p-limit');
const config = require('./config');

// Initialize Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'app.log' })
    ]
});

const processingLogger = winston.createLogger({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: 'processing.log' })
    ]
});

// Configuration constants
let API_URL = config.getApiUrl(); // Default to external API
const START_BLOCK = config.START_BLOCK;
const RETRY_BLOCK_DELAY = config.RETRY_BLOCK_DELAY;

let currentBlock = START_BLOCK;
let db;
let useLocalAPI = false;

// PERFORMANCE OPTIMIZATION: Add concurrency control
const concurrencyLimit = pLimit(config.CONCURRENCY_LIMIT || 5);

// PERFORMANCE OPTIMIZATION: API response cache
class APICache {
    constructor(maxAge = 60000) { // 1 minute cache
        this.cache = new Map();
        this.maxAge = maxAge;
    }
    
    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;
        
        if (Date.now() - item.timestamp > this.maxAge) {
            this.cache.delete(key);
            return null;
        }
        
        return item.data;
    }
    
    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
}

const apiCache = new APICache();

// PERFORMANCE OPTIMIZATION: Cached API functions to reduce redundant calls
async function getDeployerAddressCached(inscriptionId) {
    const cacheKey = `deployer_${inscriptionId}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    try {
        const response = await axios.get(`${API_URL}/inscription/${inscriptionId}`, {
            headers: { 'Accept': 'application/json' }
        });
        const address = response.data.address || null;
        apiCache.set(cacheKey, address);
        return address;
    } catch (error) {
        logger.error(`Error getting deployer address for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

async function getInscriptionContentCached(inscriptionId) {
    const cacheKey = `content_${inscriptionId}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    try {
        const response = await axios.get(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain' },
            responseType: 'text'
        });
        const content = response.data || '';
        apiCache.set(cacheKey, content);
        return content;    } catch (error) {
        logger.error(`Error getting inscription content for ${inscriptionId}:`, { message: error.message });
        return '';
    }
}

async function getInscriptionDetailsCached(inscriptionId) {
    const cacheKey = `details_${inscriptionId}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    try {
        const response = await axios.get(`${API_URL}/inscription/${inscriptionId}`, {
            headers: { 'Accept': 'application/json' }
        });
        const details = response.data || null;
        apiCache.set(cacheKey, details);
        return details;
    } catch (error) {
        logger.error(`Error getting inscription details for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// PERFORMANCE OPTIMIZATION: Batch database operations
class DatabaseBatcher {
    constructor(db) {
        this.db = db;
        this.walletBatch = [];
        this.batchSize = 50; // Process in smaller batches for better memory management
    }
    
    addWallet(inscriptionId, address, type) {
        this.walletBatch.push({ inscriptionId, address, type, timestamp: Date.now() });
        if (this.walletBatch.length >= this.batchSize) {
            return this.flushWallets();
        }
        return Promise.resolve();
    }
    
    async flushWallets() {
        if (this.walletBatch.length === 0) return;
        
        const batch = [...this.walletBatch];
        this.walletBatch = [];
        
        return new Promise((resolve, reject) => {
            this.db.serialize(() => {
                this.db.run("BEGIN TRANSACTION");
                
                const stmt = this.db.prepare("INSERT OR REPLACE INTO wallets (inscription_id, address, type, updated_at) VALUES (?, ?, ?, ?)");
                
                batch.forEach(wallet => {
                    stmt.run([wallet.inscriptionId, wallet.address, wallet.type, wallet.timestamp]);
                });
                
                stmt.finalize();
                
                this.db.run("COMMIT", (err) => {
                    if (err) {
                        logger.error('Error flushing wallet batch:', err);
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            });
        });
    }
    
    async flushAll() {
        await this.flushWallets();
    }
}

let dbBatcher;

// Test if local Ordinals API is available
async function testLocalAPIConnectivity() {
    const endpoints = config.getLocalApiEndpoints();
    
    if (!endpoints || endpoints.length === 0) {
        logger.info('No local API endpoints configured, using external API');
        return false;
    }
    
    logger.info(`Testing ${endpoints.length} local API endpoints for Ordinals service...`);
    
    for (const endpoint of endpoints) {
        try {            logger.info(`🔍 Testing: ${endpoint}`);
            
            // Test with a simple status endpoint first
            try {
                const response = await axios.get(`${endpoint}/status`, {
                    timeout: 5000, // Increased timeout for local node
                    headers: { 'Accept': 'application/json' }
                });
                
                if (response.status === 200) {
                    logger.info(`✅ Found Ordinals API at: ${endpoint} (via /status)`);
                    API_URL = endpoint;
                    useLocalAPI = true;
                    return true;
                }
            } catch (statusError) {
                // /status endpoint might not exist, try actual block endpoint
                logger.debug(`Status endpoint failed for ${endpoint}: ${statusError.message}`);
            }
            
            // Test with actual inscriptions endpoint
            const response = await axios.get(`${endpoint}/inscriptions/block/792435`, {
                timeout: 10000, // Increased timeout for local node
                headers: { 'Accept': 'application/json' }
            });
            
            if (response.status === 200) {
                const count = Array.isArray(response.data) ? response.data.length : 0;
                logger.info(`✅ Found Ordinals API at: ${endpoint} (${count} inscriptions in test block)`);
                API_URL = endpoint;
                useLocalAPI = true;
                return true;
            } else if (response.status === 404) {
                // 404 is fine - means the endpoint exists but no inscriptions in that block
                logger.info(`✅ Found Ordinals API at: ${endpoint} (endpoint exists, no inscriptions in test block)`);
                API_URL = endpoint;
                useLocalAPI = true;
                return true;
            }
            
        } catch (error) {
            logger.debug(`❌ Failed ${endpoint}: ${error.message}`);
            continue;
        }
    }
    
    logger.info('❌ No local Ordinals API found on any endpoint, using external API: https://ordinals.com');
    logger.info('💡 To use a local Ordinals service, ensure an Ordinals app is installed and running on your Umbrel');
    return false;
}

// Test if local Mempool API is available
async function testLocalMempoolAPIConnectivity() {
    const endpoints = config.getMempoolApiEndpoints();
    
    if (!endpoints || endpoints.length === 0) {
        logger.info('No local mempool API endpoints configured, using external API');
        return false;
    }
    
    logger.info(`Testing ${endpoints.length} local mempool API endpoints...`);
    
    for (const endpoint of endpoints) {
        try {
            logger.info(`🔍 Testing mempool API: ${endpoint}`);
            
            // Test with a simple status endpoint first
            try {
                const response = await axios.get(`${endpoint}/blocks/tip/height`, {
                    timeout: 5000,
                    headers: { 'Accept': 'application/json' }
                });
                
                if (response.status === 200 && typeof response.data === 'number') {
                    logger.info(`✅ Found Mempool API at: ${endpoint} (current block: ${response.data})`);
                    // Update the mempool API URL in config for future use
                    config.API_WALLET_URL = endpoint;
                    return true;
                }
            } catch (statusError) {
                logger.debug(`Mempool status endpoint failed for ${endpoint}: ${statusError.message}`);
                continue;
            }
            
        } catch (error) {
            logger.debug(`❌ Failed mempool endpoint ${endpoint}: ${error.message}`);
            continue;
        }
    }
    
    logger.info('❌ No local Mempool API found, using external API: https://mempool.space/api');
    return false;
}

// Initialize database connection for indexer
function initializeIndexerDb() {
    return new Promise((resolve, reject) => {        db = new sqlite3.Database(config.DB_PATH, (err) => {
            if (err) {
                logger.error('Error opening indexer database:', { message: err.message });
                reject(err);
            } else {
                logger.info('Indexer connected to the BRC-420 database.');
                // Initialize database batcher for performance optimization
                dbBatcher = new DatabaseBatcher(db);
                resolve();
            }
        });
    });
}

// Joi schemas for validation
const deploySchema = Joi.object({
    p: Joi.string().valid('brc-420').required(),
    op: Joi.string().valid('deploy').required(),
    id: Joi.string().required(),
    name: Joi.string().required(),
    max: Joi.number().integer().positive().required(),
    price: Joi.number().precision(8).positive().required(),
    deployer_address: Joi.string().required(),
    block_height: Joi.number().integer().positive().required(),
    timestamp: Joi.date().timestamp().required(),
    source_id: Joi.string().required()
});

const mintSchema = Joi.object({
    id: Joi.string().required(),
    deploy_id: Joi.string().required(),
    source_id: Joi.string().required(),
    mint_address: Joi.string().required(),
    transaction_id: Joi.string().required(),
    block_height: Joi.number().integer().positive().required(),
    timestamp: Joi.date().timestamp().required()
});

// Function to save or update a wallet (using batch operations for performance)
function saveOrUpdateWallet(inscriptionId, address, type) {
    if (dbBatcher) {
        return dbBatcher.addWallet(inscriptionId, address, type);
    } else {
        // Fallback to direct database operation if batcher not initialized
        return new Promise((resolve, reject) => {
            const stmt = db.prepare("INSERT OR REPLACE INTO wallets (inscription_id, address, type, updated_at) VALUES (?, ?, ?, ?)");
            stmt.run([inscriptionId, address, type, Date.now()], function(err) {
                if (err) {
                    logger.error(`Error saving/updating wallet ${address} for inscription ${inscriptionId}:`, { message: err.message });
                    reject(err);
                } else {
                    logger.info(`Wallet ${address} for inscription ${inscriptionId} saved/updated.`);
                    resolve();
                }
            });
        });
    }
}

// Function to validate that deployer owns the source inscription
async function validateDeployerOwnership(deployInscription) {    try {
        // Get the source inscription details using cached API call
        const sourceDetails = await getInscriptionDetailsCached(deployInscription.source_id);
        if (!sourceDetails) {
            logger.error(`Could not get source inscription details for ${deployInscription.source_id}`);
            return false;
        }

        const sourceAddress = sourceDetails.address;
        const deployerAddress = deployInscription.deployer_address;

        const isValid = sourceAddress === deployerAddress;
        logger.info(`Deployer ownership validation for ${deployInscription.id}: ${isValid ? 'VALID' : 'INVALID'} (source owner: ${sourceAddress}, deployer: ${deployerAddress})`);
        return isValid;

    } catch (error) {
        logger.error(`Error validating deployer ownership for ${deployInscription.id}:`, { message: error.message });
        return false;
    }
}

// Function to validate that source inscription hasn't been deployed before
async function validateUniqueDeployment(sourceInscriptionId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT id FROM deploys WHERE source_id = ?", [sourceInscriptionId], (err, row) => {
            if (err) {
                logger.error(`Error checking unique deployment for ${sourceInscriptionId}:`, { message: err.message });
                reject(err);
            } else {
                const isUnique = !row;
                logger.info(`Unique deployment validation for ${sourceInscriptionId}: ${isUnique ? 'VALID' : 'INVALID'} (already deployed: ${!!row})`);
                resolve(isUnique);
            }
        });
    });
}

// Function to save deploy data
async function saveDeploy(deployData) {
    return new Promise((resolve, reject) => {
        const { error } = deploySchema.validate(deployData);
        if (error) {
            logger.error(`Deploy validation error for ${deployData.id}:`, { message: error.details[0].message });
            reject(new Error(`Deploy validation failed: ${error.details[0].message}`));
            return;
        }

        db.get("SELECT id FROM deploys WHERE id = ?", [deployData.id], (err, row) => {
            if (err) {
                logger.error(`Error checking if deploy ${deployData.id} exists:`, { message: err.message });
                reject(err);
            } else if (row) {
                logger.info(`Deploy ${deployData.id} already exists in database. Skipping.`);
                resolve();
            } else {
                const stmt = db.prepare("INSERT INTO deploys (id, name, max, price, deployer_address, block_height, timestamp, source_id, wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
                stmt.run([deployData.id, deployData.name, deployData.max, deployData.price, deployData.deployer_address, deployData.block_height, deployData.timestamp, deployData.source_id, deployData.deployer_address], function(err) {
                    if (err) {
                        logger.error(`Error saving deploy ${deployData.id}:`, { message: err.message });
                        reject(err);
                    } else {
                        logger.info(`Deploy ${deployData.id} saved to database.`);
                        saveOrUpdateWallet(deployData.id, deployData.deployer_address, 'deploy');
                        resolve();
                    }
                });
            }
        });
    });
}

// Function to save mint data
async function saveMint(mintData) {
    return new Promise((resolve, reject) => {
        const { error } = mintSchema.validate(mintData);
        if (error) {
            logger.error(`Mint validation error for ${mintData.id}:`, { message: error.details[0].message });
            reject(new Error(`Mint validation failed: ${error.details[0].message}`));
            return;
        }

        db.get("SELECT id FROM mints WHERE id = ?", [mintData.id], (err, row) => {
            if (err) {
                logger.error(`Error checking if mint ${mintData.id} exists:`, { message: err.message });
                reject(err);
            } else if (row) {
                logger.info(`Mint ${mintData.id} already exists in database. Skipping.`);
                resolve();
            } else {
                const stmt = db.prepare("INSERT INTO mints (id, deploy_id, source_id, mint_address, transaction_id, block_height, timestamp, wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
                stmt.run([mintData.id, mintData.deploy_id, mintData.source_id, mintData.mint_address, mintData.transaction_id, mintData.block_height, mintData.timestamp, mintData.mint_address], function(err) {
                    if (err) {
                        logger.error(`Error saving mint ${mintData.id}:`, { message: err.message });
                        reject(err);
                    } else {
                        logger.info(`Mint ${mintData.id} saved to database.`);
                        saveOrUpdateWallet(mintData.id, mintData.mint_address, 'mint');
                        resolve();
                    }
                });
            }
        });
    });
}

// Function to save bitmap data
async function saveBitmap(bitmapData) {
    return new Promise((resolve, reject) => {
        db.get("SELECT bitmap_number FROM bitmaps WHERE bitmap_number = ?", [bitmapData.bitmap_number], (err, row) => {
            if (err) {
                logger.error(`Error checking if bitmap ${bitmapData.bitmap_number} exists:`, { message: err.message });
                reject(err);
            } else if (row) {
                logger.info(`Bitmap ${bitmapData.bitmap_number} already exists. Skipping.`);
                resolve(false);
            } else {
                const stmt = db.prepare("INSERT INTO bitmaps (inscription_id, bitmap_number, content, address, timestamp, block_height, wallet) VALUES (?, ?, ?, ?, ?, ?, ?)");
                stmt.run([bitmapData.inscription_id, bitmapData.bitmap_number, bitmapData.content, bitmapData.address, bitmapData.timestamp, bitmapData.block_height, bitmapData.address], function(err) {
                    if (err) {
                        logger.error(`Error saving bitmap ${bitmapData.bitmap_number}:`, { message: err.message });
                        reject(err);
                    } else {
                        logger.info(`Bitmap ${bitmapData.bitmap_number} saved to database.`);
                        saveOrUpdateWallet(bitmapData.inscription_id, bitmapData.address, 'bitmap');
                        resolve(true);
                    }
                });
            }
        });
    });
}

// Function to log block in error table
function logErrorBlock(blockHeight) {
    const stmt = db.prepare("INSERT OR REPLACE INTO error_blocks (block_height, error_message, retry_count, retry_at) VALUES (?, ?, 0, ?)");
    stmt.run([blockHeight, 'Processing failed', blockHeight + RETRY_BLOCK_DELAY], function(err) {
        if (err) {
            logger.error(`Error logging error block ${blockHeight}:`, { message: err.message });
        } else {
            logger.info(`Block ${blockHeight} logged as error block.`);
        }
    });
}

// Function to get deploy by ID
function getDeployById(deployId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM deploys WHERE source_id = ?", [deployId], (err, row) => {
            if (err) {
                logger.error(`Error fetching deploy ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

// Function to get mint address (using cached API call)
async function getMintAddress(inscriptionId) {
    try {
        const details = await getInscriptionDetailsCached(inscriptionId);
        return details ? details.address : null;
    } catch (error) {
        logger.error(`Error getting mint address for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to get deployer address
async function getDeployerAddress(inscriptionId) {
    try {
        const response = await axios.get(`${API_URL}/inscription/${inscriptionId}`, {
            headers: { 'Accept': 'application/json' }
        });
        return response.data.address || null;
    } catch (error) {
        logger.error(`Error getting deployer address for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to convert inscription ID to transaction ID
function convertInscriptionIdToTxId(inscriptionId) {
    return inscriptionId.split('i')[0];
}

// Function to validate royalty payment for mints (checks the mint transaction, not deploy)
async function validateMintRoyaltyPayment(deployInscription, mintAddress, mintTransactionId) {
    try {
        const response = await axios.get(`${config.getMempoolApiUrl()}/tx/${mintTransactionId}`, {
            headers: { 'Accept': 'application/json' }
        });

        const transaction = response.data;
        const outputs = transaction.vout || [];
        
        // Look for output to deployer address with correct royalty amount
        const royaltyPayment = outputs.find(output => 
            output.scriptpubkey_address === deployInscription.deployer_address && 
            output.value >= deployInscription.price * 100000000 // Convert BTC to satoshis
        );

        const isValidRoyalty = !!royaltyPayment;
        logger.info(`Mint royalty validation for ${mintTransactionId}: ${isValidRoyalty ? 'VALID' : 'INVALID'} (expected: ${deployInscription.price} BTC to ${deployInscription.deployer_address})`);
        return isValidRoyalty;

    } catch (error) {
        logger.error(`Error validating mint royalty payment for ${mintTransactionId}:`, { message: error.message });
        return false;
    }
}

// Function to validate mint content type matches source inscription
async function validateMintContentType(mintInscriptionId, sourceInscriptionId) {
    try {
        // Get both inscriptions' metadata
        const [mintResponse, sourceResponse] = await Promise.all([
            axios.get(`${API_URL}/inscription/${mintInscriptionId}`, {
                headers: { 'Accept': 'application/json' }
            }),
            axios.get(`${API_URL}/inscription/${sourceInscriptionId}`, {
                headers: { 'Accept': 'application/json' }
            })
        ]);

        const mintContentType = mintResponse.data.content_type;
        const sourceContentType = sourceResponse.data.content_type;

        const isValid = mintContentType === sourceContentType;
        logger.info(`Content type validation for mint ${mintInscriptionId}: ${isValid ? 'VALID' : 'INVALID'} (mint: ${mintContentType}, source: ${sourceContentType})`);
        return isValid;

    } catch (error) {
        logger.error(`Error validating content type for mint ${mintInscriptionId}:`, { message: error.message });
        return false;
    }
}

// Function to validate royalty payment
async function validateRoyaltyPayment(deployInscription, mintAddress) {
    try {
        const transactionId = convertInscriptionIdToTxId(deployInscription.id);
        const response = await axios.get(`${config.getMempoolApiUrl()}/tx/${transactionId}/vout`, {
            headers: { 'Accept': 'application/json' }
        });

        const outputs = response.data;
        const royaltyPayment = outputs.find(output => 
            output.scriptpubkey_address === deployInscription.deployer_address && 
            output.value >= deployInscription.price * 100000000
        );

        const isValidRoyalty = !!royaltyPayment;
        logger.info(`Royalty validation for deploy ${deployInscription.id}: ${isValidRoyalty ? 'VALID' : 'INVALID'}`);
        return isValidRoyalty;

    } catch (error) {
        logger.error(`Error validating royalty payment for deploy ${deployInscription.id}:`, { message: error.message });
        return false;
    }
}

// Function to get current mint count
async function getCurrentMintCount(deployId) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as count FROM mints WHERE deploy_id = ?", [deployId], (err, row) => {
            if (err) {
                logger.error(`Error getting mint count for deploy ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row.count);
            }
        });
    });
}

// Function to validate mint data
async function validateMintData(mintId, deployInscription, mintAddress, transactionId) {
    try {
        if (!deployInscription) {
            logger.error(`Deploy inscription not found for mint ID ${mintId}.`);
            return false;
        }

        const currentMintCount = await getCurrentMintCount(deployInscription.id);
        if (currentMintCount >= deployInscription.max) {
            logger.error(`Mint limit exceeded for deploy ${deployInscription.id}. Current: ${currentMintCount}, Max: ${deployInscription.max}`);
            return false;
        }

        logger.info(`Mint validation for ${mintId}: VALID`);
        return true;

    } catch (error) {
        logger.error(`Error validating mint data for ${mintId}:`, { message: error.message });
        return false;
    }
}

// Helper function to validate bitmap format
function isValidBitmapFormat(content) {
    const bitmapRegex = /^\d+\.bitmap$/;
    return bitmapRegex.test(content.trim());
}



// Function to save parcel data with tie-breaker logic
async function saveParcel(parcelData) {
    return new Promise((resolve, reject) => {
        // Check if this exact inscription already exists
        db.get("SELECT inscription_id FROM parcels WHERE inscription_id = ?", [parcelData.inscription_id], (err, row) => {
            if (err) {
                logger.error(`Error checking if parcel ${parcelData.inscription_id} exists:`, { message: err.message });
                reject(err);
            } else if (row) {
                logger.info(`Parcel ${parcelData.inscription_id} already exists. Skipping.`);
                resolve(false);
            } else {
                // Check for duplicate parcel number within the same bitmap
                db.get(`
                    SELECT inscription_id, block_height, timestamp 
                    FROM parcels 
                    WHERE parcel_number = ? AND bitmap_number = ? 
                    ORDER BY block_height ASC, inscription_id ASC 
                    LIMIT 1
                `, [parcelData.parcel_number, parcelData.bitmap_number], (err, existingParcel) => {
                    if (err) {
                        logger.error(`Error checking for duplicate parcel number:`, { message: err.message });
                        reject(err);
                        return;
                    }
                    
                    // If a parcel with this number already exists, apply tie-breaker rules
                    if (existingParcel) {
                        const shouldReplace = 
                            parcelData.block_height < existingParcel.block_height || 
                            (parcelData.block_height === existingParcel.block_height && 
                             parcelData.inscription_id < existingParcel.inscription_id);
                        
                        if (shouldReplace) {
                            // Remove the existing parcel and insert the new one (first wins)
                            db.run("DELETE FROM parcels WHERE inscription_id = ?", [existingParcel.inscription_id], (deleteErr) => {
                                if (deleteErr) {
                                    logger.error(`Error removing superseded parcel ${existingParcel.inscription_id}:`, { message: deleteErr.message });
                                    reject(deleteErr);
                                    return;
                                }
                                
                                logger.info(`Replacing parcel ${existingParcel.inscription_id} with earlier parcel ${parcelData.inscription_id} (tie-breaker applied)`);
                                
                                // Insert the new parcel
                                insertParcelData(parcelData, resolve, reject);
                            });
                        } else {
                            logger.info(`Parcel ${parcelData.inscription_id} loses tie-breaker to existing parcel ${existingParcel.inscription_id} for number ${parcelData.parcel_number}.${parcelData.bitmap_number}`);
                            resolve(false);
                        }
                    } else {
                        // No duplicate, proceed with normal insert
                        insertParcelData(parcelData, resolve, reject);
                    }
                });
            }
        });
    });
}

// Helper function to insert parcel data
function insertParcelData(parcelData, resolve, reject) {
    const stmt = db.prepare("INSERT INTO parcels (inscription_id, parcel_number, bitmap_number, bitmap_inscription_id, content, address, block_height, timestamp, transaction_count, is_valid, wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    stmt.run([
        parcelData.inscription_id, 
        parcelData.parcel_number, 
        parcelData.bitmap_number, 
        parcelData.bitmap_inscription_id, 
        parcelData.content, 
        parcelData.address, 
        parcelData.block_height, 
        parcelData.timestamp, 
        parcelData.transaction_count, 
        parcelData.is_valid,
        parcelData.address
    ], function(err) {
        if (err) {
            logger.error(`Error saving parcel ${parcelData.inscription_id}:`, { message: err.message });
            reject(err);
        } else {
            logger.info(`Parcel ${parcelData.inscription_id} saved to database.`);
            saveOrUpdateWallet(parcelData.inscription_id, parcelData.address, 'parcel');
            resolve(true);
        }
    });
}

// Function to validate parcel format and get bitmap inscription ID
function parseParcelContent(content) {
    const parts = content.trim().split('.');
    if (parts.length !== 3 || parts[2] !== 'bitmap') {
        return null;
    }
    
    const parcelNumber = parseInt(parts[0], 10);
    const bitmapNumber = parseInt(parts[1], 10);
    
    if (isNaN(parcelNumber) || isNaN(bitmapNumber) || parcelNumber < 0 || bitmapNumber < 0) {
        return null;
    }
    
    return { parcelNumber, bitmapNumber };
}

// Function to get bitmap inscription ID from bitmap number
async function getBitmapInscriptionId(bitmapNumber) {
    return new Promise((resolve, reject) => {
        db.get("SELECT inscription_id FROM bitmaps WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
            if (err) {
                logger.error(`Error fetching bitmap inscription ID for bitmap ${bitmapNumber}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row ? row.inscription_id : null);
            }
        });
    });
}

// Function to validate parcel provenance by checking if it's a child of the bitmap
async function validateParcelProvenance(parcelInscriptionId, bitmapInscriptionId) {
    try {
        const response = await axios.get(`${API_URL}/children/${bitmapInscriptionId}`, {
            headers: { 'Accept': 'application/json' }
        });

        // Check if the parcel inscription is in the children list
        const children = response.data.ids || [];
        const isValidChild = children.includes(parcelInscriptionId);
        
        logger.info(`Parcel provenance validation for ${parcelInscriptionId}: ${isValidChild ? 'VALID' : 'INVALID'} (parent: ${bitmapInscriptionId})`);
        return isValidChild;

    } catch (error) {
        logger.error(`Error validating parcel provenance for ${parcelInscriptionId}:`, { message: error.message });
        return false;
    }
}

// Function to get transaction count for a block (for parcel validation)
async function getBlockTransactionCount(blockHeight) {
    try {
        // First check if we have it cached in our database
        const cachedStats = await new Promise((resolve, reject) => {
            db.get("SELECT total_transactions FROM block_stats WHERE block_height = ?", [blockHeight], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (cachedStats) {
            logger.debug(`Using cached transaction count for block ${blockHeight}: ${cachedStats.total_transactions}`);
            return cachedStats.total_transactions;
        }

        // Try multiple Bitcoin APIs to get block info
        const apis = [
            `https://blockstream.info/api/block-height/${blockHeight}`,
            `https://mempool.space/api/block-height/${blockHeight}`,
            `${config.getMempoolApiUrl()}/block-height/${blockHeight}`
        ];

        for (const apiUrl of apis) {
            try {
                // First get block hash
                const hashResponse = await axios.get(apiUrl, {
                    headers: { 'Accept': 'text/plain' },
                    timeout: 5000
                });
                
                const blockHash = hashResponse.data.trim();
                
                // Then get full block info
                const blockInfoUrl = apiUrl.replace(`/block-height/${blockHeight}`, `/block/${blockHash}`);
                const blockResponse = await axios.get(blockInfoUrl, {
                    headers: { 'Accept': 'application/json' },
                    timeout: 5000
                });

                const transactionCount = blockResponse.data.tx_count || blockResponse.data.transaction_count;
                
                if (transactionCount && transactionCount > 0) {
                    logger.info(`Got transaction count for block ${blockHeight}: ${transactionCount} (from ${apiUrl})`);
                    
                    // Cache the result in our database
                    await saveBlockStats(blockHeight, transactionCount, 0, 0, 0, 0, 0);
                    
                    return transactionCount;
                }
            } catch (apiError) {
                logger.debug(`API ${apiUrl} failed: ${apiError.message}`);
                continue;
            }
        }

        logger.warn(`Could not get transaction count for block ${blockHeight} from any API`);
        return null;

    } catch (error) {
        logger.error(`Error getting transaction count for block ${blockHeight}:`, { message: error.message });
        return null;
    }
}

// Function to validate parcel number against block transaction count
function validateParcelNumber(parcelNumber, transactionCount) {
    if (transactionCount === null || transactionCount === undefined) {
        // If we can't get transaction count, we allow the parcel but mark it for later validation
        return true;
    }
    
    return parcelNumber >= 0 && parcelNumber < transactionCount;
}

// Helper function to validate parcel format
function isValidParcelFormat(content) {
    const parcelRegex = /^\d+\.\d+\.bitmap$/;
    return parcelRegex.test(content.trim());
}

// Helper function to log mint detection stats
function logMintDetectionStats(blockHeight, inscriptions) {
    let potentialMints = 0;
    let validFormats = 0;
    let deployInscriptions = 0;
    
    for (const inscriptionId of inscriptions) {
        // This is just for stats, don't actually process
        try {
            // We can't easily check content here without API calls, but we can log the attempt
            processingLogger.debug(`Checking inscription ${inscriptionId} in block ${blockHeight}`);
        } catch (error) {
            // Silent catch for stats
        }
    }
    
    processingLogger.info(`Block ${blockHeight} mint detection stats: ${inscriptions.length} total inscriptions to check`);
}

// Function to save or update block statistics
async function saveBlockStats(blockHeight, totalTransactions, totalInscriptions = 0, deploysCount = 0, mintsCount = 0, bitmapsCount = 0, parcelsCount = 0) {
    return new Promise((resolve, reject) => {
        db.run(`
            INSERT OR REPLACE INTO block_stats 
            (block_height, total_transactions, total_inscriptions, brc420_deploys, brc420_mints, bitmaps, parcels, processed_at) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
            blockHeight, 
            totalTransactions, 
            totalInscriptions, 
            deploysCount, 
            mintsCount, 
            bitmapsCount, 
            parcelsCount, 
            Date.now()
        ], function(err) {
            if (err) {
                logger.error(`Error saving block stats for block ${blockHeight}:`, { message: err.message });
                reject(err);
            } else {
                logger.debug(`Block stats saved for block ${blockHeight}: ${totalTransactions} transactions, ${totalInscriptions} inscriptions`);
                resolve(true);
            }
        });
    });
}

// Function to update block stats incrementally (for adding counts during processing)
async function updateBlockStats(blockHeight, field, increment = 1) {
    return new Promise((resolve, reject) => {
        const sql = `UPDATE block_stats SET ${field} = ${field} + ? WHERE block_height = ?`;
        db.run(sql, [increment, blockHeight], function(err) {
            if (err) {
                logger.error(`Error updating block stats ${field} for block ${blockHeight}:`, { message: err.message });
                reject(err);
            } else {
                resolve(true);
            }
        });
    });
}

// Function to get block statistics
async function getBlockStats(blockHeight) {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM block_stats WHERE block_height = ?", [blockHeight], (err, row) => {
            if (err) reject(err);
            else resolve(row);
        });
    });
}

// Function to process inscription
async function processInscription(inscriptionId, blockHeight) {
    try {
        let content = await getInscriptionContentCached(inscriptionId);
        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }processingLogger.info(`Processing inscription ${inscriptionId}: ${content.substring(0, 100)}...`);        // Check for BRC-420 deploy
        if (content.startsWith('{"p":"brc-420","op":"deploy"')) {
            const deployData = JSON.parse(content);
            deployData.deployer_address = await getDeployerAddressCached(inscriptionId);
            deployData.block_height = blockHeight;
            deployData.timestamp = Date.now();
            deployData.source_id = deployData.id;

            // Validate deploy according to BRC-420 spec
            const isOwnershipValid = await validateDeployerOwnership(deployData);
            const isUniqueDeployment = await validateUniqueDeployment(deployData.source_id);

            if (isOwnershipValid && isUniqueDeployment) {
                await saveDeploy(deployData);
                processingLogger.info(`BRC-420 deploy inscription saved: ${inscriptionId}`);
                return { type: 'deploy' };
            } else {
                processingLogger.info(`BRC-420 deploy validation failed for ${inscriptionId}: ownership=${isOwnershipValid}, unique=${isUniqueDeployment}`);
            }        } else if (content.trim().startsWith('/content/')) {
            // BRC-420 mint format: /content/<INSCRIPTION_ID>
            const trimmedContent = content.trim();
            processingLogger.info(`Potential BRC-420 mint detected: ${inscriptionId} -> ${trimmedContent}`);
            
            // More flexible regex to match inscription ID format: 64 hex chars + 'i' + numbers
            const mintMatch = trimmedContent.match(/^\/content\/([a-f0-9]{64}i\d+)$/);
            
            if (mintMatch) {
                const sourceInscriptionId = mintMatch[1]; // Extract the inscription ID
                processingLogger.info(`Valid BRC-420 mint format detected: ${inscriptionId} -> source: ${sourceInscriptionId}`);
                
                const deployInscription = await getDeployById(sourceInscriptionId);

                if (deployInscription) {
                    processingLogger.info(`Found deploy for mint ${inscriptionId}: ${deployInscription.id}`);
                    const mintAddress = await getMintAddress(inscriptionId);
                    const transactionId = convertInscriptionIdToTxId(inscriptionId);

                    if (mintAddress) {
                        processingLogger.info(`Validating mint ${inscriptionId}: address=${mintAddress}, tx=${transactionId}`);
                        const isRoyaltyPaid = await validateMintRoyaltyPayment(deployInscription, mintAddress, transactionId);
                        const isMintValid = await validateMintData(sourceInscriptionId, deployInscription, mintAddress, transactionId);
                        const isContentTypeValid = await validateMintContentType(inscriptionId, sourceInscriptionId);

                        if (isRoyaltyPaid && isMintValid && isContentTypeValid) {
                            await saveMint({
                                id: inscriptionId,
                                deploy_id: deployInscription.id,
                                source_id: sourceInscriptionId,
                                mint_address: mintAddress,
                                transaction_id: transactionId,
                                block_height: blockHeight,
                                timestamp: Date.now()
                            });
                            processingLogger.info(`BRC-420 mint saved: ${inscriptionId}`);
                            return { type: 'mint' };
                        } else {
                            processingLogger.info(`BRC-420 mint validation failed for ${inscriptionId}: royalty=${isRoyaltyPaid}, valid=${isMintValid}, contentType=${isContentTypeValid}`);
                        }
                    } else {
                        processingLogger.info(`Could not get mint address for ${inscriptionId}`);
                    }
                } else {
                    processingLogger.debug(`No deploy found for source inscription ${sourceInscriptionId}`);
                }
            } else {
                // Log potential mints that don't match the exact pattern
                processingLogger.debug(`Content starts with /content/ but doesn't match BRC-420 pattern: ${inscriptionId} -> ${trimmedContent}`);
            }        } else if (content.includes('.bitmap')) {
            // Check for parcel format first (more specific than bitmap format)
            if (isValidParcelFormat(content)) {
                const parcelInfo = parseParcelContent(content);
                if (parcelInfo) {
                    processingLogger.info(`Potential parcel detected: ${inscriptionId} -> ${content.trim()}`);
                    
                    // Get the bitmap inscription ID from our database
                    const bitmapInscriptionId = await getBitmapInscriptionId(parcelInfo.bitmapNumber);
                    
                    if (bitmapInscriptionId) {
                        processingLogger.info(`Found bitmap inscription for parcel ${inscriptionId}: ${bitmapInscriptionId}`);
                          // Validate provenance by checking parent-child relationship
                        const isValidProvenance = await validateParcelProvenance(inscriptionId, bitmapInscriptionId);
                        
                        if (isValidProvenance) {
                            const address = await getDeployerAddressCached(inscriptionId);
                            // Get transaction count for the CURRENT block (where parcel is inscribed)
                            const transactionCount = await getBlockTransactionCount(blockHeight);
                            const isValidNumber = validateParcelNumber(parcelInfo.parcelNumber, transactionCount);
                            
                            if (address && isValidNumber) {
                                const saved = await saveParcel({
                                    inscription_id: inscriptionId,
                                    parcel_number: parcelInfo.parcelNumber,
                                    bitmap_number: parcelInfo.bitmapNumber,
                                    bitmap_inscription_id: bitmapInscriptionId,
                                    content: content.trim(),
                                    address: address,
                                    block_height: blockHeight,
                                    timestamp: Date.now(),
                                    transaction_count: transactionCount,
                                    is_valid: 1
                                });
                                
                                if (saved) {
                                    processingLogger.info(`Valid parcel saved: ${inscriptionId}`);
                                    return { type: 'parcel' };
                                }
                            } else {
                                processingLogger.info(`Parcel validation failed for ${inscriptionId}: address=${!!address}, validNumber=${isValidNumber}`);
                            }
                        } else {
                            processingLogger.info(`Parcel provenance validation failed for ${inscriptionId}: not a child of bitmap ${bitmapInscriptionId}`);
                        }
                    } else {
                        processingLogger.debug(`No bitmap found for parcel ${inscriptionId} with bitmap number ${parcelInfo.bitmapNumber}`);
                    }
                }
            }
            // Check for regular bitmap format
            else if (isValidBitmapFormat(content)) {
                const bitmapNumber = parseInt(content.split('.')[0], 10);
                if (!isNaN(bitmapNumber) && bitmapNumber >= 0 && bitmapNumber <= blockHeight) {
                    const address = await getDeployerAddressCached(inscriptionId);
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
                            processingLogger.info(`Bitmap saved: ${inscriptionId}`);
                            return { type: 'bitmap' };
                        }
                    }
                }
            }
        }

        return null;
    } catch (error) {
        logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to process a block
async function processBlock(blockHeight) {
    processingLogger.info(`Processing block: ${blockHeight}`);
    try {        const response = await axios.get(`${API_URL}/inscriptions/block/${blockHeight}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000
        });

        const responseData = response.data;
        
        // Handle both array format (old API) and object format (new API with pagination)
        const inscriptions = Array.isArray(responseData) ? responseData : (responseData.ids || []);        if (Array.isArray(inscriptions) && inscriptions.length > 0) {
            processingLogger.info(`Total inscriptions found in block ${blockHeight}: ${inscriptions.length}`);
            
            let mintCount = 0;
            let deployCount = 0;
            let bitmapCount = 0;
            let parcelCount = 0;
            
            // Get transaction count for this block
            const transactionCount = await getBlockTransactionCount(blockHeight);
            
            // Log mint detection stats
            logMintDetectionStats(blockHeight, inscriptions);
              // PERFORMANCE IMPROVEMENT: Process inscriptions concurrently with rate limiting
            const results = await Promise.allSettled(
                inscriptions.map(inscriptionId => 
                    concurrencyLimit(() => processInscription(inscriptionId, blockHeight))
                )
            );
            
            // Count results
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    if (result.value.type === 'mint') mintCount++;
                    else if (result.value.type === 'deploy') deployCount++;
                    else if (result.value.type === 'bitmap') bitmapCount++;
                    else if (result.value.type === 'parcel') parcelCount++;
                } else if (result.status === 'rejected') {
                    logger.error(`Error processing inscription:`, { message: result.reason?.message || result.reason });
                }
            });
            
            // Save comprehensive block statistics
            await saveBlockStats(
                blockHeight, 
                transactionCount || 0, 
                inscriptions.length, 
                deployCount, 
                mintCount, 
                bitmapCount, 
                parcelCount
            );
            
            processingLogger.info(`Block ${blockHeight} processed. Transactions: ${transactionCount || 'Unknown'}, Inscriptions: ${inscriptions.length}, Mints: ${mintCount}, Deploys: ${deployCount}, Bitmaps: ${bitmapCount}, Parcels: ${parcelCount}`);
        } else {
            // Even if no inscriptions, save block stats with transaction count
            const transactionCount = await getBlockTransactionCount(blockHeight);
            await saveBlockStats(blockHeight, transactionCount || 0, 0, 0, 0, 0, 0);
            processingLogger.info(`No inscriptions found in block ${blockHeight}. Transactions: ${transactionCount || 'Unknown'}`);
        }
    } catch (error) {
        logger.error(`Error processing block ${blockHeight}:`, { message: error.message });
        
        // If we're using local API and get network error, try switching to external
        if (useLocalAPI && (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
            logger.info('Local API failed, switching to external API for future requests');
            API_URL = config.getApiUrl(); // Switch back to external API
            useLocalAPI = false;
        }        
        logErrorBlock(blockHeight);
    }
    
    // PERFORMANCE OPTIMIZATION: Flush any remaining batched operations
    if (dbBatcher) {
        await dbBatcher.flushAll();
    }
}

// Function to retry failed blocks
async function retryFailedBlocks(currentBlockHeight) {
    const retryBlockHeight = currentBlockHeight - RETRY_BLOCK_DELAY;

    try {
        const rows = await new Promise((resolve, reject) => {
            db.all("SELECT block_height FROM error_blocks WHERE retry_at <= ?", [retryBlockHeight], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (rows && rows.length > 0) {
            logger.info(`Retrying ${rows.length} failed blocks before processing block ${currentBlockHeight}`);
            for (const row of rows) {
                try {
                    logger.info(`Retrying failed block ${row.block_height}`);
                    await processBlock(row.block_height);
                    
                    // Delete the error block on successful retry
                    await new Promise((resolve, reject) => {
                        db.run("DELETE FROM error_blocks WHERE block_height = ?", [row.block_height], (err) => {
                            if (err) reject(err);
                            else resolve();
                        });
                    });
                    
                    logger.info(`Error block ${row.block_height} successfully retried and deleted.`);
                } catch (error) {
                    logger.error(`Failed to process error block ${row.block_height}.`, { message: error.message });
                }
            }
        }
    } catch (error) {
        logger.error('Error fetching error blocks:', { message: error.message });
    }
}

// Main indexer processing loop
async function startProcessing() {
    logger.info("Starting Bitcoin inscription indexer...");
    logger.info(`Starting from block: ${currentBlock}`);
    logger.info(`API URL: ${API_URL}`);

    // Log Umbrel environment variables for debugging
    const umbrelVars = {
        APP_BITCOIN_NODE_IP: process.env.APP_BITCOIN_NODE_IP,
        APP_ORDINALS_NODE_IP: process.env.APP_ORDINALS_NODE_IP,
        DEVICE_HOSTNAME: process.env.DEVICE_HOSTNAME,
        DEVICE_DOMAIN_NAME: process.env.DEVICE_DOMAIN_NAME,
        ORD_API_URL: process.env.ORD_API_URL
    };    logger.info('🔍 Umbrel environment variables:', umbrelVars);

    logger.info('🔄 Starting main processing loop...');
    logger.info(`📊 Current block to process: ${currentBlock}`);
    logger.info(`💾 Database connection status: ${db ? 'Connected' : 'Not connected'}`);

    while (true) {
        try {
            processingLogger.info(`Starting to process block ${currentBlock}`);
            await retryFailedBlocks(currentBlock);

            const row = await new Promise((resolve, reject) => {
                db.get("SELECT block_height FROM blocks WHERE block_height = ? AND processed = 1", [currentBlock], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });            if (!row) {
                await processAndTrackBlock(currentBlock);
                await new Promise((resolve, reject) => {
                    db.run("INSERT OR REPLACE INTO blocks (block_height, processed) VALUES (?, 1)", [currentBlock], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                processingLogger.info(`Block ${currentBlock} marked as processed.`);
            } else {
                processingLogger.info(`Block ${currentBlock} already processed. Skipping.`);
            }currentBlock++;
            // No delay between blocks for local node - process as fast as possible
        } catch (error) {
            logger.error(`Error processing block ${currentBlock}:`, { message: error.message });
            await new Promise(resolve => setTimeout(resolve, 1000)); // Minimal 1 second delay on error
        }
    }
}

// Function to check and update inscription ownership
async function checkAndUpdateInscriptionOwnership(inscriptionId, blockHeight) {
    try {
        // Get current address from cached API call
        const inscriptionDetails = await getInscriptionDetailsCached(inscriptionId);
        if (!inscriptionDetails) {
            return false;
        }
        
        const currentAddress = inscriptionDetails.address;
        if (!currentAddress) {
            return false;
        }

        // Check if we have this inscription in our database
        const dbResult = await new Promise((resolve, reject) => {
            db.get(`
                SELECT inscription_id, address as old_address, type 
                FROM wallets 
                WHERE inscription_id = ?
            `, [inscriptionId], (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

        if (dbResult && dbResult.old_address !== currentAddress) {
            // Address has changed - this is a transfer!
            processingLogger.info(`Transfer detected for ${inscriptionId}: ${dbResult.old_address} -> ${currentAddress}`);
            
            // Update the wallet address
            await new Promise((resolve, reject) => {
                const stmt = db.prepare("UPDATE wallets SET address = ?, updated_at = ? WHERE inscription_id = ?");
                stmt.run([currentAddress, Date.now(), inscriptionId], function(err) {
                    if (err) reject(err);
                    else resolve();
                });
            });

            // Update mint table if this is a mint
            if (dbResult.type === 'mint') {
                await new Promise((resolve, reject) => {
                    const stmt = db.prepare("UPDATE mints SET wallet = ? WHERE id = ?");
                    stmt.run([currentAddress, inscriptionId], function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            // Update deploy table if this is a deploy (though deploys shouldn't transfer for royalty purposes)
            if (dbResult.type === 'deploy') {
                await new Promise((resolve, reject) => {
                    const stmt = db.prepare("UPDATE deploys SET wallet = ? WHERE id = ?");
                    stmt.run([currentAddress, inscriptionId], function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }            // Update parcel table if this is a parcel
            if (dbResult.type === 'parcel') {
                await new Promise((resolve, reject) => {
                    const stmt = db.prepare("UPDATE parcels SET wallet = ? WHERE inscription_id = ?");
                    stmt.run([currentAddress, inscriptionId], function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
                });
            }

            // Log the transfer in address history (if the table exists)
            try {
                await new Promise((resolve, reject) => {
                    const stmt = db.prepare(`
                        INSERT INTO address_history 
                        (inscription_id, old_address, new_address, block_height, timestamp, verification_status) 
                        VALUES (?, ?, ?, ?, ?, ?)
                    `);
                    stmt.run([
                        inscriptionId, 
                        dbResult.old_address, 
                        currentAddress, 
                        blockHeight, 
                        Date.now(), 
                        'verified'
                    ], function(err) {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                processingLogger.info(`Transfer history logged for ${inscriptionId}`);
            } catch (historyError) {
                // Address history table might not exist, that's okay
                processingLogger.debug(`Could not log transfer history for ${inscriptionId}: ${historyError.message}`);
            }

            return true;
        }

        return false;
    } catch (error) {
        logger.error(`Error checking ownership for ${inscriptionId}:`, { message: error.message });
        return false;
    }
}

// Function to track transfers for all known inscriptions in a block
async function trackInscriptionTransfers(blockHeight) {
    try {
        // Get all inscriptions in the block
        const response = await axios.get(`${API_URL}/inscriptions/block/${blockHeight}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000
        });

        const inscriptions = response.data || [];
        
        processingLogger.info(`Tracking transfers for ${inscriptions.length} inscriptions in block ${blockHeight}`);
        
        for (const inscription of inscriptions) {
            const inscriptionId = inscription.id;
            
            // Check and update ownership
            await checkAndUpdateInscriptionOwnership(inscriptionId, blockHeight);
        }
    } catch (error) {
        logger.error(`Error tracking inscription transfers in block ${blockHeight}:`, { message: error.message });
    }
}

// Function to track transfers for only our known inscriptions (more efficient)
async function trackKnownInscriptionTransfers(blockHeight) {
    try {        // Get all our known inscriptions from the database
        const knownInscriptions = await new Promise((resolve, reject) => {
            db.all(`
                SELECT inscription_id, address, type FROM wallets 
                UNION 
                SELECT id as inscription_id, wallet as address, 'mint' as type FROM mints
                UNION
                SELECT id as inscription_id, wallet as address, 'deploy' as type FROM deploys
                UNION
                SELECT inscription_id, wallet as address, 'bitmap' as type FROM bitmaps
                UNION
                SELECT inscription_id, wallet as address, 'parcel' as type FROM parcels
            `, (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });

        if (knownInscriptions.length === 0) {
            processingLogger.debug(`No known inscriptions to track transfers for in block ${blockHeight}`);
            return;
        }        processingLogger.info(`Checking ${knownInscriptions.length} known inscriptions for transfers in block ${blockHeight}`);
        
        // PERFORMANCE OPTIMIZATION: Process transfer checks concurrently
        const transferResults = await Promise.allSettled(
            knownInscriptions.map(inscription => 
                concurrencyLimit(() => checkAndUpdateInscriptionOwnership(inscription.inscription_id, blockHeight))
            )
        );
        
        let transferCount = 0;
        transferResults.forEach(result => {
            if (result.status === 'fulfilled' && result.value) {
                transferCount++;
            } else if (result.status === 'rejected') {
                logger.error(`Error checking inscription transfer:`, { message: result.reason?.message || result.reason });
            }
        });

        if (transferCount > 0) {
            processingLogger.info(`Detected ${transferCount} transfers in block ${blockHeight}`);
        }
    } catch (error) {
        logger.error(`Error tracking known inscription transfers in block ${blockHeight}:`, { message: error.message });
    }
}

// Function to process and track a block
async function processAndTrackBlock(blockHeight) {
    await processBlock(blockHeight);
    await trackKnownInscriptionTransfers(blockHeight);
}

// Export the main function
module.exports = {
    async startIndexer() {
        await initializeIndexerDb();
        
        // Test local API connectivity before starting
        await testLocalAPIConnectivity();
        await testLocalMempoolAPIConnectivity();
        
        await startProcessing();
    }
};
