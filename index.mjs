import axios from 'axios';
import sqlite3 from 'sqlite3';
import express from 'express';
import routes from './routes/index.mjs';
import winston from 'winston';
import Joi from 'joi';
import { config } from './config.mjs';
import cors from 'cors';
import PQueue from 'p-queue';
import Redis from 'ioredis';

const app = express();

app.use(cors());


const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({
            filename: 'app.log',
            maxsize: 10485760, // 10MB per file
            maxFiles: 5,       // Keep up to 5 log files
            tailable: true     // Ensures the most recent logs are always in 'app.log'
        })
    ]
});

export default logger;

// Initialize SQLite database
const db = new sqlite3.Database(config.DB_PATH, (err) => {
    if (err) {
        logger.error('Error opening database:', { message: err.message });
    } else {
        logger.info('Connected to the BRC-420 database.');
    }
});

// Initialize Redis for caching
const redis = new Redis(config.REDIS_URL);

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
    position: Joi.number().integer().positive().required(), // Position in block
    source_id: Joi.string().required()
});

const mintSchema = Joi.object({
    id: Joi.string().required(),
    deploy_id: Joi.string().required(),
    source_id: Joi.string().required(),
    mint_address: Joi.string().required(),
    transaction_id: Joi.string().required(),
    block_height: Joi.number().integer().positive().required(),
    timestamp: Joi.date().timestamp().required(),
    position: Joi.number().integer().positive().required() // Position in block
});

const bitmapSchema = Joi.object({
    inscription_id: Joi.string().required(),
    holder: Joi.string().required(),
    bitmap_number: Joi.number().integer().positive().required(),
    block_height: Joi.number().integer().positive().required(),
    position: Joi.number().integer().positive().required(), // Position in block
    content: Joi.string().pattern(/^\d+\.bitmap$/).required()
});

const API_URL = config.API_URL;
const RETRY_DELAY_MS = config.RETRY_DELAY;
const PORT = config.PORT;
let currentBlock = config.START_BLOCK;
let cachedLatestBlockHeight = null;
const MAX_RETRIES = config.MAX_RETRIES;

const deployCache = new Map();
const maxedOutDeploys = new Set();

// Function to connect to Redis
async function cacheGet(key) {
    return await redis.get(key);
}

async function cacheSet(key, value, ttl = 3600) {
    await redis.set(key, value, 'EX', ttl);
}

async function axiosWithRetry(config, retries = 3, delay = 1000) {
    for (let i = 0; i < retries; i++) {
        try {
            return await axios(config);
        } catch (error) {
            if (i === retries - 1) throw error;
            const jitter = Math.random() * 1000;
            await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i) + jitter));
        }
    }
}

async function getAndCacheLatestBlockHeight() {
    try {
        const response = await axios.get(`${API_URL}/r/blockheight`);
        
        if (typeof response.data === 'string') {
            cachedLatestBlockHeight = parseInt(response.data.trim(), 10);
        } else if (typeof response.data === 'number') {
            cachedLatestBlockHeight = response.data;
        } else {
            throw new Error('Unexpected response format for block height');
        }
        
        logger.info(`Latest block height cached: ${cachedLatestBlockHeight}`);
    } catch (error) {
        logger.error('Error retrieving latest block height:', { message: error.message });
        throw error;
    }
}

async function waitForApiRecovery() {
    logger.info('Waiting for API recovery...');
    const delay = RETRY_DELAY_MS * 5;
    await new Promise(resolve => setTimeout(resolve, delay));
}

async function checkIfUpToDate() {
    if (currentBlock >= cachedLatestBlockHeight) {
        await getAndCacheLatestBlockHeight();
        if (currentBlock >= cachedLatestBlockHeight) {
            logger.info("Up to date with the blockchain. Switching to periodic checking.");
            return true;
        }
    }
    return false;
}

async function validateAndSave(schema, data, sql, params, retries = 3) {
    const { error } = schema.validate(data);
    if (error) {
        logger.error('Data validation failed:', { message: error.details });
        return Promise.reject(error);
    }

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            return new Promise((resolve, reject) => {
                db.run(sql, params, (err) => {
                    if (err) {
                        logger.error(`Attempt ${attempt + 1} - Error saving data:`, { message: err.message });
                        reject(err);
                    } else {
                        logger.info('Data saved successfully:', { data });
                        resolve();
                    }
                });
            });
        } catch (err) {
            if (attempt === retries - 1) throw err;
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        }
    }
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

