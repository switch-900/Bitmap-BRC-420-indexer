import axios from 'axios';
import sqlite3 from 'sqlite3';
import express from 'express';
import routes from './routes/index.mjs';
import winston from 'winston';
import Joi from 'joi';
import { config } from './config.mjs';
import cors from 'cors';
import PQueue from 'p-queue';

const app = express();

app.use(cors());

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

// Initialize the database
const db = new sqlite3.Database(config.DB_PATH, (err) => {
    if (err) {
        logger.error('Error opening database:', { message: err.message });
    } else {
        logger.info('Connected to the BRC-420 database.');
    }
});

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

const API_URL = config.API_URL;
const RETRY_DELAY_MS = config.RETRY_DELAY;
const PORT = config.PORT;
let currentBlock = config.START_BLOCK;
let cachedLatestBlockHeight = null;
const MAX_RETRIES = config.MAX_RETRIES;

// Utility function for Axios with retry logic
async function axiosWithRetry(config, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios(config);
        } catch (error) {
            if (i === retries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
        }
    }
}

// Function to retrieve and cache the latest block height
async function getAndCacheLatestBlockHeight() {
    try {
        const response = await axios.get(`${API_URL}/r/blockheight`);
        
        if (typeof response.data === 'string') {
            cachedLatestBlockHeight = parseInt(response.data.trim(), 10);
        } else {
            cachedLatestBlockHeight = parseInt(response.data, 10);
        }
        
        logger.info(`Latest block height cached: ${cachedLatestBlockHeight}`);
    } catch (error) {
        logger.error('Error retrieving latest block height:', { message: error.message });
        throw error;
    }
}

// Function to check if we've reached the latest block
async function checkIfUpToDate() {
    if (currentBlock >= cachedLatestBlockHeight) {
        await getAndCacheLatestBlockHeight();  // Update the cached latest block height
        if (currentBlock >= cachedLatestBlockHeight) {
            logger.info("Up to date with the blockchain. Switching to periodic checking.");
            return true;  // We are up to date
        }
    }
    return false;
}

async function validateDeployData(deployData) {
    const { error } = deploySchema.validate(deployData);
    if (error) {
        logger.error('Deploy data validation failed:', { message: error.details });
        return false;
    }
    logger.info('Deploy data validation successful.');
    return true;
}

// Function to check if the API is available
async function isApiAvailable() {
    try {
        // Assuming this endpoint is used to get the latest block height
        const response = await axios.get(`${API_URL}/r/blockheight`);
        
        // Check if the response contains the block height and it's a valid number
        const latestBlockHeight = parseInt(response.data.trim(), 10);
        if (!isNaN(latestBlockHeight)) {
            logger.info(`API is available. Latest block height: ${latestBlockHeight}`);
            return true;
        } else {
            logger.error('API health check failed: Invalid block height returned.');
            return false;
        }
    } catch (error) {
        logger.error('API health check failed:', { message: error.message });
        return false;
    }
}


// Function to pause processing until the API is available
async function waitForApiRecovery() {
    let apiAvailable = false;
    let retryDelay = RETRY_DELAY_MS;

    while (!apiAvailable) {
        logger.info('Checking if API is available...');
        apiAvailable = await isApiAvailable();

        if (!apiAvailable) {
            logger.info('API still unavailable. Retrying...');
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            retryDelay *= 2;
            if (retryDelay > 60000) {
                retryDelay = 60000;  // Cap the retry delay at 60 seconds
            }
        }
    }

    logger.info('API is now available. Resuming processing.');
}


// Function to save or update a wallet with Winston logging
function saveOrUpdateWallet(inscriptionId, address, type) {
    const sqlInsert = `INSERT INTO wallets (inscription_id, address, type, updated_at)
                       VALUES (?, ?, ?, ?)
                       ON CONFLICT(inscription_id, address) 
                       DO UPDATE SET type = excluded.type, updated_at = excluded.updated_at`; 
    const now = Date.now();
    
    db.run(sqlInsert, [inscriptionId, address, type, now], (err) => {
        if (err) {
            logger.error(`Error saving wallet for inscription ${inscriptionId}:`, { message: err.message });
        } else {
            logger.info(`Wallet saved/updated for inscription ${inscriptionId}, type ${type}`);
        }
    });
}

