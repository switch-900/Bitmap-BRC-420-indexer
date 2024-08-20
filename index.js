const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose(); // Use sqlite3
const express = require('express');
const routes = require('./routes');
const winston = require('winston');
const Joi = require('joi');
const config = require('./config'); 
const cors = require('cors');
const os = require('os');

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

process.on('SIGINT', () => {
    logger.info('Received SIGINT. Shutting down gracefully.');
    if (db) db.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Received SIGTERM. Shutting down gracefully.');
    if (db) db.close();
    process.exit(0);
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
const API_WALLET_URL = config.API_WALLET_URL;
const RETRY_DELAY_MS = config.RETRY_DELAY;
const PORT = config.PORT;
const RETRY_BLOCK_DELAY = config.RETRY_BLOCK_DELAY;
let currentBlock = config.START_BLOCK;
const MAX_RETRIES = config.MAX_RETRIES;

// Function to check if the API is available
async function isApiAvailable(retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await axios.get(`${API_WALLET_URL}/health-check`);
            return response.status === 200;
        } catch (error) {
            logger.error('API health check failed:', { message: error.message });
            await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    return false;
}

// Function to save or update a wallet with Winston logging
function saveOrUpdateWallet(inscriptionId, address, type) {
    const now = Date.now();
    let sqlUpdate;

    switch (type) {
        case 'deploy':
            sqlUpdate = `UPDATE deploys SET wallet = ?, updated_at = ? WHERE id = ?`;
            break;
        case 'mint':
            sqlUpdate = `UPDATE mints SET wallet = ?, updated_at = ? WHERE id = ?`;
            break;
        case 'bitmap':
            sqlUpdate = `UPDATE bitmaps SET wallet = ?, updated_at = ? WHERE inscription_id = ?`;
            break;
        default:
            logger.error(`Unknown type ${type} for inscription ${inscriptionId}`);
            return;
    }

    db.run(sqlUpdate, [address, now, inscriptionId], (err) => {
        if (err) {
            logger.error(`Error updating wallet for ${type} ${inscriptionId}:`, { message: err.message });
        } else {
            logger.info(`Wallet updated for ${type} ${inscriptionId}, new address ${address}`);
        }
    });
}

// Function to save deploy data with Winston logging
async function saveDeploy(deployData) {
    deployData.wallet = deployData.deployer_address;
    deployData.updated_at = Date.now();

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
                logger.error('Error saving deploy:', { message: err.message });
                reject(err);
            } else {
                logger.info('Deploy saved successfully:', { deployData });
                resolve(true);
            }
        });
    });
}

// Function to save mint data with Winston logging
async function saveMint(mintData) {
    mintData.wallet = mintData.mint_address;
    mintData.updated_at = Date.now();

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
                logger.error('Error saving mint:', { message: err.message });
                reject(err);
            } else {
                logger.info('Mint saved successfully:', { mintData });
                resolve(true);
            }
        });
    });
}

// Function to log block in error table with Winston logging
function logErrorBlock(blockHeight) {
    const sql = `INSERT OR REPLACE INTO error_blocks (block_height, retry_at) VALUES (?, ?)`;
    const retryAtBlock = blockHeight + RETRY_BLOCK_DELAY;

    db.run(sql, [blockHeight, retryAtBlock], (err) => {
        if (err) {
            logger.error('Error logging error block:', { message: err.message });
        } else {
            logger.info(`Block ${blockHeight} logged for retry after ${RETRY_BLOCK_DELAY} blocks.`);
        }
    });
}