async function validateBitmapData(bitmapData) {
    const { error } = bitmapSchema.validate(bitmapData);
    if (error) {
        logger.error('Bitmap data validation failed:', { message: error.details });
        return false;
    }

    if (bitmapData.block_height < bitmapData.bitmap_number) {
        logger.info(`Bitmap ${bitmapData.content} in block ${bitmapData.block_height} is invalid (block too early).`);
        return false;
    }

    const sql = `SELECT 1 FROM bitmaps WHERE bitmap_number = ? LIMIT 1`;
    return new Promise((resolve, reject) => {
        db.get(sql, [bitmapData.bitmap_number], (err, row) => {
            if (err) {
                logger.error(`Error checking bitmap occurrence:`, { message: err.message });
                reject(err);
            } else {
                if (row) {
                    logger.info(`Bitmap ${bitmapData.content} is a duplicate and invalid.`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            }
        });
    });
}

function saveBitmap(bitmapData) {
    const sql = `INSERT INTO bitmaps (inscription_id, block_height, bitmap_number, address, content, position)
                 VALUES (?, ?, ?, ?, ?, ?)`;

    const params = [
        bitmapData.inscription_id, bitmapData.block_height, bitmapData.bitmap_number,
        bitmapData.holder, bitmapData.content, bitmapData.position
    ];

    return validateAndSave(bitmapSchema, bitmapData, sql, params);
}

async function saveMint(mintData) {
    const sql = `INSERT OR IGNORE INTO mints 
                (id, deploy_id, source_id, mint_address, transaction_id, block_height, timestamp, position)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

    const params = [
        mintData.id, mintData.deploy_id, mintData.source_id, mintData.mint_address,
        mintData.transaction_id, mintData.block_height, mintData.timestamp, mintData.position
    ];

    await validateAndSave(mintSchema, mintData, sql, params);

    const currentMintCount = await getCurrentMintCount(mintData.deploy_id);
    const deployData = await getDeployById(mintData.deploy_id); // Fetching deploy data to update cache
    if (currentMintCount >= deployData.max) {
        maxedOutDeploys.add(mintData.deploy_id);
        logger.info(`Deploy ID ${mintData.deploy_id} has reached its maximum mint count.`);
    }
}

async function getMintAddress(inscriptionId) {
    const cacheKey = `mintAddress:${inscriptionId}`;
    let mintAddress = deployCache.get(cacheKey);

    if (mintAddress) {
        logger.info(`Mint address for ${inscriptionId} found in cache.`);
        return mintAddress;
    }

    mintAddress = await cacheGet(cacheKey);
    if (mintAddress) {
        deployCache.set(cacheKey, mintAddress);
        logger.info(`Mint address for ${inscriptionId} found in Redis cache.`);
        return mintAddress;
    }

    try {
        const txId = convertInscriptionIdToTxId(inscriptionId);
        logger.info(`Fetching output for transaction ID: ${txId}`);
        const outputRes = await axiosWithRetry({
            url: `${API_URL}/output/${txId}`,
            method: 'get',
            headers: { 'Accept': 'application/json' }
        });

        if (outputRes.data && outputRes.data.address) {
            logger.info(`Mint address for ${inscriptionId}: ${outputRes.data.address}`);
            deployCache.set(cacheKey, outputRes.data.address);
            cacheSet(cacheKey, outputRes.data.address);
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

async function getCurrentMintCount(deployId) {
    const cacheKey = `mintCount:${deployId}`;
    let mintCount = deployCache.get(cacheKey);

    if (mintCount !== undefined) {
        logger.info(`Mint count for deploy ${deployId} found in cache.`);
        return mintCount;
    }

    mintCount = await cacheGet(cacheKey);
    if (mintCount !== null) {
        deployCache.set(cacheKey, parseInt(mintCount, 10));
        logger.info(`Mint count for deploy ${deployId} found in Redis cache.`);
        return parseInt(mintCount, 10);
    }

    return new Promise((resolve, reject) => {
        const sql = `SELECT COUNT(*) as count FROM mints WHERE deploy_id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                logger.error(`Error getting mint count for deploy ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                const count = row.count;
                deployCache.set(cacheKey, count);
                cacheSet(cacheKey, count.toString());
                resolve(count);
            }
        });
    });
}


async function validateRoyaltyPayment(deployInscription, mintAddress) {
    const deployerAddress = deployInscription.deployer_address;
    let retryCount = 0;

    while (retryCount < MAX_RETRIES) {
        try {
            logger.info(`Validating royalty payment from ${mintAddress} to ${deployerAddress}, attempt ${retryCount + 1}`);
            const txsRes = await axios.get(`${config.API_WALLET_URL}/address/${mintAddress}/txs`);
            const transactions = txsRes.data;

            logger.info(`Retrieved ${transactions.length} transactions for address ${mintAddress}`);

            const expectedRoyaltySatoshis = Math.floor(parseFloat(deployInscription.price) * 100000000);

            for (const tx of transactions) {
                for (const output of tx.vout) {
                    if (output.scriptpubkey_address === deployerAddress && output.value >= expectedRoyaltySatoshis) {
                        logger.info(`Valid payment found: ${output.value} satoshis to ${output.scriptpubkey_address}, required: ${expectedRoyaltySatoshis} satoshis`);
                        return true;
                    }
                }
            }

            logger.info(`No valid payment found that meets the required royalty amount of ${expectedRoyaltySatoshis} satoshis.`);
            return false;
        } catch (error) {
            if (error.response && error.response.status === 504) {
                logger.error('504 Gateway Timeout, retrying...');
                retryCount++;
                const jitter = Math.random() * 1000;
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * retryCount + jitter));
            } else {
                logger.error(`Error validating royalty payment:`, { message: error.message });
                break;
            }
        }
    }

    logger.error(`Failed to validate royalty payment after ${MAX_RETRIES} attempts.`);
    await waitForApiRecovery();
    return false;
}

// Function to process an inscription
async function processInscription(inscriptionId, blockHeight, position) {
    try {
        const res = await axios.get(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });

        let content = res.data;

        // Ensure content is in string format
        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }

        if (!content.startsWith('/content/') && !content.startsWith('{"p":"brc-420"')) {
            // is a bitmap
            const bitmapMatch = content.match(/(\d+)\.bitmap/);
            if (bitmapMatch) {
                const bitmapNumber = parseInt(bitmapMatch[1], 10);
                const bitmapData = {
                    inscription_id: inscriptionId,
                    holder: await getMintAddress(inscriptionId),
                    bitmap_number: bitmapNumber,
                    block_height: blockHeight,
                    content: `${bitmapNumber}.bitmap`,
                    position: position
                };

                // Check for address update in bitmaps
                const existingBitmap = await getBitmapByInscriptionId(inscriptionId);
                if (existingBitmap && existingBitmap.address !== bitmapData.holder) {
                    await updateBitmapAddress(existingBitmap, bitmapData.holder, blockHeight);
                    return 'address_update';
                }

                if (await validateBitmapData(bitmapData)) {
                    await saveBitmap(bitmapData);
                    return 'bitmap';
                }
            }
            return;
        }

        logger.info(`Processing relevant inscription ${inscriptionId}: ${content}`);

        if (content.startsWith('{"p":"brc-420","op":"deploy"')) {
            const deployData = JSON.parse(content);
            logger.info(`Processing deploy inscription: ${JSON.stringify(deployData)}`);

            deployData.deployer_address = await getMintAddress(inscriptionId);
            deployData.block_height = blockHeight;
            deployData.timestamp = Date.now();
            deployData.source_id = deployData.id;
            deployData.position = position;

            if (await validateDeployData(deployData)) {
                await saveDeploy(deployData);
                logger.info(`Deploy inscription saved successfully: ${JSON.stringify(deployData)}`);
                return 'deploy';
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

            if (maxedOutDeploys.has(deployInscription.id)) {
                logger.info(`Skipping mint ID ${mintId} as the deploy ${deployInscription.id} has reached its maximum mint count.`);
                return;
            }

            const mintAddress = await getMintAddress(inscriptionId);
            const transactionId = convertInscriptionIdToTxId(inscriptionId);

            if (!mintAddress) {
                logger.info(`Unable to retrieve mint address for inscription ${inscriptionId}. Skipping.`);
                return;
            }

            // Use getMintByInscriptionId to check if the mint already exists
            const existingMint = await getMintByInscriptionId(inscriptionId);
            if (existingMint) {
                // Optionally update wallet if needed
                if (existingMint.wallet !== mintAddress) {
                    await updateMintWallet(existingMint, mintAddress, blockHeight);
                }
                return 'mint_update';
            }

            const isRoyaltyPaid = await validateRoyaltyPayment(deployInscription, mintAddress);
            const isMintValid = await validateMintData(mintId, deployInscription, mintAddress, transactionId);

            if (isRoyaltyPaid && isMintValid) {
                const deployMimeType = await getMimeType(deployInscription.source_id);
                const mintMimeType = await getMimeType(inscriptionId);

                if (deployMimeType === mintMimeType) {
                    await saveMint({
                        id: inscriptionId,
                        deploy_id: deployInscription.id,
                        source_id: mintId,
                        mint_address: mintAddress,
                        transaction_id: transactionId,
                        block_height: blockHeight,
                        timestamp: Date.now(),
                        position: position
                    });
                    logger.info(`Mint saved successfully for inscription ${inscriptionId}`);
                    return 'mint';
                } else {
                    logger.info(`MIME type mismatch for mint ID ${mintId}. Skipping.`);
                }
            } else {
                logger.info(`Mint validation failed for mint ID ${mintId}. Royalty paid: ${isRoyaltyPaid}, Mint valid: ${isMintValid}`);
            }
        }

    } catch (error) {
        logger.error(`Error processing inscription ${inscriptionId} in block ${blockHeight}:`, { message: error.message });
        logErrorBlock(blockHeight);
    }
    return null; // Return null if the inscription does not match any criteria
}


async function getMintByInscriptionId(inscriptionId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM mints WHERE inscription_id = ? LIMIT 1`;
        db.get(sql, [inscriptionId], (err, row) => {
            if (err) {
                logger.error(`Error retrieving mint by inscription ID ${inscriptionId}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function getBitmapByInscriptionId(inscriptionId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM bitmaps WHERE inscription_id = ? LIMIT 1`;
        db.get(sql, [inscriptionId], (err, row) => {
            if (err) {
                logger.error(`Error retrieving bitmap by inscription ID ${inscriptionId}:`, { message: err.message });
                reject(err);
            } else {
                resolve(row);
            }
        });
    });
}

async function updateMintWallet(existingMint, newWallet, blockHeight) {
    return new Promise((resolve, reject) => {
        const sql = `
            UPDATE mints 
            SET 
                previous_wallet = wallet,
                wallet = ?,
                wallet_update_block = ?,
                wallet_update_timestamp = ?
            WHERE 
                inscription_id = ?`;

        const params = [
            newWallet,
            blockHeight,
            Date.now(),
            existingMint.inscription_id
        ];

        db.run(sql, params, (err) => {
            if (err) {
                logger.error(`Error updating wallet for inscription ${existingMint.inscription_id}:`, { message: err.message });
                reject(err);
            } else {
                logger.info(`Wallet updated for inscription ${existingMint.inscription_id}: new wallet ${newWallet}, previous wallet ${existingMint.wallet}`);
                resolve();
            }
        });
    });
}

async function updateBitmapAddress(existingBitmap, newAddress, blockHeight) {
    return new Promise((resolve, reject) => {
        const sql = `
            UPDATE bitmaps 
            SET 
                previous_address = address,
                address = ?,
                address_update_block = ?,
                address_update_timestamp = ?
            WHERE 
                inscription_id = ?`;

        const params = [
            newAddress,
            blockHeight,
            Date.now(),
            existingBitmap.inscription_id
        ];

        db.run(sql, params, (err) => {
            if (err) {
                logger.error(`Error updating address for inscription ${existingBitmap.inscription_id}:`, { message: err.message });
                reject(err);
            } else {
                logger.info(`Address updated for inscription ${existingBitmap.inscription_id}: new address ${newAddress}, previous address ${existingBitmap.address}`);
                resolve();
            }
        });
    });
}

async function saveDeploy(deployData) {
    const sql = `INSERT OR IGNORE INTO deploys 
                (id, p, op, name, max, price, deployer_address, block_height, timestamp, source_id, wallet, updated_at, mint_count, position)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    const params = [
        deployData.id, deployData.p, deployData.op, deployData.name, deployData.max,
        deployData.price, deployData.deployer_address, deployData.block_height,
        deployData.timestamp, deployData.source_id, deployData.wallet,
        deployData.updated_at, deployData.mint_count || 0, deployData.position
    ];

    await validateAndSave(deploySchema, deployData, sql, params);

    // Ensure caching happens immediately after saving deploy data
    const cacheKey = `deploy:${deployData.id}`;
    deployCache.set(cacheKey, deployData);
    await cacheSet(cacheKey, JSON.stringify(deployData));

    logger.info(`Deploy ID ${deployData.id} cached successfully.`);
}


async function getDeployById(deployId) {
    const cacheKey = `deploy:${deployId}`;
    let deployData = deployCache.get(cacheKey);

    if (deployData) {
        logger.info(`Deploy ID ${deployId} found in cache.`);
        return deployData;
    }

    deployData = await cacheGet(cacheKey);
    if (deployData) {
        deployData = JSON.parse(deployData);
        deployCache.set(cacheKey, deployData);
        logger.info(`Deploy ID ${deployId} found in Redis cache.`);
        return deployData;
    }

    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                logger.error(`Error retrieving deploy by ID ${deployId}:`, { message: err.message });
                reject(err);
            } else if (!row) {
                logger.info(`No deploy found with ID ${deployId}`);
                resolve(null);
            } else {
                logger.info(`Deploy found for ID ${deployId}:`, { deploy: row });
                deployCache.set(cacheKey, row);
                cacheSet(cacheKey, JSON.stringify(row));
                resolve(row);
            }
        });
    });
}


async function validateMintData(mintId, deployInscription, mintAddress, transactionId) {
    if (maxedOutDeploys.has(deployInscription.id)) {
        logger.info(`Deploy ID ${deployInscription.id} has already reached its maximum mint count. Skipping further validation.`);
        return false;
    }

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

        if (currentMintCount >= maxMints) {
            maxedOutDeploys.add(deployInscription.id);
            deployCache.delete(`deploy:${deployInscription.id}`);
            logger.info(`Deploy ID ${deployInscription.id} has reached its max supply. Removed from cache.`);
        }

        return isValid;
    } catch (error) {
        logger.error(`Error validating mint data for ${mintId}:`, { message: error.message });
        return false;
    }
}


async function getMimeType(inscriptionId) {
    const cacheKey = `mimeType:${inscriptionId}`;
    let mimeType = deployCache.get(cacheKey);

    if (mimeType) {
        logger.info(`Cache hit: MIME type for inscription ${inscriptionId}: ${mimeType}`);
        return mimeType;
    }

    mimeType = await cacheGet(cacheKey);
    if (mimeType) {
        deployCache.set(cacheKey, mimeType);
        logger.info(`MIME type for inscription ${inscriptionId} found in Redis cache: ${mimeType}`);
        return mimeType;
    }

    try {
        const response = await axios.head(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });
        mimeType = response.headers['content-type'];

        deployCache.set(cacheKey, mimeType);
        cacheSet(cacheKey, mimeType);

        logger.info(`MIME type for inscription ${inscriptionId}: ${mimeType}`);
        return mimeType;
    } catch (error) {
        logger.error(`Error getting MIME type for inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

function convertInscriptionIdToTxId(inscriptionId) {
    return `${inscriptionId.slice(0, -2)}:${inscriptionId.slice(-1)}`;
}

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

const bulkProcessingQueue = new PQueue({ concurrency: config.CONCURRENCY_LIMIT });
const realTimeQueue = new PQueue({ concurrency: 1 });

let currentQueue = bulkProcessingQueue;

async function determineQueueType() {
    if (currentBlock >= cachedLatestBlockHeight) {
        currentQueue = realTimeQueue;
        logger.info("Switched to real-time processing.");
    } else {
        currentQueue = bulkProcessingQueue;
    }
}

async function processBlock(blockHeight) {
    logger.info(`Processing block: ${blockHeight}`);

    try {
        const response = await axiosWithRetry({
            url: `${API_URL}/block/${blockHeight}`,
            method: 'get',
            headers: { 'Accept': 'application/json' }
        });

        const { inscriptions } = response.data;
        if (!Array.isArray(inscriptions)) {
            logger.info(`No inscriptions found in block ${blockHeight}`);
            return;
        }

        let deployCount = 0;
        let mintCount = 0;
        let bitmapCount = 0;

        for (let i = 0; i < inscriptions.length; i++) {
            const inscriptionId = inscriptions[i];
            const result = await processInscription(inscriptionId, blockHeight, i + 1); // Pass the position of the inscription

            if (result === 'deploy') {
                deployCount++;
            } else if (result === 'mint') {
                mintCount++;
            } else if (result === 'bitmap') {
                bitmapCount++;
            }
        }

        logger.info(`Block ${blockHeight} processed. Total inscriptions: ${inscriptions.length}, Deploys: ${deployCount}, Mints: ${mintCount}, Bitmaps: ${bitmapCount}`);

    } catch (error) {
        logger.error(`Error processing block ${blockHeight}:`, { message: error.message });
        logErrorBlock(blockHeight);

    }

    logger.info(`Block ${blockHeight} processed.`);
}


async function startProcessing() {
    try {
        await getAndCacheLatestBlockHeight();

        while (true) {
            await retryFailedBlocks(currentBlock);

            const upToDate = await checkIfUpToDate();
            if (upToDate) {
                await new Promise(r => setTimeout(r, 30000));
            } else {
                await determineQueueType();
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

app.use(routes);

app.listen(PORT, () => {
    logger.info(`Server is running on http://localhost:${PORT}`);
    startProcessing().catch(error => {
        logger.error("Error in main processing loop:", { message: error.message });
    });
});

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