// Function to save mint inscription with Winston logging
function saveMint(mintData) {
    const { error } = mintSchema.validate(mintData);
    if (error) {
        logger.error('Invalid mint data:', { message: error.details });
        return;
    }

    const sql = `INSERT OR IGNORE INTO mints 
                (id, deploy_id, source_id, mint_address, transaction_id, block_height, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?)`;

    db.run(sql, [
      mintData.id, mintData.deploy_id, mintData.source_id, mintData.mint_address,
      mintData.transaction_id, mintData.block_height, mintData.timestamp
    ], (err) => {
      if (err) {
        logger.error('Error saving mint:', { message: err.message });
      } else {
        logger.info(`Mint saved successfully:`, { mintData });
        saveOrUpdateWallet(mintData.id, mintData.mint_address, 'mint');
      }
    });
}

// Function to log block in error table with Winston logging
function logErrorBlock(blockHeight) {
    const sql = `INSERT OR REPLACE INTO error_blocks (block_height, retry_at)
               VALUES (?, ?)`;
    const retryAtBlock = blockHeight + config.RETRY_BLOCK_DELAY;

    db.run(sql, [blockHeight, retryAtBlock], (err) => {
        if (err) {
            logger.error('Error logging error block:', { message: err.message });
        } else {
            logger.info(`Block ${blockHeight} logged for retry after ${config.RETRY_BLOCK_DELAY} blocks.`);
        }
    });
}

// Function to retry failed blocks with Winston logging
async function retryFailedBlocks(currentBlockHeight) {
    const retryBlockHeight = currentBlockHeight - config.RETRY_BLOCK_DELAY;

    db.all("SELECT block_height FROM error_blocks WHERE retry_at <= ?", [retryBlockHeight], async (err, rows) => {
        if (err) {
            logger.error('Error fetching error blocks:', { message: err.message });
            return;
        }

        if (rows && rows.length > 0) {
            for (const row of rows) {
                await processBlock(row.block_height);
                db.run("DELETE FROM error_blocks WHERE block_height = ?", [row.block_height], (deleteErr) => {
                    if (deleteErr) {
                        logger.error(`Error deleting error block ${row.block_height}:`, { message: deleteErr.message });
                    } else {
                        logger.info(`Error block ${row.block_height} successfully retried and deleted.`);
                    }
                });
            }
        }
    });
}

// Function to save deploy inscription with Joi validation and Winston logging
async function saveDeploy(deployData) {
    const { error } = deploySchema.validate(deployData);
    if (error) {
        logger.error('Invalid deploy data:', { message: error.details });
        return;
    }

    const sql = `INSERT OR IGNORE INTO deploys 
                (id, source_id, name, max, price, deployer_address, block_height, timestamp)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
    return new Promise((resolve, reject) => {
        db.run(sql, [
            deployData.id, deployData.source_id, deployData.name, deployData.max,
            deployData.price, deployData.deployer_address, deployData.block_height, deployData.timestamp
        ], function(err) {
            if (err) {
                logger.error('Error saving deploy:', { message: err.message });
                reject(err);
            } else {
                saveOrUpdateWallet(deployData.id, deployData.deployer_address, 'deploy');
                logger.info('Valid deploy saved:', { deployData });
                resolve();
            }
        });
    });
}

// Function to retrieve a deploy inscription by its ID from the database with Winston logging
async function getDeployById(deployId) {
    const cacheKey = `deploy:${deployId}`;
    const cachedDeploy = getFromCache(cacheKey);

    if (cachedDeploy) {
        logger.info(`Cache hit: Deploy found for ID ${deployId}:`, { deploy: cachedDeploy });
        return cachedDeploy;
    }

    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                logger.error(`Error retrieving deploy by ID ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                if (row) {
                    logger.info(`Deploy found for ID ${deployId}:`, { deploy: row });
                    setInCache(cacheKey, row); // Cache the result
                } else {
                    logger.info(`No deploy found for ID ${deployId}`);
                }
                resolve(row);
            }
        });
    });
}

