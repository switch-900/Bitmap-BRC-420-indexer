const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const Joi = require('joi');
const os = require('os');
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
        new winston.transports.File({ filename: 'processing.log' })
    ]
});

// Configuration constants
let API_URL = config.getApiUrl(); // Default to external API
const LOCAL_API_URL = config.getLocalApiUrl();
const START_BLOCK = config.START_BLOCK;
const RETRY_BLOCK_DELAY = config.RETRY_BLOCK_DELAY;

let currentBlock = START_BLOCK;
let db;
let useLocalAPI = false;

// Test if local Ordinals API is available
async function testLocalAPIConnectivity() {
    if (!LOCAL_API_URL) {
        logger.info('No local API URL configured, using external API');
        return false;
    }
    
    try {
        logger.info(`Testing local API connectivity: ${LOCAL_API_URL}`);
        // Test with a simple endpoint that should exist
        const response = await axios.get(`${LOCAL_API_URL}/status`, {
            timeout: 5000,
            headers: { 'Accept': 'application/json' }
        });
        
        if (response.status === 200) {
            logger.info('Local Ordinals API is available, switching to local');
            API_URL = LOCAL_API_URL;
            useLocalAPI = true;
            return true;
        }
    } catch (error) {
        // Try without /api suffix in case it's not needed
        try {
            const baseUrl = LOCAL_API_URL.replace('/api', '');
            logger.info(`Testing local API connectivity without /api suffix: ${baseUrl}`);
            const response = await axios.get(`${baseUrl}/status`, {
                timeout: 5000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (response.status === 200) {
                logger.info('Local Ordinals API available without /api suffix, switching to local');
                API_URL = baseUrl;
                useLocalAPI = true;
                return true;
            }
        } catch (secondError) {
            logger.info(`Local API not available (${error.message}), using external API: ${API_URL}`);
        }
    }
    
    return false;
}

// Initialize database connection for indexer
function initializeIndexerDb() {
    return new Promise((resolve, reject) => {
        db = new sqlite3.Database(config.DB_PATH, (err) => {
            if (err) {
                logger.error('Error opening indexer database:', { message: err.message });
                reject(err);
            } else {
                logger.info('Indexer connected to the BRC-420 database.');
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

// Function to save or update a wallet
function saveOrUpdateWallet(inscriptionId, address, type) {
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

// Function to get mint address
async function getMintAddress(inscriptionId) {
    try {
        const response = await axios.get(`${API_URL}/inscription/${inscriptionId}`, {
            headers: { 'Accept': 'application/json' }
        });
        return response.data.address || null;
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

// Function to validate royalty payment
async function validateRoyaltyPayment(deployInscription, mintAddress) {
    try {
        const transactionId = convertInscriptionIdToTxId(deployInscription.id);
        const response = await axios.get(`${config.API_WALLET_URL}/tx/${transactionId}/vout`, {
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

// Function to process inscription
async function processInscription(inscriptionId, blockHeight) {
    try {
        const res = await axios.get(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });

        let content = res.data;
        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }

        processingLogger.info(`Processing inscription ${inscriptionId}: ${content.substring(0, 100)}...`);

        if (content.startsWith('{"p":"brc-420","op":"deploy"')) {
            const deployData = JSON.parse(content);
            deployData.deployer_address = await getDeployerAddress(inscriptionId);
            deployData.block_height = blockHeight;
            deployData.timestamp = Date.now();
            deployData.source_id = deployData.id;

            await saveDeploy(deployData);
            processingLogger.info(`BRC-420 deploy inscription saved: ${inscriptionId}`);
            return { type: 'deploy' };
            
        } else if (content.startsWith('/content/')) {
            const mintId = content.split('/content/')[1].split('"')[0];
            const deployInscription = await getDeployById(mintId);

            if (deployInscription) {
                const mintAddress = await getMintAddress(inscriptionId);
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
                        processingLogger.info(`BRC-420 mint saved: ${inscriptionId}`);
                        return { type: 'mint' };
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

    try {
        const response = await axios.get(`${API_URL}/block/${blockHeight}`, {
            headers: { 'Accept': 'application/json' },
            timeout: 10000
        });

        const { inscriptions } = response.data;

        if (Array.isArray(inscriptions) && inscriptions.length > 0) {
            processingLogger.info(`Total inscriptions found in block ${blockHeight}: ${inscriptions.length}`);
            
            let mintCount = 0;
            let deployCount = 0;
            let bitmapCount = 0;

            // Process inscriptions sequentially to avoid rate limiting
            for (const inscriptionId of inscriptions) {
                try {
                    const result = await processInscription(inscriptionId, blockHeight);
                    if (result) {
                        if (result.type === 'mint') mintCount++;
                        else if (result.type === 'deploy') deployCount++;
                        else if (result.type === 'bitmap') bitmapCount++;
                    }
                    // Small delay to respect API rate limits
                    await new Promise(resolve => setTimeout(resolve, 100));
                } catch (error) {
                    logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
                }
            }

            processingLogger.info(`Block ${blockHeight} processed. Mints: ${mintCount}, Deploys: ${deployCount}, Bitmaps: ${bitmapCount}`);
        } else {
            processingLogger.info(`No inscriptions found in block ${blockHeight}`);
        }    } catch (error) {
        logger.error(`Error processing block ${blockHeight}:`, { message: error.message });
        
        // If we're using local API and get network error, try switching to external
        if (useLocalAPI && (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
            logger.info('Local API failed, switching to external API for future requests');
            API_URL = config.getApiUrl(); // Switch back to external API
            useLocalAPI = false;
        }
        
        logErrorBlock(blockHeight);
    }
}

// Function to retry failed blocks
async function retryFailedBlocks(currentBlockHeight) {
    const retryBlockHeight = currentBlockHeight - RETRY_BLOCK_DELAY;

    return new Promise((resolve) => {
        db.all("SELECT block_height FROM error_blocks WHERE retry_at <= ?", [retryBlockHeight], async (err, rows) => {
            if (err) {
                logger.error('Error fetching error blocks:', { message: err.message });
                resolve();
                return;
            }

            if (rows && rows.length > 0) {
                for (const row of rows) {
                    try {
                        await processBlock(row.block_height);
                        db.run("DELETE FROM error_blocks WHERE block_height = ?", [row.block_height]);
                        logger.info(`Error block ${row.block_height} successfully retried and deleted.`);
                    } catch (error) {
                        logger.error(`Failed to process error block ${row.block_height}.`, { message: error.message });
                    }
                }
            }
            resolve();
        });
    });
}

// Main indexer processing loop
async function startProcessing() {
    logger.info("Starting Bitcoin inscription indexer...");
    logger.info(`Starting from block: ${currentBlock}`);
    logger.info(`API URL: ${API_URL}`);

    while (true) {
        try {
            processingLogger.info(`Starting to process block ${currentBlock}`);
            await retryFailedBlocks(currentBlock);

            const row = await new Promise((resolve, reject) => {
                db.get("SELECT block_height FROM blocks WHERE block_height = ? AND processed = 1", [currentBlock], (err, row) => {
                    if (err) reject(err);
                    else resolve(row);
                });
            });

            if (!row) {
                await processBlock(currentBlock);
                await new Promise((resolve, reject) => {
                    db.run("INSERT OR REPLACE INTO blocks (block_height, processed) VALUES (?, 1)", [currentBlock], (err) => {
                        if (err) reject(err);
                        else resolve();
                    });
                });
                processingLogger.info(`Block ${currentBlock} marked as processed.`);
            } else {
                processingLogger.info(`Block ${currentBlock} already processed. Skipping.`);
            }

            currentBlock++;
            await new Promise(resolve => setTimeout(resolve, 2000)); // 2 second delay between blocks
        } catch (error) {
            logger.error(`Error processing block ${currentBlock}:`, { message: error.message });
            await new Promise(resolve => setTimeout(resolve, 10000)); // 10 second delay on error
        }
    }
}

// Export the main function
module.exports = {
    async startIndexer() {
        await initializeIndexerDb();
        
        // Test local API connectivity before starting
        await testLocalAPIConnectivity();
        
        await startProcessing();
    }
};
