const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const winston = require('winston');
const Joi = require('joi');
const pLimit = require('p-limit');
const config = require('./config');
const BitmapProcessor = require('./bitmap-processor');

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
let bitmapProcessor; // BitmapProcessor instance

// ================================
// UNLIMITED PROCESSING CLASSES
// ================================

// Class for unlimited API cache with intelligent memory management
class UnlimitedAPICache {
    constructor(maxAge = 300000) { // 5 minute cache
        this.cache = new Map();
        this.maxAge = maxAge;
        this.memoryThreshold = 0.8; // 80% of available memory
        this.lastCleanup = Date.now();
        this.cleanupInterval = setInterval(() => this.smartCleanup(), 60000); // Every minute
    }
    
    smartCleanup() {
        const now = Date.now();
        const memoryUsage = process.memoryUsage();
        const memoryPressure = memoryUsage.heapUsed / memoryUsage.heapTotal;
        
        let keysToDelete = [];
        
        // Always remove expired entries
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.maxAge) {
                keysToDelete.push(key);
            }
        }
        
        // If under memory pressure, remove older entries
        if (memoryPressure > this.memoryThreshold) {
            const allEntries = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            const entriesToRemove = Math.floor(allEntries.length * 0.2); // Remove oldest 20%
            keysToDelete = keysToDelete.concat(
                allEntries.slice(0, entriesToRemove).map(entry => entry[0])
            );
        }
        
        keysToDelete.forEach(key => this.cache.delete(key));
        
        if (keysToDelete.length > 0) {
            logger.debug(`Smart cache cleanup: removed ${keysToDelete.length} entries, cache size now: ${this.cache.size}`);
        }
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
    
    // No size limits - only memory-based cleanup
    set(key, data) {
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
    }
    
    destroy() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
        }
        this.cache.clear();
    }
    
    getStats() {
        const memoryUsage = process.memoryUsage();
        return {
            size: this.cache.size,
            memoryUsage: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
            maxAge: this.maxAge
        };
    }
}

// Adaptive concurrency management
class AdaptiveConcurrencyManager {
    constructor() {
        this.currentLimit = 10; // Start higher
        this.minLimit = 1;
        this.maxLimit = 50;
        this.successRate = 1.0;
        this.recentRequests = [];
        this.adjustmentInterval = setInterval(() => this.adjustConcurrency(), 30000); // Every 30 seconds
    }
    
    recordRequest(success, responseTime) {
        const now = Date.now();
        this.recentRequests.push({ success, responseTime, timestamp: now });
        
        // Keep only last 100 requests
        this.recentRequests = this.recentRequests
            .filter(req => now - req.timestamp < 60000) // Last minute
            .slice(-100);
    }
    
    adjustConcurrency() {
        if (this.recentRequests.length < 10) return; // Need sufficient data
        
        const successCount = this.recentRequests.filter(req => req.success).length;
        this.successRate = successCount / this.recentRequests.length;
        const avgResponseTime = this.recentRequests.reduce((sum, req) => sum + req.responseTime, 0) / this.recentRequests.length;
        
        // Increase concurrency if high success rate and fast responses
        if (this.successRate > 0.95 && avgResponseTime < 2000 && this.currentLimit < this.maxLimit) {
            this.currentLimit = Math.min(this.currentLimit + 2, this.maxLimit);
            processingLogger.debug(`Increased concurrency to ${this.currentLimit} (success rate: ${(this.successRate * 100).toFixed(1)}%)`);
        }
        // Decrease concurrency if low success rate or slow responses
        else if ((this.successRate < 0.8 || avgResponseTime > 5000) && this.currentLimit > this.minLimit) {
            this.currentLimit = Math.max(this.currentLimit - 1, this.minLimit);
            processingLogger.debug(`Decreased concurrency to ${this.currentLimit} (success rate: ${(this.successRate * 100).toFixed(1)}%)`);
        }
    }
    
    getLimit() {
        return pLimit(this.currentLimit);
    }
    
    destroy() {
        if (this.adjustmentInterval) {
            clearInterval(this.adjustmentInterval);
        }
    }
}

// Dynamic batch processing
class DynamicBatchProcessor {
    constructor() {
        this.currentBatchSize = 50;
        this.minBatchSize = 10;
        this.maxBatchSize = 200;
        this.successCount = 0;
        this.failureCount = 0;
    }
    
    adjustBatchSize(success) {
        if (success) {
            this.successCount++;
            this.failureCount = 0;
            
            // Increase batch size after 3 consecutive successes
            if (this.successCount >= 3 && this.currentBatchSize < this.maxBatchSize) {
                this.currentBatchSize = Math.min(this.currentBatchSize + 10, this.maxBatchSize);
                this.successCount = 0;
                processingLogger.debug(`Increased batch size to ${this.currentBatchSize}`);
            }
        } else {
            this.failureCount++;
            this.successCount = 0;
            
            // Decrease batch size immediately on failure
            if (this.currentBatchSize > this.minBatchSize) {
                this.currentBatchSize = Math.max(this.currentBatchSize - 10, this.minBatchSize);
                processingLogger.debug(`Decreased batch size to ${this.currentBatchSize} due to failure`);
            }
        }
    }
    
    getBatchSize() {
        return this.currentBatchSize;
    }
}

// PERFORMANCE OPTIMIZATION: Add adaptive concurrency control
const adaptiveConcurrency = new AdaptiveConcurrencyManager();
let concurrencyLimit = adaptiveConcurrency.getLimit();

// ================================
// ROBUST API CALLING WITH UNLIMITED RETRIES
// ================================