// Function to retrieve a deploy inscription by its ID from the database with Winston logging
function getDeployById(deployId) {
    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) {
                logger.error(`Error retrieving deploy by ID ${deployId}:`, { message: err.message });
                reject(err);
            } else {
                if (row) {
                    logger.info(`Deploy found for ID ${deployId}:`, { deploy: row });
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
        const outputRes = await axios.get(`${API_URL}/output/${txId}`, {
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
            const txsRes = await axios.get(`${API_WALLET_URL}/address/${mintAddress}/txs`);
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

            logger.info(`Total royalty paid: ${totalRoyaltyPaid} satoshis across ${transactions.length} transactions.`);

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
                const count = row ? row.count : 0;
                resolve(count);
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
                        !isNaN(currentMintCount) && 
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

// Function to process a batch of inscriptions with enhanced error handling and logging
async function processBatch(batch, blockHeight) {
    let mintCount = 0;
    let deployCount = 0;
    let bitmapCount = 0;

    for (const inscriptionId of batch) {
        try {
            const result = await processInscription(inscriptionId, blockHeight);
            if (result) {
                if (result.type === 'mint') mintCount++;
                else if (result.type === 'deploy') deployCount++;
                else if (result.type === 'bitmap') bitmapCount++;
            }
        } catch (error) {
            logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
        }
    }

    return { mintCount, deployCount, bitmapCount };
}

// ProcessInscription function with added checks for undefined values
async function processInscription(inscriptionId, blockHeight) {
    try {
        const res = await axios.get(`${API_URL}/content/${inscriptionId}`, {
            headers: { 'Accept': 'text/plain;charset=utf-8' }
        });

        let content = res.data;

        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }

        processingLogger.info(`Processing inscription ${inscriptionId}: ${content}`);

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
                    } else {
                        processingLogger.info(`BRC-420 mint validation failed for mint ID ${mintId}. Royalty paid: ${isRoyaltyPaid}, Mint valid: ${isMintValid}`);
                    }
                } else {
                    processingLogger.info(`Unable to retrieve mint address for BRC-420 inscription ${inscriptionId}. Skipping.`);
                }
            } else {
                processingLogger.info(`No deploy inscription found for BRC-420 mint ID ${mintId}. Skipping.`);
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
                        } else {
                            processingLogger.info(`Bitmap ${bitmapNumber} already exists. Inscription ${inscriptionId} not saved.`);
                        }
                    } else {
                        processingLogger.info(`Unable to retrieve address for bitmap inscription ${inscriptionId}. Skipping.`);
                    }
                } else {
                    processingLogger.info(`Invalid bitmap number for inscription ${inscriptionId}`);
                }
            } else {
                processingLogger.info(`Invalid bitmap format for inscription ${inscriptionId}`);
            }
        
        } else {
            processingLogger.info(`Unrecognized inscription type: ${inscriptionId}`);
        }

        return null;
    } catch (error) {
        logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

async function waitForApiRecovery() {
    let retryDelay = RETRY_DELAY_MS;
    const maxDelay = 60000;

    while (true) {
        logger.info('Waiting for API to become available...');
        await new Promise(resolve => setTimeout(resolve, retryDelay));
        if (await isApiAvailable()) break;

        logger.info('API still unavailable. Retrying...');
        retryDelay = Math.min(retryDelay * 2, maxDelay);
    }

    logger.info('API is now available. Resuming mint processing.');
}

// Additional improvements to retryFailedBlocks to avoid potential endless loops
async function retryFailedBlocks(currentBlockHeight) {
    const retryBlockHeight = currentBlockHeight - RETRY_BLOCK_DELAY;

    db.all("SELECT block_height FROM error_blocks WHERE retry_at <= ?", [retryBlockHeight], async (err, rows) => {
        if (err) {
            logger.error('Error fetching error blocks:', { message: err.message });
            return;
        }

        if (rows && rows.length > 0) {
            for (const row of rows) {
                try {
                    await processBlock(row.block_height);
                    db.run("DELETE FROM error_blocks WHERE block_height = ?", [row.block_height], (deleteErr) => {
                        if (deleteErr) {
                            logger.error(`Error deleting error block ${row.block_height}:`, { message: deleteErr.message });
                        } else {
                            logger.info(`Error block ${row.block_height} successfully retried and deleted.`);
                        }
                    });
                } catch (error) {
                    logger.error(`Failed to process error block ${row.block_height}.`, { message: error.message });
                }
            }
        }
    });
}

// Helper function to validate bitmap format
function isValidBitmapFormat(content) {
    const regex = /^\d+\.bitmap$/;
    return regex.test(content);
}

// Updated saveBitmap function
async function saveBitmap(bitmapData) {
    const exists = await bitmapNumberExists(bitmapData.bitmap_number);
    if (exists) {
        logger.info(`Bitmap number ${bitmapData.bitmap_number} already exists. Skipping.`);
        return false;
    }

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
                logger.error('Error saving bitmap:', { message: err.message });
                reject(err);
            } else {
                logger.info('Bitmap saved successfully:', { bitmapData });
                resolve(true);
            }
        });
    });
}