// Function to get mint address with Winston logging
async function getMintAddress(inscriptionId) {
    try {
        const txId = convertInscriptionIdToTxId(inscriptionId);
        logger.info(`Fetching output for transaction ID: ${txId}`);
        const outputRes = await axiosWithRetry({
            url: `${API_URL}/output/${txId}`,
            method: 'get',
            headers: { 'Accept': 'application/json' }
        });
        logger.info(`Output API response:`, { data: outputRes.data });
        if (outputRes.data && outputRes.data.address) {
            logger.info(`Mint address for ${inscriptionId}: ${outputRes.data.address}`);
            return outputRes.data.address;
        } else {
            logger.error(`No address found in output for inscription ${inscriptionId}`);
            return null;
        }
    } catch (error) {
        logger.error(`Error getting mint address for inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Updated function to validate royalty payment with retry mechanism and Winston logging
async function validateRoyaltyPayment(deployInscription, mintAddress) {
    let retryCount = 0;

    while (retryCount < MAX_RETRIES) {
        try {
            logger.info(`Validating royalty payment from ${mintAddress} to ${deployInscription.deployer_address}, attempt ${retryCount + 1}`);
            const txsRes = await axios.get(`${config.API_WALLET_URL}/address/${mintAddress}/txs`);
            const transactions = txsRes.data;

            logger.info(`Retrieved ${transactions.length} transactions for address ${mintAddress}`);

            let totalRoyaltyPaid = 0;

            for (const tx of transactions) {
                logger.info(`Checking transaction: ${tx.txid}`);
                for (const output of tx.vout) {
                    if (output.scriptpubkey_address === deployInscription.deployer_address) {
                        totalRoyaltyPaid += output.value;
                        logger.info(`Found royalty payment: ${output.value} satoshis to ${output.scriptpubkey_address}`);
                    }
                }
            }

            const expectedRoyaltySatoshis = Math.floor(parseFloat(deployInscription.price) * 100000000);
            const isRoyaltyPaid = totalRoyaltyPaid >= expectedRoyaltySatoshis;

            logger.info(`Royalty validation: Paid=${totalRoyaltyPaid} satoshis, Expected=${expectedRoyaltySatoshis} satoshis, Valid=${isRoyaltyPaid}`);

            return isRoyaltyPaid;
        } catch (error) {
            if (error.response && error.response.status === 504) {
                logger.error('504 Gateway Timeout, retrying...');
                retryCount++;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * retryCount));
            } else {
                logger.error(`Error validating royalty payment:`, { message: error.message });
                break;
            }
        }
    }

    logger.error(`Failed to validate royalty payment after ${MAX_RETRIES} attempts.`);
    await waitForApiRecovery(); // Pause until API is available
    return false;
}

// Function to convert inscription ID to transaction ID
function convertInscriptionIdToTxId(inscriptionId) {
    return `${inscriptionId.slice(0, -2)}:${inscriptionId.slice(-1)}`;
}

// Function to get the deployer's address from the output with Winston logging
async function getDeployerAddress(inscriptionId) {
    try {
        const txId = convertInscriptionIdToTxId(inscriptionId);
        const outputRes = await axios.get(`${API_URL}/output/${txId}`, {
            headers: { 'Accept': 'application/json' }
        });

        if (outputRes.data && outputRes.data.address) {
            return outputRes.data.address;
        } else {
            throw new Error(`Deployer address is undefined or the response is not as expected for transaction ID ${txId}`);
        }
    } catch (error) {
        logger.error(`Error getting deployer address for inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to get current mint count for a specific deploy ID
async function getCurrentMintCount(deployId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT COUNT(*) as count FROM mints WHERE deploy_id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                logger.error(`Error getting mint count for deploy ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row.count);
            }
        });
    });
}

// Function to validate mint data with enhanced error handling using Joi and Winston logging
async function validateMintData(mintId, deployInscription, mintAddress, transactionId) {
    try {
        const currentMintCount = await getCurrentMintCount(deployInscription.id);
        const maxMints = parseInt(deployInscription.max);
        
        const isValid = mintAddress && 
                        transactionId && 
                        currentMintCount < maxMints;

        logger.info(`Mint data validation for ${mintId}:`, {
            mintAddress,
            transactionId,
            currentMintCount,
            maxMints,
            isValid
        });

        return isValid;
    } catch (error) {
        logger.error(`Error validating mint data for ${mintId}:`, { message: error.message });
        return false;
    }
}

// Function to process an inscription
async function processInscription(inscriptionId, blockHeight) {
    try {
        const res = await axios.get(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });

        let content = res.data;

        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }

        if (!content.startsWith('/content/') && !content.startsWith('{"p":"brc-420"')) {
            return;
        }

        logger.info(`Processing relevant inscription ${inscriptionId}: ${content}`);

        if (content.startsWith('{"p":"brc-420","op":"deploy"')) {
            const deployData = JSON.parse(content);
            logger.info(`Processing deploy inscription: ${JSON.stringify(deployData)}`);

            deployData.deployer_address = await getDeployerAddress(inscriptionId);
            deployData.block_height = blockHeight;
            deployData.timestamp = Date.now();
            deployData.source_id = deployData.id;

            if (await validateDeployData(deployData)) {
                await saveDeploy(deployData);
                logger.info(`Deploy inscription saved successfully: ${JSON.stringify(deployData)}`);
            } else {
                logger.info(`Invalid deploy structure for inscription ID: ${inscriptionId}`);
            }
        
        } else if (content.startsWith('/content/')) {
            const mintId = content.split('/content/')[1].split('"')[0];
            logger.info(`Processing mint inscription with ID: ${mintId}`);

            const deployInscription = await getDeployById(mintId);
            if (!deployInscription) {
                logger.info(`No deploy inscription found for mint ID ${mintId}. Skipping.`);
                return;
            }
            logger.info(`Found deploy inscription: ${JSON.stringify(deployInscription)}`);

            const mintAddress = await getMintAddress(inscriptionId);
            const transactionId = convertInscriptionIdToTxId(inscriptionId);

            logger.info(`Mint address: ${mintAddress}, Transaction ID: ${transactionId}`);

            if (!mintAddress) {
                logger.info(`Unable to retrieve mint address for inscription ${inscriptionId}. Skipping.`);
                return;
            }

            // Fetch and compare MIME types
            const deployMimeType = await getMimeType(deployInscription.source_id);
            const mintMimeType = await getMimeType(inscriptionId);

            if (deployMimeType !== mintMimeType) {
                logger.info(`MIME type mismatch: Deploy MIME type is ${deployMimeType}, but Mint MIME type is ${mintMimeType}. Skipping.`);
                return;
            }

            const isRoyaltyPaid = await validateRoyaltyPayment(deployInscription, mintAddress);
            logger.info(`Royalty paid: ${isRoyaltyPaid}`);

            const isMintValid = await validateMintData(mintId, deployInscription, mintAddress, transactionId);
            logger.info(`Mint valid: ${isMintValid}`);

            if (isRoyaltyPaid && isMintValid) {
                logger.info(`Mint validation successful. Saving mint data.`);
                await saveMint({
                    id: inscriptionId,
                    deploy_id: deployInscription.id,
                    source_id: mintId,
                    mint_address: mintAddress,
                    transaction_id: transactionId,
                    block_height: blockHeight,
                    timestamp: Date.now()
                });
                logger.info(`Mint saved successfully for inscription ${inscriptionId}`);
            } else {
                logger.info(`Mint validation failed for mint ID ${mintId}. Royalty paid: ${isRoyaltyPaid}, Mint valid: ${isMintValid}`);
            }
        }
    } catch (error) {
        logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
        logErrorBlock(blockHeight);
    }
}

const cache = {};

// Helper function to get data from the cache
function getFromCache(key) {
    if (cache[key] && (Date.now() < cache[key].expiry)) {
        return cache[key].value;
    }
    return null;
}

// Helper function to set data in the cache with an optional expiry time
function setInCache(key, value, ttl = 60000) { // ttl is time-to-live in ms
    const expiry = Date.now() + ttl;
    cache[key] = { value, expiry };
}

// Function to get MIME type of an inscription
async function getMimeType(inscriptionId) {
    const cacheKey = `mimeType:${inscriptionId}`;
    const cachedMimeType = getFromCache(cacheKey);

    if (cachedMimeType) {
        logger.info(`Cache hit: MIME type for inscription ${inscriptionId}: ${cachedMimeType}`);
        return cachedMimeType;
    }

    try {
        const response = await axios.head(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });
        const mimeType = response.headers['content-type'];

        setInCache(cacheKey, mimeType);

        logger.info(`MIME type for inscription ${inscriptionId}: ${mimeType}`);
        return mimeType;
    } catch (error) {
        logger.error(`Error getting MIME type for inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Define queues with different concurrency settings
const bulkProcessingQueue = new PQueue({ concurrency: config.CONCURRENCY_LIMIT });  // Higher concurrency for bulk processing
const realTimeQueue = new PQueue({ concurrency: 1 });  // Minimal concurrency for real-time processing

let currentQueue = bulkProcessingQueue;  // Start with bulk processing queue

async function determineQueueType() {
    // Determine whether to use bulk processing or real-time queue
    if (currentBlock >= cachedLatestBlockHeight) {
        currentQueue = realTimeQueue;
        logger.info("Switched to real-time processing.");
    } else {
        currentQueue = bulkProcessingQueue;
    }
}

// Function to process a block with the current queue
async function processBlock(blockHeight) {
    logger.info(`Processing block: ${blockHeight}`);

    try {
        const response = await axiosWithRetry({
            url: `${API_URL}/block/${blockHeight}`,
            method: 'get',
            headers: { 'Accept': 'application/json' }
        });

        const { inscriptions } = response.data;

        if (Array.isArray(inscriptions) && inscriptions.length > 0) {
            logger.info(`Total inscriptions found in block ${blockHeight}: ${inscriptions.length}`);
            
            const batchSize = 100;
            for (let i = 0; i < inscriptions.length; i += batchSize) {
                const batch = inscriptions.slice(i, i + batchSize);
                await currentQueue.add(() => processBatch(batch, blockHeight));
            }
        } else {
            logger.info(`No inscriptions found in block ${blockHeight}`);
        }
    } catch (error) {
        logger.error(`Error processing block ${blockHeight}:`, { message: error.message });
        logErrorBlock(blockHeight);
    }

    logger.info(`Block ${blockHeight} processed.`);
}

// Function to process a batch of inscriptions
async function processBatch(batch, blockHeight) {
    for (const inscriptionId of batch) {
        await processInscription(inscriptionId, blockHeight);
    }
}

// Start the processing loop
async function startProcessing() {
    try {
        await getAndCacheLatestBlockHeight();

        while (true) {
            // Retry any failed blocks before processing the current one
            await retryFailedBlocks(currentBlock);

            const upToDate = await checkIfUpToDate();
            if (upToDate) {
                await new Promise(r => setTimeout(r, 30000));
            } else {
                logger.info(`Starting to process block ${currentBlock}`);
                await processBlock(currentBlock);
                currentBlock++;
            }
        }
    } catch (error) {
        logger.error("Error in main processing loop:", { message: error.message });
        await waitForApiRecovery();
        startProcessing();
    }
}

// Use routes
app.use(routes);

// Start the server and begin processing
app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
    startProcessing().catch(error => {
        logger.error("Error in main processing loop:", { message: error.message });
    });
});

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info("Shutting down server...");
    db.close((err) => {
        if (err) {
            logger.error('Error closing database:', { message: err.message });
        } else {
            logger.info('Database connection closed.');
        }
        process.exit(0);
    });
});