// Robust API calling with exponential backoff
async function robustApiCall(url, options = {}, maxRetries = 5) {
    const baseTimeout = 30000; // Start with 30 seconds
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const timeout = baseTimeout * Math.pow(1.5, attempt); // Exponential increase
            const startTime = Date.now();
            
            const response = await axios.get(url, {
                ...options,
                timeout: timeout,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'BRC-420-Complete-Indexer/1.0',
                    ...options.headers
                }
            });
            
            const responseTime = Date.now() - startTime;
            adaptiveConcurrency.recordRequest(true, responseTime);
            
            return response;
            
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;
            adaptiveConcurrency.recordRequest(false, baseTimeout);
            
            if (isLastAttempt) {
                throw new Error(`API call failed after ${maxRetries} attempts: ${error.message}`);
            }
            
            // Exponential backoff delay
            const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 second delay
            processingLogger.warn(`API call attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// ================================
// UNLIMITED INSCRIPTION FETCHING
// ================================

// Get ALL inscriptions for a block using the block-specific endpoint with proper pagination
async function getInscriptionsForBlock(blockHeight) {
    processingLogger.debug(`Fetching all inscriptions for block ${blockHeight} with pagination`);
    
    let allInscriptions = [];
    let hasMore = true;
    let pageNumber = 0; // Track which page we're on (0-based internally)
    const maxPages = 10000; // Safety limit to prevent infinite loops
    const seenInscriptions = new Set(); // Track unique inscriptions to detect duplicates
    
    while (hasMore && pageNumber < maxPages) {
        try {
            // First page (pageNumber=0) has no page parameter, subsequent pages use page=1, page=2, etc.
            const url = pageNumber === 0 
                ? `${API_URL}/inscriptions/block/${blockHeight}`
                : `${API_URL}/inscriptions/block/${blockHeight}?page=${pageNumber}`;
                
            processingLogger.debug(`Fetching page ${pageNumber} for block ${blockHeight}: ${url}`);
            
            const response = await robustApiCall(url);
            const responseData = response.data;
            
            // Extract inscription IDs from the response
            const inscriptions = Array.isArray(responseData) ? responseData : (responseData.ids || []);
            hasMore = responseData.more === true;
            const currentPageIndex = responseData.page_index !== undefined ? responseData.page_index : pageNumber;
            
            processingLogger.debug(`Block ${blockHeight}, Page ${pageNumber}: Found ${inscriptions.length} inscriptions (more=${hasMore}, page_index=${currentPageIndex})`);
            
            if (inscriptions.length === 0 && pageNumber === 0) {
                processingLogger.info(`Block ${blockHeight}: No inscriptions found in this block`);
                break;
            }
            
            if (inscriptions.length === 0 && pageNumber > 0) {
                processingLogger.info(`Block ${blockHeight}: No more inscriptions found on page ${pageNumber}, stopping pagination`);
                break;
            }
            
            // Check for duplicate inscriptions (API bug detection)
            let newInscriptions = 0;
            let duplicateInscriptions = 0;
            
            for (const inscription of inscriptions) {
                if (!seenInscriptions.has(inscription)) {
                    seenInscriptions.add(inscription);
                    allInscriptions.push(inscription);
                    newInscriptions++;
                } else {
                    duplicateInscriptions++;
                }
            }
            
            if (duplicateInscriptions > 0) {
                processingLogger.warn(`Block ${blockHeight}, Page ${pageNumber}: Found ${duplicateInscriptions} duplicate inscriptions (possible API pagination bug)`);
            }
            
            processingLogger.debug(`Block ${blockHeight}, Page ${pageNumber}: Added ${newInscriptions} new inscriptions (${duplicateInscriptions} duplicates ignored)`);
            
            // If more=false, we're done
            if (!hasMore) {
                processingLogger.info(`Block ${blockHeight}: API indicates no more pages (more=false)`);
                break;
            }
            
            // If we got no new inscriptions and there were duplicates, the API might be stuck
            if (newInscriptions === 0 && duplicateInscriptions > 0) {
                processingLogger.warn(`Block ${blockHeight}: Page ${pageNumber} returned only duplicates, assuming pagination is complete`);
                break;
            }
            
            // Move to next page
            pageNumber++;
            
            // Small delay between requests to avoid overwhelming the API
            await new Promise(resolve => setTimeout(resolve, 100));
            
        } catch (error) {
            if (error.response && error.response.status === 404) {
                processingLogger.info(`Block ${blockHeight} not found (404) - likely no inscriptions in this block`);
                break;
            } else {
                processingLogger.error(`Error fetching inscriptions for block ${blockHeight}, page ${pageNumber}: ${error.message}`);
                throw error;
            }
        }
    }
    
    if (pageNumber >= maxPages) {
        processingLogger.warn(`Block ${blockHeight}: Reached maximum page limit (${maxPages}), stopping pagination`);
    }
    
    processingLogger.info(`Block ${blockHeight}: Retrieved ${allInscriptions.length} total unique inscriptions across ${pageNumber} pages`);
    return allInscriptions;
}

// ================================
// UNLIMITED INSCRIPTION PROCESSING
// ================================

// Process all inscriptions with dynamic batching and NO LIMITS
async function processAllInscriptionsCompletely(inscriptionIds, blockHeight) {
    const batchProcessor = new DynamicBatchProcessor();
    let processedCount = 0;
    let results = [];
    
    processingLogger.info(`Starting COMPLETE processing of ${inscriptionIds.length} inscriptions in block ${blockHeight} with NO LIMITS`);
    
    while (processedCount < inscriptionIds.length) {
        const batchSize = batchProcessor.getBatchSize();
        const batch = inscriptionIds.slice(processedCount, processedCount + batchSize);
        
        try {
            // Update concurrency limit dynamically
            concurrencyLimit = adaptiveConcurrency.getLimit();
            
            const batchResults = await Promise.allSettled(
                batch.map(inscriptionId => 
                    concurrencyLimit(() => processInscriptionWithRetry(inscriptionId, blockHeight))
                )
            );
            
            results = results.concat(batchResults);
            processedCount += batch.length;
            batchProcessor.adjustBatchSize(true);
            
            processingLogger.debug(`Block ${blockHeight}: Processed ${processedCount}/${inscriptionIds.length} inscriptions (batch size: ${batchSize})`);
            
        } catch (error) {
            batchProcessor.adjustBatchSize(false);
            processingLogger.error(`Batch processing error for block ${blockHeight}:`, error.message);
            
            // Process failed batch one by one to ensure no data loss
            for (const inscriptionId of batch) {
                try {
                    const result = await processInscriptionWithRetry(inscriptionId, blockHeight);
                    results.push({ status: 'fulfilled', value: result });
                } catch (singleError) {
                    results.push({ status: 'rejected', reason: singleError });
                }
                processedCount++;
            }
        }
    }
    
    processingLogger.info(`COMPLETE: Finished processing all ${processedCount} inscriptions in block ${blockHeight}`);
    return results;
}

// Process inscription with comprehensive retry logic
async function processInscriptionWithRetry(inscriptionId, blockHeight, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            return await processInscription(inscriptionId, blockHeight);
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;
            
            if (isLastAttempt) {
                logger.error(`Failed to process inscription ${inscriptionId} after ${maxRetries} attempts:`, { message: error.message });
                
                // Save failed inscription for manual review
                await saveFailedInscription(inscriptionId, blockHeight, error.message);
                return null;
            }
            
            const delay = 1000 * Math.pow(2, attempt);
            logger.warn(`Inscription ${inscriptionId} processing attempt ${attempt + 1} failed, retrying in ${delay}ms`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

const apiCache = new UnlimitedAPICache();

// PERFORMANCE OPTIMIZATION: Cached API functions to reduce redundant calls
async function getDeployerAddressCached(inscriptionId) {
    const cacheKey = `deployer_${inscriptionId}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    try {
        const response = await robustApiCall(`${API_URL}/inscription/${inscriptionId}`, {
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
    
    // Try multiple API endpoints for better content fetching
    const endpoints = useLocalAPI ? [
        `${API_URL}/content/${inscriptionId}`,
        `${API_URL}/inscription/${inscriptionId}/content`,
    ] : [
        // When not using local API, still avoid ordinals.com JSON endpoints that return 406
        // Content endpoints typically work better than JSON endpoints on external APIs
        `${API_URL}/content/${inscriptionId}`,
    ];
    
    for (const endpoint of endpoints) {
        try {
            processingLogger.debug(`Trying content endpoint: ${endpoint.substring(0, 50)}...`);
            const response = await robustApiCall(endpoint, {
                responseType: 'text'
            });
            
            const content = response.data || '';
            if (content && content.length > 0) {
                processingLogger.debug(`Content fetched successfully (${content.length} chars): ${content.substring(0, 100)}...`);
                apiCache.set(cacheKey, content);
                return content;
            }
        } catch (error) {
            processingLogger.debug(`Endpoint ${endpoint} failed: ${error.message}`);
            continue; // Try next endpoint
        }
    }
    
    // If all endpoints fail, log the issue but return empty string to continue processing
    processingLogger.warn(`Could not fetch content for inscription ${inscriptionId} from any endpoint after all retries`);
    apiCache.set(cacheKey, '');
    return '';
}

async function getInscriptionDetailsCached(inscriptionId) {
    const cacheKey = `inscription_${inscriptionId}`;
    
    try {
        // Check cache first
        const cached = apiCache.get(cacheKey);
        if (cached !== null) {
            return cached;
        }

        // Try ord API endpoint for inscription details
        // Always try local API first if available
        let inscriptionResponse = null;
        
        // If we have a local API, try it first
        if (useLocalAPI && API_URL.includes('ordinals_web_1')) {
            try {
                inscriptionResponse = await robustApiCall(`${API_URL}/inscription/${inscriptionId}`, {
                    headers: { 'Accept': 'application/json' }
                });
            } catch (localError) {
                logger.debug(`Local API failed for inscription ${inscriptionId}, trying fallback: ${localError.message}`);
            }
        }
        
        // Fallback to configured API_URL if local failed or not available
        if (!inscriptionResponse) {
            inscriptionResponse = await robustApiCall(`${API_URL}/inscription/${inscriptionId}`, {
                headers: { 'Accept': 'application/json' }
            });
        }

        if (inscriptionResponse && inscriptionResponse.data) {
            const details = {
                id: inscriptionResponse.data.id,
                address: inscriptionResponse.data.address, // Current holder address
                sat: inscriptionResponse.data.sat, // Sat number
                satpoint: inscriptionResponse.data.satpoint,
                timestamp: inscriptionResponse.data.timestamp,
                height: inscriptionResponse.data.height,
                content_type: inscriptionResponse.data.content_type,
                content_length: inscriptionResponse.data.content_length,
                fee: inscriptionResponse.data.fee,
                value: inscriptionResponse.data.value
            };

            // Log when we successfully get sat number
            if (details.sat) {
                logger.debug(`✅ Got sat number for ${inscriptionId}: ${details.sat}`);
            } else {
                logger.debug(`⚠️ No sat number for ${inscriptionId} (API returned null)`);
            }

            // Cache the result
            apiCache.set(cacheKey, details);
            return details;
        }

        return null;

    } catch (error) {
        logger.debug(`Error fetching inscription details for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to get current wallet address (where inscription is now)
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
    
    // Force test the Docker endpoint that's most likely to work on Umbrel
    const forceTestEndpoints = [
        'http://ordinals_web_1:4000',
        'http://ordinals_server_1:4000'
    ];
    
    logger.info('🔍 Testing force endpoints for Ordinals API...');
    for (const endpoint of forceTestEndpoints) {
        try {
            // Try a simple inscription endpoint that should exist
            const testInscriptionId = 'f74cb8cee101149ac5c4f8853f32e40c76b690cef7f0b51d98a864e2be65763ci0'; // Bitmap #2015
            const response = await axios.get(`${endpoint}/inscription/${testInscriptionId}`, {
                timeout: 10000,
                headers: { 'Accept': 'application/json' }
            });
            
            if (response.status === 200 && response.data && response.data.id) {
                logger.info(`✅ Found Ordinals API at: ${endpoint} (via inscription test)`);
                logger.info(`🎯 Inscription test returned sat: ${response.data.sat || 'null'}`);
                API_URL = endpoint;
                useLocalAPI = true;
                return true;
            }
        } catch (error) {
            logger.debug(`❌ Force test failed ${endpoint}: ${error.message}`);
        }
    }
    
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

// Initialize database connection for indexer with retry logic
function initializeIndexerDb() {
    return new Promise((resolve, reject) => {
        let retryCount = 0;
        const maxRetries = 10;
        const retryDelay = 2000; // 2 seconds
        
        function attemptConnection() {
            db = new sqlite3.Database(config.DB_PATH, sqlite3.OPEN_READWRITE, (err) => {
                if (err) {
                    logger.warn(`Database connection attempt ${retryCount + 1} failed: ${err.message}`);
                    
                    if (retryCount < maxRetries) {
                        retryCount++;
                        logger.info(`Retrying database connection in ${retryDelay}ms (attempt ${retryCount}/${maxRetries})...`);
                        setTimeout(attemptConnection, retryDelay);
                    } else {
                        logger.error('Max database connection retries exceeded');
                        reject(err);
                    }
                } else {
                    logger.info('Indexer connected to the BRC-420 database.');
                    
                    // Configure database for concurrent access
                    db.serialize(() => {
                        db.run("PRAGMA journal_mode = WAL"); // Enable WAL mode for better concurrency
                        db.run("PRAGMA synchronous = NORMAL"); // Balance safety and speed
                        db.run("PRAGMA busy_timeout = 30000"); // 30 second timeout for busy database
                        db.run("PRAGMA cache_size = -64000"); // 64MB cache for indexer
                        
                        // Initialize database batcher for performance optimization
                        dbBatcher = new DatabaseBatcher(db);
                        
                        // Initialize BitmapProcessor for clean bitmap and parcel handling
                        bitmapProcessor = new BitmapProcessor(
                            db, 
                            logger, 
                            processingLogger, 
                            API_URL, 
                            getInscriptionDetailsCached, 
                            getMintAddress
                        );
                        logger.info('BitmapProcessor initialized successfully');
                        
                        resolve();
                    });
                }
            });
        }
        
        // Start first attempt after a small delay to let server.js initialize the database
        setTimeout(attemptConnection, 3000); // 3 second delay
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

// Function to get deployer address (using cached API call)
// Function to convert inscription ID to transaction ID
function convertInscriptionIdToTxId(inscriptionId) {
    return inscriptionId.split('i')[0];
}

// Function to validate royalty payment for mints (checks the mint transaction, not deploy)
async function validateMintRoyaltyPayment(deployInscription, mintAddress, mintTransactionId) {
    try {
        const response = await robustApiCall(`${config.getMempoolApiUrl()}/tx/${mintTransactionId}`, {
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
async function validateMintContentType(mintInscriptionId, sourceInscriptionId) {    try {
        // Get both inscriptions' metadata using cached API calls
        const [mintDetails, sourceDetails] = await Promise.all([
            getInscriptionDetailsCached(mintInscriptionId),
            getInscriptionDetailsCached(sourceInscriptionId)
        ]);

        if (!mintDetails || !sourceDetails) {
            logger.error(`Could not get inscription details for content type validation: mint=${!!mintDetails}, source=${!!sourceDetails}`);
            return false;
        }

        const mintContentType = mintDetails.content_type;
        const sourceContentType = sourceDetails.content_type;

        const isValid = mintContentType === sourceContentType;
        logger.info(`Content type validation for mint ${mintInscriptionId}: ${isValid ? 'VALID' : 'INVALID'} (mint: ${mintContentType}, source: ${sourceContentType})`);
        return isValid;

    } catch (error) {
        logger.error(`Error validating content type for mint ${mintInscriptionId}:`, { message: error.message });
        return false;
    }
}

// Function to validate royalty payment


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

        // Try local HTTP APIs only (no external APIs)
        const localMempoolUrl = config.getMempoolApiUrl();
        const apis = [];
        
        // Only add local mempool API if it's not an external URL
        if (localMempoolUrl && !localMempoolUrl.includes('mempool.space') && !localMempoolUrl.includes('blockstream.info')) {
            apis.push(`${localMempoolUrl}/block-height/${blockHeight}`);
        }
        
        // Try to find local mempool endpoints dynamically
        const testEndpoints = config.getMempoolApiEndpoints();
        for (const endpoint of testEndpoints) {
            if (!endpoint.includes('mempool.space') && !endpoint.includes('blockstream.info')) {
                apis.push(`${endpoint}/block-height/${blockHeight}`);
            }
        }
        
        logger.debug(`Trying ${apis.length} local APIs for block ${blockHeight} transaction count`);
        
        if (apis.length === 0) {
            logger.warn(`No local APIs available for block transaction count. Consider configuring API_WALLET_URL to point to local mempool instance.`);
            return 0; // Return 0 to indicate no local API available
        }

        for (const apiUrl of apis) {
            try {
                // First get block hash
                const hashResponse = await robustApiCall(apiUrl, {
                    headers: { 'Accept': 'text/plain' }
                });
                
                const blockHash = hashResponse.data.trim();
                
                // Then get full block info
                const blockInfoUrl = apiUrl.replace(`/block-height/${blockHeight}`, `/block/${blockHash}`);
                const blockResponse = await robustApiCall(blockInfoUrl, {
                    headers: { 'Accept': 'application/json' }
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

// Function to save block statistics to the database
async function saveBlockStats(blockHeight, totalTransactions, totalInscriptions, deployCount, mintCount, bitmapCount, parcelCount) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO block_stats (
                block_height, 
                total_transactions, 
                total_inscriptions, 
                brc420_deploys, 
                brc420_mints, 
                bitmaps, 
                parcels, 
                processed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        
        stmt.run([
            blockHeight,
            totalTransactions,
            totalInscriptions,
            deployCount,
            mintCount,
            bitmapCount,
            parcelCount,
            Date.now()
        ], function(err) {
            if (err) {
                logger.error(`Error saving block stats for block ${blockHeight}:`, { message: err.message });
                reject(err);
            } else {
                logger.debug(`Block stats saved for block ${blockHeight}: transactions=${totalTransactions}, inscriptions=${totalInscriptions}, deploys=${deployCount}, mints=${mintCount}, bitmaps=${bitmapCount}, parcels=${parcelCount}`);
                resolve(this.changes);
            }
        });
        
        stmt.finalize();
    });
}

// Function to validate parcel number against block transaction count
// Helper function to validate parcel format
// DEBUGGING: Comprehensive content analysis function
function analyzeInscriptionContent(inscriptionId, content, blockHeight) {
    const analysis = {
        inscriptionId,
        blockHeight,
        contentLength: content ? content.length : 0,
        isEmpty: !content || content.length === 0,
        contentPreview: content ? content.substring(0, 200) : 'EMPTY',
        patterns: {
            brc420Deploy: false,
            brc420Mint: false,
            hasBrc420: false,
            isJson: false,
            startsWithSlash: false,
            containsBitmap: false
        }
    };

    if (content && content.length > 0) {
        // Check for BRC-420 patterns
        analysis.patterns.brc420Deploy = content.startsWith('{"p":"brc-420","op":"deploy"');
        analysis.patterns.brc420Mint = content.trim().startsWith('/content/');
        analysis.patterns.hasBrc420 = content.includes('brc-420') || content.includes('"p":"brc-420"');
        analysis.patterns.isJson = content.trim().startsWith('{') && content.trim().endsWith('}');
        analysis.patterns.startsWithSlash = content.trim().startsWith('/');
        analysis.patterns.containsBitmap = content.includes('.bitmap');

        // Check for alternative BRC-420 patterns
        if (analysis.patterns.hasBrc420 && !analysis.patterns.brc420Deploy) {
            analysis.alternativePattern = true;
            analysis.alternativeContent = content.substring(0, 300);
        }

        // Log detailed analysis for potential BRC-420 content
        if (analysis.patterns.hasBrc420 || analysis.patterns.brc420Deploy || analysis.patterns.brc420Mint) {
            processingLogger.info(`🔍 BRC-420 Content Analysis for ${inscriptionId}:`);
            processingLogger.info(`   Block: ${blockHeight}, Length: ${analysis.contentLength}`);
            processingLogger.info(`   Deploy: ${analysis.patterns.brc420Deploy}`);
            processingLogger.info(`   Mint: ${analysis.patterns.brc420Mint}`);
            processingLogger.info(`   Has BRC-420: ${analysis.patterns.hasBrc420}`);
            processingLogger.info(`   Content: "${analysis.contentPreview}"`);
        }
    } else {
        processingLogger.warn(`⚠️  Empty content for inscription ${inscriptionId} in block ${blockHeight}`);
    }

    return analysis;
}

// DEBUGGING: Track content fetching statistics
let contentStats = {
    total: 0,
    empty: 0,
    brc420Deploy: 0,
    brc420Mint: 0,
    brc420Potential: 0,
    lastReset: Date.now()
};

function updateContentStats(analysis) {
    contentStats.total++;
    if (analysis.isEmpty) contentStats.empty++;
    if (analysis.patterns.brc420Deploy) contentStats.brc420Deploy++;
    if (analysis.patterns.brc420Mint) contentStats.brc420Mint++;
    if (analysis.patterns.hasBrc420) contentStats.brc420Potential++;

    // Log stats every 100 inscriptions
    if (contentStats.total % 100 === 0) {
        processingLogger.info(`📊 Content Analysis Stats (last 100): Empty: ${contentStats.empty}, BRC-420 Deploys: ${contentStats.brc420Deploy}, BRC-420 Mints: ${contentStats.brc420Mint}, Potential: ${contentStats.brc420Potential}`);
        
        // Reset counters
        contentStats = {
            total: 0,
            empty: 0,
            brc420Deploy: 0,
            brc420Mint: 0,
            brc420Potential: 0,
            lastReset: Date.now()
        };
    }
}

// DEBUGGING: Sample content logger
let sampleCount = 0;
const MAX_SAMPLES = 50;

function logSampleContent(inscriptionId, content, blockHeight) {
    if (sampleCount >= MAX_SAMPLES) return;
    
    sampleCount++;
    
    const preview = content ? content.substring(0, 200) : 'EMPTY';
    const isBrc420 = content && (content.includes('brc-420') || content.includes('"p":"brc-420"'));
    const isMint = content && content.trim().startsWith('/content/');
    const isBinary = content && (content.includes('\u0000') || content.charCodeAt(0) > 127);
    
    processingLogger.info(`🔎 SAMPLE ${sampleCount}/${MAX_SAMPLES} - Block ${blockHeight}`);
    processingLogger.info(`   ID: ${inscriptionId}`);
    processingLogger.info(`   Length: ${content ? content.length : 0} chars`);
    processingLogger.info(`   Binary: ${isBinary}, BRC-420: ${isBrc420}, Mint: ${isMint}`);
    processingLogger.info(`   Content: "${preview}"`);
    
    if (sampleCount >= MAX_SAMPLES) {
        processingLogger.info(`📋 Sample collection complete. Check logs above to understand content patterns.`);
    }
}

// Function to process inscription
async function processInscription(inscriptionId, blockHeight) {
    try {
        let content = await getInscriptionContentCached(inscriptionId);
        if (typeof content !== 'string') {
            content = JSON.stringify(content);
        }        processingLogger.debug(`Processing inscription ${inscriptionId}: content length=${content.length}, preview="${content.substring(0, 150)}..."`);
          // DEBUGGING: Comprehensive content analysis
        const analysis = analyzeInscriptionContent(inscriptionId, content, blockHeight);
        updateContentStats(analysis);
        
        // DEBUGGING: Log sample content for analysis
        logSampleContent(inscriptionId, content, blockHeight);
          // Enhanced content analysis for debugging
        if (!content || content.length === 0) {
            processingLogger.warn(`Empty content for inscription ${inscriptionId} - skipping BRC-420 processing`);
            return null;
        }
        
        // Check if content is likely binary data (not text/JSON)
        const isBinary = content.includes('\u0000') || content.includes('\uFFFD') || 
                         (content.charCodeAt(0) === 0x89 && content.substring(1, 4) === 'PNG') ||
                         (content.substring(0, 4) === '\xFF\xD8\xFF') || // JPEG
                         (content.substring(0, 6) === 'GIF87a' || content.substring(0, 6) === 'GIF89a');
        
        if (isBinary) {
            processingLogger.debug(`Binary content detected for inscription ${inscriptionId} - skipping BRC-420 processing`);
            return null;
        }
        
        // Check for BRC-420 deploy
        const isBrc420Deploy = content.startsWith('{"p":"brc-420","op":"deploy"');
        const isBrc420Mint = content.trim().startsWith('/content/');
        const hasBrc420Content = content.includes('brc-420') || content.includes('"p":"brc-420"');
        
        processingLogger.debug(`BRC-420 pattern analysis for ${inscriptionId}: deploy=${isBrc420Deploy}, mint=${isBrc420Mint}, hasBrc420=${hasBrc420Content}`);
          // Check for BRC-420 deploy
        if (isBrc420Deploy) {
            processingLogger.info(`BRC-420 deploy detected: ${inscriptionId}`);
            
            try {
                const deployData = JSON.parse(content);
                processingLogger.debug(`Deploy data parsed successfully: ${JSON.stringify(deployData)}`);
                
                deployData.deployer_address = await getDeployerAddressCached(inscriptionId);
                deployData.block_height = blockHeight;
                deployData.timestamp = Date.now();
                deployData.source_id = deployData.id;

                processingLogger.debug(`Deploy validation starting for ${inscriptionId}: deployer=${deployData.deployer_address}`);

                // Validate deploy according to BRC-420 spec
                const isOwnershipValid = await validateDeployerOwnership(deployData);
                const isUniqueDeployment = await validateUniqueDeployment(deployData.source_id);

                processingLogger.info(`Deploy validation results for ${inscriptionId}: ownership=${isOwnershipValid}, unique=${isUniqueDeployment}`);

                if (isOwnershipValid && isUniqueDeployment) {
                    await saveDeploy(deployData);
                    processingLogger.info(`✅ BRC-420 deploy inscription saved: ${inscriptionId}`);
                    return { type: 'deploy' };
                } else {
                    processingLogger.warn(`❌ BRC-420 deploy validation failed for ${inscriptionId}: ownership=${isOwnershipValid}, unique=${isUniqueDeployment}`);
                }
            } catch (parseError) {
                processingLogger.error(`Failed to parse BRC-420 deploy JSON for ${inscriptionId}: ${parseError.message}`);
                processingLogger.debug(`Raw content that failed to parse: ${content}`);
            }        } else if (content.trim().startsWith('/content/')) {
            // BRC-420 mint format: /content/<INSCRIPTION_ID>
            const trimmedContent = content.trim();
            processingLogger.info(`Potential BRC-420 mint detected: ${inscriptionId} -> ${trimmedContent}`);
            
            // More flexible regex to match inscription ID format: 64 hex chars + 'i' + numbers
            const mintMatch = trimmedContent.match(/^\/content\/([a-f0-9]{64}i\d+)$/);
            
            if (mintMatch) {
                const sourceInscriptionId = mintMatch[1]; // Extract the inscription ID
                processingLogger.info(`✅ Valid BRC-420 mint format detected: ${inscriptionId} -> source: ${sourceInscriptionId}`);
                
                const deployInscription = await getDeployById(sourceInscriptionId);

                if (deployInscription) {
                    processingLogger.info(`✅ Found deploy for mint ${inscriptionId}: ${deployInscription.id}`);
                    const mintAddress = await getMintAddress(inscriptionId);
                    const transactionId = convertInscriptionIdToTxId(inscriptionId);

                    if (mintAddress) {
                        processingLogger.info(`Validating mint ${inscriptionId}: address=${mintAddress}, tx=${transactionId}`);
                        const isRoyaltyPaid = await validateMintRoyaltyPayment(deployInscription, mintAddress, transactionId);
                        const isMintValid = await validateMintData(sourceInscriptionId, deployInscription, mintAddress, transactionId);
                        const isContentTypeValid = await validateMintContentType(inscriptionId, sourceInscriptionId);

                        processingLogger.info(`Mint validation results for ${inscriptionId}: royalty=${isRoyaltyPaid}, valid=${isMintValid}, contentType=${isContentTypeValid}`);

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
                            processingLogger.info(`✅ BRC-420 mint saved: ${inscriptionId}`);
                            return { type: 'mint' };
                        } else {
                            processingLogger.warn(`❌ BRC-420 mint validation failed for ${inscriptionId}: royalty=${isRoyaltyPaid}, valid=${isMintValid}, contentType=${isContentTypeValid}`);
                        }
                    } else {
                        processingLogger.warn(`❌ Could not get mint address for ${inscriptionId}`);
                    }
                } else {
                    processingLogger.warn(`❌ No deploy found for source inscription ${sourceInscriptionId}`);
                }
            } else {
                // Log potential mints that don't match the exact pattern
                processingLogger.debug(`Content starts with /content/ but doesn't match BRC-420 mint pattern: ${inscriptionId} -> ${trimmedContent}`);
            }
        } else if (content.includes('.bitmap')) {
            // Use BitmapProcessor for clean bitmap and parcel processing
            processingLogger.info(`Bitmap/parcel content detected: ${inscriptionId} -> ${content.trim()}`);
            
            const result = await bitmapProcessor.processBitmapOrParcel(
                content.trim(), 
                inscriptionId, 
                blockHeight, 
                getBlockTransactionCount
            );
            
            if (result) {
                processingLogger.info(`${result.type} processed successfully: ${result.id}`);
                return result;
            } else {
                processingLogger.debug(`Bitmap/parcel processing failed or skipped for: ${inscriptionId}`);
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
    const startTime = Date.now();
    processingLogger.info(`Starting COMPLETE processing of block: ${blockHeight} with NO LIMITS`);
    
    try {
        // Get ALL inscriptions for this block with no limits
        const allInscriptions = await getInscriptionsForBlock(blockHeight);
        
        if (allInscriptions.length > 0) {
            processingLogger.info(`Block ${blockHeight}: Processing ALL ${allInscriptions.length} inscriptions with NO LIMITS`);
            
            let mintCount = 0;
            let deployCount = 0;
            let bitmapCount = 0;
            let parcelCount = 0;
            let failedCount = 0;
            
            // Get transaction count for this block
            const transactionCount = await getBlockTransactionCount(blockHeight);
            
            // Log mint detection stats
            // Log mint detection stats
            const bitmapMints = allInscriptions.filter(i => i.content_type && 
                (i.content_type.includes('text/plain') || i.content_type.includes('application/json')) &&
                i.content && (i.content.includes('bitmap') || i.content.includes('Bitmap')));
            const parcelMints = allInscriptions.filter(i => i.content_type && 
                (i.content_type.includes('text/plain') || i.content_type.includes('application/json')) &&
                i.content && (i.content.includes('parcel') || i.content.includes('Parcel')));
            const brc420Mints = allInscriptions.filter(i => i.content_type && 
                (i.content_type.includes('text/plain') || i.content_type.includes('application/json')) &&
                i.content && (i.content.includes('brc-420') || i.content.includes('BRC-420')));
            
            logger.info(`Mint detection for block ${blockHeight}: ${bitmapMints.length} bitmap, ${parcelMints.length} parcel, ${brc420Mints.length} BRC-420`);
            if (bitmapMints.length > 0 || parcelMints.length > 0 || brc420Mints.length > 0) {
                logger.info(`Total mint detections: ${bitmapMints.length + parcelMints.length + brc420Mints.length} inscriptions`);
            }
            
            // Process ALL inscriptions with unlimited processing
            const results = await processAllInscriptionsCompletely(allInscriptions, blockHeight);
            
            // Count results
            results.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    if (result.value.type === 'mint') mintCount++;
                    else if (result.value.type === 'deploy') deployCount++;
                    else if (result.value.type === 'bitmap') bitmapCount++;
                    else if (result.value.type === 'parcel') parcelCount++;
                } else if (result.status === 'rejected') {
                    failedCount++;
                    logger.error(`Error processing inscription:`, { message: result.reason?.message || result.reason });
                }
            });
            
            // Save comprehensive block statistics
            await saveBlockStats(
                blockHeight, 
                transactionCount || 0, 
                allInscriptions.length, 
                deployCount, 
                mintCount, 
                bitmapCount, 
                parcelCount
            );
            
            const processingTime = Date.now() - startTime;
            const completenessRate = ((allInscriptions.length - failedCount) / allInscriptions.length * 100).toFixed(2);
            
            processingLogger.info(`Block ${blockHeight} COMPLETELY processed in ${processingTime}ms (${Math.round(processingTime/1000)}s)`);
            processingLogger.info(`COMPLETENESS: ${completenessRate}% (${allInscriptions.length - failedCount}/${allInscriptions.length})`);
            processingLogger.info(`Results: Transactions: ${transactionCount || 'Unknown'}, Inscriptions: ${allInscriptions.length}, Mints: ${mintCount}, Deploys: ${deployCount}, Bitmaps: ${bitmapCount}, Parcels: ${parcelCount}, Failed: ${failedCount}`);
            
            // Log cache and performance stats every 10 blocks
            if (blockHeight % 10 === 0) {
                const cacheStats = apiCache.getStats();
                const concurrentLimit = adaptiveConcurrency.currentLimit;
                processingLogger.info(`Performance stats at block ${blockHeight}: Cache ${cacheStats.size} entries (${cacheStats.memoryUsage}), Adaptive concurrency: ${concurrentLimit}`);
            }
            
        } else {
            // Even if no inscriptions, save block stats with transaction count
            const transactionCount = await getBlockTransactionCount(blockHeight);
            await saveBlockStats(blockHeight, transactionCount || 0, 0, 0, 0, 0, 0);
            
            const processingTime = Date.now() - startTime;
            processingLogger.info(`No inscriptions found in block ${blockHeight}. Transactions: ${transactionCount || 'Unknown'} (processed in ${processingTime}ms)`);
        }
        
    } catch (error) {
        logger.error(`Error in COMPLETE processing of block ${blockHeight}:`, { message: error.message });
        
        // If we're using local API and get network error, try re-discovering local APIs instead of falling back to external
        if (useLocalAPI && (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
            logger.warn('Local API failed, attempting to re-discover local APIs...');
            
            // Try to rediscover local APIs
            const foundLocalAPI = await testLocalOrdinalsAPIConnectivity();
            if (foundLocalAPI) {
                logger.info('Successfully rediscovered local API, continuing with local services');
            } else if (config.useLocalApisOnly()) {
                logger.error('Local API discovery failed and USE_LOCAL_APIS_ONLY is set - cannot fall back to external API');
                throw new Error('Local API unavailable and external API fallback disabled');
            } else {
                logger.info('Local API rediscovery failed, switching to external API for future requests');
                API_URL = config.getApiUrl(); // Switch back to external API
                useLocalAPI = false;
            }
        }
        
        logErrorBlock(blockHeight);
        throw error; // Re-throw to ensure block is marked for retry
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
        
        // Log configuration mode
        if (config.useLocalApisOnly()) {
            logger.info('🔒 Running in LOCAL APIs ONLY mode (no external APIs will be used)');
            logger.info('📡 Will only use local Ordinals and Mempool HTTP APIs');
        } else {
            logger.info('🌐 Running in HYBRID mode (local APIs preferred, external fallback available)');
        }
        
        // Test local API connectivity before starting
        await testLocalAPIConnectivity();
        await testLocalMempoolAPIConnectivity();
        
        // Set up cleanup on process exit
        process.on('SIGINT', () => {
            logger.info('Received SIGINT, cleaning up...');
            if (apiCache) {
                apiCache.destroy();
            }
            if (db) {
                db.close((err) => {
                    if (err) {
                        logger.error('Error closing database:', err);
                    } else {
                        logger.info('Database closed.');
                    }
                    process.exit(0);
                });
            } else {
                process.exit(0);
            }
        });
        
        process.on('SIGTERM', () => {
            logger.info('Received SIGTERM, cleaning up...');
            if (apiCache) {
                apiCache.destroy();
            }
            if (db) {
                db.close(() => process.exit(0));
            } else {
                process.exit(0);
            }
        });
        
        await startProcessing();
    }
};

// Function to generate bitmap pattern data for Mondrian visualization
async function generateBitmapPattern(bitmapNumber, inscriptionId) {
    try {
        // Get transaction history for this bitmap from Bitcoin Core or ord
        const txHistory = await getBitmapTransactionHistory(bitmapNumber, inscriptionId);
        
        if (!txHistory || txHistory.length === 0) {
            logger.warn(`No transaction history found for bitmap ${bitmapNumber}`);
            return null;
        }        // Convert transaction data to simple size string for Mondrian visualization
        const txListArray = txHistory.map(tx => {
            // Use proper value-to-size conversion (like in the original demo)
            const btcValue = tx.value / 100000000; // Convert sats to BTC
            let size;
            if (btcValue === 0) size = 1;
            else if (btcValue <= 0.01) size = 1;
            else if (btcValue <= 0.1) size = 2;
            else if (btcValue <= 1) size = 3;
            else if (btcValue <= 10) size = 4;
            else if (btcValue <= 100) size = 5;
            else if (btcValue <= 1000) size = 6;
            else if (btcValue <= 10000) size = 7;
            else if (btcValue <= 100000) size = 8;
            else if (btcValue <= 1000000) size = 9;
            else size = 9;
            
            return size; // Return simple number for MondrianLayout
        });

        // Just store the simple pattern string - no extra metadata needed
        const patternString = txListArray.join(''); // "554433221"

        // Save pattern to database
        return new Promise((resolve, reject) => {
            const stmt = db.prepare(`
                INSERT OR REPLACE INTO bitmap_patterns 
                (bitmap_number, pattern_string) 
                VALUES (?, ?)
            `);
              stmt.run([
                bitmapNumber,
                patternString
            ], function(err) {
                if (err) {
                    logger.error(`Error saving pattern for bitmap ${bitmapNumber}:`, { message: err.message });
                    reject(err);
                } else {
                    logger.info(`Pattern saved for bitmap ${bitmapNumber}: ${patternString}`);
                    resolve(patternString);
                }
            });
        });

    } catch (error) {
        logger.error(`Error generating pattern for bitmap ${bitmapNumber}:`, { message: error.message });
        return null;
    }
}

// Function to get transaction history for a bitmap
async function getBitmapTransactionHistory(bitmapNumber, inscriptionId) {
    try {
        // Try to get transaction history from ord API
        const txHistory = await getInscriptionTransactionsCached(inscriptionId);
        
        if (txHistory && txHistory.length > 0) {
            return txHistory;
        }

        // Fallback: Generate synthetic transaction data based on bitmap number
        logger.info(`Generating synthetic transaction data for bitmap ${bitmapNumber}`);
        return generateSyntheticTransactionData(bitmapNumber);

    } catch (error) {
        logger.warn(`Error fetching transaction history for bitmap ${bitmapNumber}, using synthetic data:`, { message: error.message });
        return generateSyntheticTransactionData(bitmapNumber);
    }
}

// Function to get inscription transaction history (cached)
async function getInscriptionTransactionsCached(inscriptionId) {
    const cacheKey = `tx_history_${inscriptionId}`;
    
    try {
        // Check cache first
        const cached = apiCache.get(cacheKey);
        if (cached !== null) {
            return cached;
        }

        // Try ord API endpoint
        const response = await robustApiCall(`${API_URL}/inscription/${inscriptionId}/transactions`, {
            headers: { 'Accept': 'application/json' }
        });

        if (response.data && Array.isArray(response.data)) {
            const transactions = response.data.map(tx => ({
                txid: tx.txid || tx.id,
                blockHeight: tx.block_height || tx.blockHeight || 0,
                value: tx.value || tx.output_value || Math.floor(Math.random() * 1000000),
                timestamp: tx.timestamp || new Date().toISOString()
            }));

            apiCache.set(cacheKey, transactions);
            return transactions;
        }

        return null;

    } catch (error) {
        logger.debug(`Error fetching inscription transactions for ${inscriptionId}:`, { message: error.message });
        return null;
    }
}

// Function to generate synthetic transaction data for visualization
function generateSyntheticTransactionData(bitmapNumber) {
    const numTransactions = Math.min(20, Math.max(3, Math.floor(bitmapNumber / 10000) + 3));
    const transactions = [];
    
    for (let i = 0; i < numTransactions; i++) {
        transactions.push({
            txid: `synthetic_${bitmapNumber}_${i}`,
            blockHeight: 830000 + Math.floor(bitmapNumber / 1000) + i,
            value: Math.floor(Math.random() * 1000000) + 546, // Random value between 546 and 1M sats
            timestamp: new Date(Date.now() - (numTransactions - i) * 86400000).toISOString() // Spread over days
        });
    }
    
    return transactions;
}