// Function to check if a bitmap number already exists
async function bitmapNumberExists(bitmapNumber) {
    return new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as count FROM bitmaps WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
            if (err) {
                if (err.message.includes('no such table')) {
                    resolve(false);
                } else {
                    logger.error(`Error checking bitmap number existence: ${err.message}`);
                    reject(err);
                }
            } else {
                resolve(row.count > 0);
            }
        });
    });
}

// Function to process a block with improved pagination and Winston logging
async function processBlock(blockHeight) {
    processingLogger.info(`Processing block: ${blockHeight}`);

    try {
        const response = await axios.get(`${API_URL}/block/${blockHeight}`, {
            headers: { 'Accept': 'application/json' }
        });

        const { inscriptions } = response.data;

        if (Array.isArray(inscriptions) && inscriptions.length > 0) {
            processingLogger.info(`Total inscriptions found in block ${blockHeight}: ${inscriptions.length}`);
            
            const batchSize = 1000;
            const numCPUs = os.cpus().length;
            const workerBatches = [];

            for (let i = 0; i < inscriptions.length; i += batchSize * numCPUs) {
                const workerBatch = inscriptions.slice(i, i + batchSize * numCPUs);
                workerBatches.push(workerBatch);
            }

            let mintCount = 0;
            let deployCount = 0;
            let bitmapCount = 0;

            await Promise.all(workerBatches.map(async (batch) => {
                const result = await processBatch(batch, blockHeight);
                mintCount += result.mintCount;
                deployCount += result.deployCount;
                bitmapCount += result.bitmapCount;
            }));

            processingLogger.info(`Block ${blockHeight} processed. Mints: ${mintCount}, Deploys: ${deployCount}, Bitmaps: ${bitmapCount}`);
        } else {
            processingLogger.info(`No inscriptions found in block ${blockHeight}`);
        }
    } catch (error) {
        logger.error(`Error processing block ${blockHeight}:`, { message: error.message });
        logErrorBlock(blockHeight);
    }
}

const NodeCache = require('node-cache');
const cache = new NodeCache();

function getDeployById(deployId) {
    const cachedDeploy = cache.get(deployId);
    if (cachedDeploy) return cachedDeploy;

    return new Promise((resolve, reject) => {
        const sql = `SELECT * FROM deploys WHERE id = ?`;
        db.get(sql, [deployId], (err, row) => {
            if (err) reject(err);
            else {
                cache.set(deployId, row);
                resolve(row);
            }
        });
    });
}

const { Worker } = require('worker_threads');

function runWorker(script, data) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(script, { workerData: data });
        worker.on('message', resolve);
        worker.on('error', reject);
        worker.on('exit', (code) => {
            if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
        });
    });
}

async function checkExistingDeploys() {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM deploys", [], (err, rows) => {
            if (err) {
                logger.error("Error checking existing deploys:", { message: err.message });
                reject(err);
            } else {
                logger.info(`Found ${rows.length} existing deploy inscriptions:`);
                rows.forEach(row => logger.info(JSON.stringify(row)));
                resolve(rows);
            }
        });
    });
}

async function startProcessing() {
    logger.info("Checking existing deploy inscriptions...");
    await checkExistingDeploys();

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
            await new Promise(resolve => setTimeout(resolve, 1000)); // 1 second delay between blocks
        } catch (error) {
            logger.error(`Error processing block ${currentBlock}:`, { message: error.message });
            await new Promise(resolve => setTimeout(resolve, 5000)); // 5 seconds delay on error
        }
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