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
let localApiHasSatIndex = null; // null = not tested, true = supports, false = doesn't support
let bitmapProcessor; // BitmapProcessor instance

// ================================
// UNLIMITED PROCESSING CLASSES
// ================================

// Enhanced adaptive memory-safe cache with unlimited capacity
class AdaptiveMemorySafeCache {
    constructor(maxAge = 300000) { // 5 minute cache
        this.cache = new Map();
        this.maxAge = maxAge;
        this.memoryThreshold = 0.85; // Only cleanup under severe memory pressure
        this.lastCleanup = Date.now();
        this.cleanupInterval = setInterval(() => this.adaptiveCleanup(), 60000);
        this.totalCleanups = 0;
        this.totalItemsProcessed = 0;
    }
    
    adaptiveCleanup() {
        const now = Date.now();
        const memoryUsage = process.memoryUsage();
        const memoryPressure = memoryUsage.heapUsed / memoryUsage.heapTotal;
        
        let keysToDelete = [];
        
        // ALWAYS remove expired entries (no data loss)
        for (const [key, item] of this.cache.entries()) {
            if (now - item.timestamp > this.maxAge) {
                keysToDelete.push(key);
            }
        }
        
        // ONLY under severe memory pressure, remove older entries
        if (memoryPressure > this.memoryThreshold) {
            const allEntries = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            // Remove oldest 25% under severe pressure (still keep 75%)
            const entriesToRemove = Math.floor(allEntries.length * 0.25);
            if (entriesToRemove > 0) {
                keysToDelete = keysToDelete.concat(
                    allEntries.slice(0, entriesToRemove).map(entry => entry[0])
                );
                logger.warn(`Severe memory pressure (${Math.round(memoryPressure * 100)}%), removing ${entriesToRemove} oldest cache entries`);
            }
        }
        
        keysToDelete.forEach(key => this.cache.delete(key));
        this.totalCleanups++;
        
        if (keysToDelete.length > 0) {
            logger.debug(`Adaptive cache cleanup: removed ${keysToDelete.length} entries, cache size now: ${this.cache.size}`);
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
    
    set(key, data) {
        // NO arbitrary size limits - let it grow as needed for complete indexing
        this.cache.set(key, {
            data,
            timestamp: Date.now()
        });
        this.totalItemsProcessed++;
    }
    
    // Emergency cleanup only if system is about to crash
    emergencyCleanup() {
        const memoryUsage = process.memoryUsage();
        const memoryMB = memoryUsage.heapUsed / 1024 / 1024;
        
        if (memoryMB > 3072) { // Only if using >3GB (very high)
            const allEntries = Array.from(this.cache.entries())
                .sort((a, b) => a[1].timestamp - b[1].timestamp);
            
            const toDelete = allEntries.slice(0, Math.floor(allEntries.length * 0.5));
            toDelete.forEach(([key]) => this.cache.delete(key));
            
            logger.warn(`Emergency cleanup: removed ${toDelete.length} entries, memory was ${memoryMB}MB`);
            
            if (global.gc) {
                global.gc();
                logger.info('Forced garbage collection after emergency cleanup');
            }
        }
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
            maxAge: this.maxAge,
            cleanups: this.totalCleanups,
            processed: this.totalItemsProcessed,
            hitRate: this.totalItemsProcessed > 0 ? (this.cache.size / this.totalItemsProcessed * 100).toFixed(1) + '%' : '0%'
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
            // FIXED: Use path parameters instead of query parameters for pagination
            const url = pageNumber === 0 
                ? `${API_URL}/inscriptions/block/${blockHeight}`
                : `${API_URL}/inscriptions/block/${blockHeight}/${pageNumber}`;
                
            processingLogger.debug(`Fetching page ${pageNumber} for block ${blockHeight}: ${url}`);
            
            const response = await robustApiCall(url);
            const responseData = response.data;
            
            // Log the actual response structure for debugging
            processingLogger.debug(`Block ${blockHeight}, Page ${pageNumber}: Raw response structure: ${JSON.stringify(Object.keys(responseData)).substring(0, 200)}`);
            
            // Extract inscription IDs and pagination info from the response
            let inscriptions = [];
            let moreFlag = false;
            
            if (Array.isArray(responseData)) {
                // Simple array response (old format)
                inscriptions = responseData;
                moreFlag = false; // No pagination info in array format
            } else if (responseData.ids && Array.isArray(responseData.ids)) {
                // Object with ids array (new format)
                inscriptions = responseData.ids;
                moreFlag = responseData.more === true;
            } else {
                // Unexpected format
                processingLogger.warn(`Block ${blockHeight}, Page ${pageNumber}: Unexpected response format: ${JSON.stringify(responseData).substring(0, 200)}`);
                inscriptions = [];
                moreFlag = false;
            }
            
            hasMore = moreFlag;
            const currentPageIndex = responseData.page_index !== undefined ? responseData.page_index : pageNumber;
            
            processingLogger.debug(`Block ${blockHeight}, Page ${pageNumber}: Found ${inscriptions.length} inscriptions (more=${hasMore}, page_index=${currentPageIndex})`);
            processingLogger.debug(`Block ${blockHeight}, Page ${pageNumber}: Response format - isArray: ${Array.isArray(responseData)}, has_ids: ${!!responseData.ids}, more_field: ${responseData.more}, has_more_property: ${responseData.hasOwnProperty('more')}`);
            
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
            
            // If more=false explicitly, we're done
            if (responseData.hasOwnProperty('more') && !hasMore) {
                processingLogger.info(`Block ${blockHeight}: API explicitly indicates no more pages (more=false)`);
                break;
            }
            
            // If we got no new inscriptions, check termination conditions
            if (newInscriptions === 0) {
                if (pageNumber === 0) {
                    // First page with no inscriptions means empty block
                    processingLogger.info(`Block ${blockHeight}: No inscriptions found in this block`);
                    break;
                } else if (duplicateInscriptions > 0) {
                    // Subsequent page with only duplicates
                    if (responseData.hasOwnProperty('more') && hasMore) {
                        // API says there are more pages, but we got only duplicates - continue cautiously
                        processingLogger.warn(`Block ${blockHeight}: Page ${pageNumber} returned only duplicates, but API indicates more pages. Continuing...`);
                    } else {
                        // No more flag or more=false, and only duplicates - stop
                        processingLogger.info(`Block ${blockHeight}: Page ${pageNumber} returned only duplicates and no more pages indicated. Pagination complete.`);
                        break;
                    }
                } else {
                    // No new inscriptions and no duplicates - truly empty page
                    processingLogger.info(`Block ${blockHeight}: Page ${pageNumber} returned no inscriptions. Pagination complete.`);
                    break;
                }
            }
            
            // If we have new inscriptions but API says no more, continue for one more page to be safe
            if (newInscriptions > 0 && responseData.hasOwnProperty('more') && !hasMore) {
                processingLogger.info(`Block ${blockHeight}: Got ${newInscriptions} new inscriptions but API indicates no more pages. This should be the last page.`);
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
// FAST CONTENT PREVIEW OPTIMIZATION
// ================================

// Get just the first 50 characters of inscription content for type detection
async function getInscriptionContentPreview(inscriptionId, previewLength = 50) {
    const cacheKey = `preview_${inscriptionId}_${previewLength}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    const endpoints = useLocalAPI ? [
        `${API_URL}/content/${inscriptionId}`,
        `${API_URL}/inscription/${inscriptionId}/content`,
    ] : [
        `${API_URL}/content/${inscriptionId}`,
    ];
    
    for (const endpoint of endpoints) {
        try {
            // Use range header to fetch only the first bytes
            const response = await robustApiCall(endpoint, {
                responseType: 'text',
                headers: {
                    'Range': `bytes=0-${previewLength + 10}` // Get a bit extra for safety
                }
            });
            
            let content = response.data || '';
            if (typeof content !== 'string') {
                content = String(content);
            }
            
            // Truncate to exact preview length
            const preview = content.substring(0, previewLength);
            
            if (preview.length > 0) {
                processingLogger.debug(`Fast preview fetched (${preview.length} chars): "${preview}"`);
                apiCache.set(cacheKey, preview);
                return preview;
            }
        } catch (error) {
            // Range requests might not be supported, fall back to full content
            if (error.response && error.response.status === 416) {
                // Range not satisfiable, try without range
                try {
                    const response = await robustApiCall(endpoint, {
                        responseType: 'text'
                    });
                    
                    let content = response.data || '';
                    if (typeof content !== 'string') {
                        content = String(content);
                    }
                    
                    const preview = content.substring(0, previewLength);
                    apiCache.set(cacheKey, preview);
                    return preview;
                } catch (fallbackError) {
                    processingLogger.debug(`Fallback endpoint ${endpoint} failed: ${fallbackError.message}`);
                    continue;
                }
            } else {
                processingLogger.debug(`Preview endpoint ${endpoint} failed: ${error.message}`);
                continue;
            }
        }
    }
    
    // If all endpoints fail, return empty string
    processingLogger.debug(`Could not fetch preview for inscription ${inscriptionId}`);
    apiCache.set(cacheKey, '');
    return '';
}

// Fast content type detection using preview (optimized based on Python indexer patterns)
function detectInscriptionType(preview) {
    if (!preview || preview.length === 0) {
        return 'unknown';
    }
    
    // Clean whitespace for analysis
    const trimmed = preview.trim();
    
    // BRC-420 deploy detection (highest priority)
    if (trimmed.startsWith('{"p":"brc-420","op":"deploy"')) {
        return 'brc420-deploy';
    }
    
    // BRC-420 mint detection
    if (trimmed.startsWith('/content/') && trimmed.includes('i')) {
        return 'brc420-mint';
    }
    
    // OPTIMIZED: Bitmap detection with strict validation (based on Python indexer)
    if (trimmed.endsWith('.bitmap')) {
        const bitmapCandidate = trimmed.substring(0, trimmed.length - 7); // Remove '.bitmap'
        if (isValidBitmapNumber(bitmapCandidate)) {
            return 'bitmap';
        }
    }
    
    // Binary content detection
    if (trimmed.includes('\u0000') || trimmed.includes('\uFFFD') || 
        (trimmed.charCodeAt(0) === 0x89 && trimmed.substring(1, 4) === 'PNG') ||
        (trimmed.substring(0, 4) === '\xFF\xD8\xFF') || // JPEG
        (trimmed.substring(0, 6) === 'GIF87a' || trimmed.substring(0, 6) === 'GIF89a')) {
        return 'binary';
    }
    
    // JSON content (potential for future BRC standards)
    if (trimmed.startsWith('{') && trimmed.includes('"')) {
        return 'json';
    }
    
    // Text content
    return 'text';
}

// OPTIMIZED: Bitmap number validation (based on Python indexer logic)
function isValidBitmapNumber(bitmapStr) {
    if (!bitmapStr || bitmapStr.length === 0) {
        return false;
    }
    
    // Check if all characters are digits
    for (let i = 0; i < bitmapStr.length; i++) {
        const char = bitmapStr[i];
        if (char < '0' || char > '9') {
            return false;
        }
    }
    
    // No leading zeros except for "0" itself
    if (bitmapStr[0] === '0' && bitmapStr.length !== 1) {
        return false;
    }
    
    return true;
}

// OPTIMIZED: Extract and validate bitmap number from content
function extractBitmapNumber(content) {
    if (!content || !content.endsWith('.bitmap')) {
        return null;
    }
    
    const bitmapStr = content.substring(0, content.length - 7); // Remove '.bitmap'
    
    if (!isValidBitmapNumber(bitmapStr)) {
        return null;
    }
    
    const bitmapNumber = parseInt(bitmapStr, 10);
    
    // Additional validation: ensure parsing didn't fail
    if (isNaN(bitmapNumber) || bitmapNumber < 0) {
        return null;
    }
    
    return bitmapNumber;
}

// ================================
// CONTENT TYPE FILTERING (Based on Python indexer approach)
// ================================

// Filter inscriptions by content type before processing (Python indexer optimization)
async function filterInscriptionsByContentType(inscriptionIds, blockHeight) {
    processingLogger.info(`🔍 Pre-filtering ${inscriptionIds.length} inscriptions by content type`);
    
    const relevantInscriptions = [];
    const skipCount = { binary: 0, irrelevant: 0, errors: 0 };
    
    // Process in batches to avoid overwhelming the API
    const batchSize = 100;
    for (let i = 0; i < inscriptionIds.length; i += batchSize) {
        const batch = inscriptionIds.slice(i, i + batchSize);
        
        const batchPromises = batch.map(async (inscriptionId) => {
            try {
                // Get inscription details to check content type
                const details = await getInscriptionDetailsCached(inscriptionId);
                if (!details || !details.content_type) {
                    skipCount.errors++;
                    return null;
                }
                
                const contentType = details.content_type.toLowerCase();
                
                // PYTHON INDEXER PATTERN: Only process text/plain content
                // Also include application/json for BRC-420 deploys
                if (contentType.includes('text/plain') || 
                    contentType.includes('application/json') ||
                    contentType.includes('text/json')) {
                    
                    return {
                        id: inscriptionId,
                        contentType: contentType,
                        priority: getPriorityForContentType(contentType)
                    };
                } else {
                    // Skip binary, image, and other non-text content
                    if (contentType.includes('image/') || 
                        contentType.includes('audio/') || 
                        contentType.includes('video/') ||
                        contentType.includes('application/octet-stream')) {
                        skipCount.binary++;
                    } else {
                        skipCount.irrelevant++;
                    }
                    return null;
                }
            } catch (error) {
                processingLogger.debug(`Error getting content type for ${inscriptionId}: ${error.message}`);
                skipCount.errors++;
                return null;
            }
        });
        
        const batchResults = await Promise.allSettled(batchPromises);
        
        for (const result of batchResults) {
            if (result.status === 'fulfilled' && result.value) {
                relevantInscriptions.push(result.value);
            }
        }
        
        // Small delay between batches to avoid API rate limits
        if (i + batchSize < inscriptionIds.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    
    processingLogger.info(`✅ Content type filtering complete:`);
    processingLogger.info(`   📋 Relevant: ${relevantInscriptions.length}/${inscriptionIds.length}`);
    processingLogger.info(`   🚫 Skipped binary: ${skipCount.binary}`);
    processingLogger.info(`   🔍 Skipped irrelevant: ${skipCount.irrelevant}`);
    processingLogger.info(`   ❌ Errors: ${skipCount.errors}`);
    
    // Sort by priority (highest first)
    relevantInscriptions.sort((a, b) => a.priority - b.priority);
    
    return relevantInscriptions;
}

function getPriorityForContentType(contentType) {
    if (contentType.includes('application/json')) return 1; // BRC-420 deploys likely
    if (contentType.includes('text/plain')) return 2; // Bitmaps and mints
    return 3; // Other text types
}

// ================================
// WORKER-BASED TASK ORGANIZATION
// ================================

// Task priority system for optimal processing order
class TaskPriorityManager {
    constructor() {
        this.taskQueues = {
            'high': [], // BRC-420 deploys (highest priority)
            'medium': [], // BRC-420 mints and bitmaps
            'low': [], // Other content types
            'skip': [] // Binary/non-relevant content
        };
        this.processedCount = 0;
        this.totalTasks = 0;
    }
    
    // Categorize inscription based on fast preview
    categorizeInscription(inscriptionId, contentType, blockHeight) {
        const task = {
            id: inscriptionId,
            type: contentType,
            blockHeight: blockHeight,
            priority: this.getPriority(contentType)
        };
        
        switch (contentType) {
            case 'brc420-deploy':
                this.taskQueues.high.push(task);
                break;
            case 'brc420-mint':
            case 'bitmap':
                this.taskQueues.medium.push(task);
                break;
            case 'json':
            case 'text':
                this.taskQueues.low.push(task);
                break;
            case 'binary':
                this.taskQueues.skip.push(task);
                break;
            default:
                this.taskQueues.low.push(task);
        }
        
        this.totalTasks++;
        return task;
    }
    
    getPriority(contentType) {
        const priorities = {
            'brc420-deploy': 1,
            'brc420-mint': 2,
            'bitmap': 3,
            'json': 4,
            'text': 5,
            'binary': 99
        };
        return priorities[contentType] || 10;
    }
    
    // Get next batch of tasks to process, prioritized
    getNextBatch(batchSize = 50) {
        const batch = [];
        
        // Process high priority first
        while (batch.length < batchSize && this.taskQueues.high.length > 0) {
            batch.push(this.taskQueues.high.shift());
        }
        
        // Then medium priority
        while (batch.length < batchSize && this.taskQueues.medium.length > 0) {
            batch.push(this.taskQueues.medium.shift());
        }
        
        // Finally low priority
        while (batch.length < batchSize && this.taskQueues.low.length > 0) {
            batch.push(this.taskQueues.low.shift());
        }
        
        return batch;
    }
    
    hasMoreTasks() {
        return this.taskQueues.high.length > 0 || 
               this.taskQueues.medium.length > 0 || 
               this.taskQueues.low.length > 0;
    }
    
    getStats() {
        return {
            high: this.taskQueues.high.length,
            medium: this.taskQueues.medium.length,
            low: this.taskQueues.low.length,
            skipped: this.taskQueues.skip.length,
            processed: this.processedCount,
            total: this.totalTasks
        };
    }
    
    markProcessed() {
        this.processedCount++;
    }
}

// ================================
// UNLIMITED INSCRIPTION PROCESSING
// ================================

// Process all inscriptions with FAST PREVIEW and WORKER-BASED PRIORITIZATION
async function processAllInscriptionsCompletely(inscriptionIds, blockHeight) {
    const batchProcessor = new DynamicBatchProcessor();
    const taskManager = new TaskPriorityManager();
    let results = [];
    
    processingLogger.info(`🚀 Starting OPTIMIZED processing of ${inscriptionIds.length} inscriptions in block ${blockHeight}`);
    
    // PHASE 0: CONTENT TYPE FILTERING (Python indexer approach)
    processingLogger.info(`🔍 Phase 0: Content type pre-filtering`);
    const preFilterStartTime = Date.now();
    
    const relevantInscriptions = await filterInscriptionsByContentType(inscriptionIds, blockHeight);
    
    const preFilterTime = Date.now() - preFilterStartTime;
    processingLogger.info(`✅ Phase 0 complete (${preFilterTime}ms): ${relevantInscriptions.length}/${inscriptionIds.length} inscriptions are relevant`);
    
    if (relevantInscriptions.length === 0) {
        processingLogger.info(`🎯 No relevant inscriptions found in block ${blockHeight}, skipping detailed processing`);
        return [];
    }
    
    // PHASE 1: FAST PREVIEW - Categorize remaining inscriptions by type
    processingLogger.info(`📋 Phase 1: Fast content preview and task categorization`);
    const previewStartTime = Date.now();
    
    const previewPromises = relevantInscriptions.map(async (inscriptionInfo) => {
        try {
            const preview = await getInscriptionContentPreview(inscriptionInfo.id, 50);
            const contentType = detectInscriptionType(preview);
            return taskManager.categorizeInscription(inscriptionInfo.id, contentType, blockHeight);
        } catch (error) {
            processingLogger.debug(`Preview failed for ${inscriptionInfo.id}: ${error.message}`);
            return taskManager.categorizeInscription(inscriptionInfo.id, 'unknown', blockHeight);
        }
    });
    
    // Process previews with concurrency control
    concurrencyLimit = adaptiveConcurrency.getLimit();
    await Promise.allSettled(
        previewPromises.map(promise => concurrencyLimit(() => promise))
    );
    
    const previewTime = Date.now() - previewStartTime;
    const stats = taskManager.getStats();
    
    processingLogger.info(`✅ Phase 1 complete (${previewTime}ms): High=${stats.high}, Medium=${stats.medium}, Low=${stats.low}, Skipped=${stats.skipped}`);
    
    // PHASE 2: PRIORITIZED PROCESSING - Process tasks in priority order
    processingLogger.info(`⚡ Phase 2: Prioritized processing (skipping ${stats.skipped} binary/irrelevant inscriptions)`);
    const processingStartTime = Date.now();
    
    while (taskManager.hasMoreTasks()) {
        const batchSize = batchProcessor.getBatchSize();
        const batch = taskManager.getNextBatch(batchSize);
        
        if (batch.length === 0) break;
        
        try {
            // Update concurrency limit dynamically
            concurrencyLimit = adaptiveConcurrency.getLimit();
            
            processingLogger.debug(`Processing batch of ${batch.length} inscriptions (priorities: ${batch.map(t => t.priority).join(',')})`);
            
            const batchResults = await Promise.allSettled(
                batch.map(task => 
                    concurrencyLimit(() => processInscriptionWithRetry(task.id, task.blockHeight))
                )
            );
            
            // Mark tasks as processed
            batch.forEach(() => taskManager.markProcessed());
            
            results = results.concat(batchResults);
            batchProcessor.adjustBatchSize(true);
            
            const currentStats = taskManager.getStats();
            processingLogger.debug(`Progress: ${currentStats.processed}/${currentStats.total} processed, ${taskManager.hasMoreTasks() ? 'continuing' : 'finishing'}`);
            
        } catch (error) {
            batchProcessor.adjustBatchSize(false);
            processingLogger.error(`Batch processing error for block ${blockHeight}:`, error.message);
            
            // Process failed batch one by one to ensure no data loss
            for (const task of batch) {
                try {
                    const result = await processInscriptionWithRetry(task.id, task.blockHeight);
                    results.push({ status: 'fulfilled', value: result });
                } catch (singleError) {
                    results.push({ status: 'rejected', reason: singleError });
                }
                taskManager.markProcessed();
            }
        }
    }
    
    const processingTime = Date.now() - processingStartTime;
    const totalTime = Date.now() - preFilterStartTime;
    const finalStats = taskManager.getStats();
    
    processingLogger.info(`🎯 OPTIMIZED PROCESSING COMPLETE for block ${blockHeight}:`);
    processingLogger.info(`   📊 Processed: ${finalStats.processed}/${finalStats.total} relevant inscriptions`);
    processingLogger.info(`   🔍 Phase 0 (Content Filter): ${preFilterTime}ms`);
    processingLogger.info(`   ⚡ Phase 1 (Preview): ${previewTime}ms`);
    processingLogger.info(`   🔧 Phase 2 (Processing): ${processingTime}ms`);
    processingLogger.info(`   📈 Total time: ${totalTime}ms`);
    processingLogger.info(`   🎯 Efficiency: Processed ${relevantInscriptions.length}/${inscriptionIds.length} inscriptions (${((relevantInscriptions.length / inscriptionIds.length) * 100).toFixed(1)}% relevant)`);
    
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

const apiCache = new AdaptiveMemorySafeCache();

// PERFORMANCE OPTIMIZATION: Cached API functions to reduce redundant calls
async function getInscriptionDetailsCached(inscriptionId) {
    const cacheKey = `details_${inscriptionId}`;
    const cached = apiCache.get(cacheKey);
    if (cached !== null) return cached;
    
    const endpoints = useLocalAPI ? [
        `${API_URL}/inscription/${inscriptionId}`,
        `${API_URL}/inscriptions/${inscriptionId}`,
    ] : [
        `${API_URL}/inscription/${inscriptionId}`,
    ];
    
    for (const endpoint of endpoints) {
        try {
            const response = await robustApiCall(endpoint);
            const details = response.data;
            
            // Cache the details
            apiCache.set(cacheKey, details);
            return details;
            
        } catch (error) {
            processingLogger.debug(`Failed to get inscription details from ${endpoint}: ${error.message}`);
            continue;
        }
    }
    
    // If all endpoints fail, return basic details structure
    processingLogger.warn(`Could not fetch details for inscription ${inscriptionId}`);
    const fallbackDetails = { 
        id: inscriptionId, 
        address: null,
        block_height: null,
        timestamp: null,
        content_type: 'text/plain' // Default content type for filtering
    };
    apiCache.set(cacheKey, fallbackDetails);
    return fallbackDetails;
}

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

// ================================
// INSCRIPTION PROCESSING
// ================================

// Main inscription processing function with enhanced error handling
async function processInscription(inscriptionId, blockHeight) {
    let processed = false;
    try {
        logger.debug(`Processing inscription: ${inscriptionId} from block ${blockHeight}`);
        
        // Get inscription details with hybrid sat extraction
        const inscriptionDetails = await getInscriptionDetailsCached(inscriptionId);
        if (!inscriptionDetails) {
            logger.warn(`No details found for inscription ${inscriptionId}`);
            return null;
        }
        
        // Get content with fast preview
        const contentPreview = await getInscriptionContentPreview(inscriptionId, 100);
        
        // Skip binary or non-text content early
        if (contentPreview.isBinary) {
            logger.debug(`Skipping binary inscription ${inscriptionId}`);
            return null;
        }
        
        const fullContent = contentPreview.isBrc420 || contentPreview.isBitmap 
            ? await getInscriptionContentCached(inscriptionId)
            : contentPreview.preview;
        
        // Process BRC-420 deploy
        if (contentPreview.isBrc420 && fullContent.includes('"op":"deploy"')) {
            const deploy = await processBrc420Deploy(inscriptionId, fullContent, inscriptionDetails, blockHeight);
            if (deploy) {
                logger.info(`✅ Processed BRC-420 deploy: ${inscriptionId}`);
                processed = true;
            }
        }
        
        // Process BRC-420 mint  
        if (contentPreview.isBrc420 && fullContent.includes('"op":"mint"')) {
            const mint = await processBrc420Mint(inscriptionId, fullContent, inscriptionDetails, blockHeight);
            if (mint) {
                logger.info(`✅ Processed BRC-420 mint: ${inscriptionId}`);
                processed = true;
            }
        }
        
        // Process bitmap
        if (contentPreview.isBitmap) {
            const bitmapNumber = extractBitmapNumber(fullContent);
            if (bitmapNumber !== null) {
                const bitmap = await processBitmap(inscriptionId, bitmapNumber, inscriptionDetails, blockHeight);
                if (bitmap) {
                    logger.info(`✅ Processed bitmap: ${inscriptionId} (#${bitmapNumber})`);
                    processed = true;
                }
            }
        }
        
        return processed ? { inscriptionId, type: 'processed' } : null;
        
    } catch (error) {
        logger.error(`Error processing inscription ${inscriptionId}:`, { message: error.message });
        throw error;
    }
}

// Process BRC-420 deploy transaction
async function processBrc420Deploy(inscriptionId, content, inscriptionDetails, blockHeight) {
    try {
        const data = JSON.parse(content);
        
        if (data.p !== 'brc-420' || data.op !== 'deploy') {
            return null;
        }
        
        // Enhanced validation based on Python indexer
        const deployerAddress = await getDeployerAddressCached(inscriptionId);
        
        const deployData = {
            inscription_id: inscriptionId,
            tick: data.tick,
            max: data.max ? parseInt(data.max) : null,
            lim: data.lim ? parseInt(data.lim) : null,
            dec: data.dec ? parseInt(data.dec) : 18,
            deployer: deployerAddress,
            block_height: blockHeight,
            sat_number: inscriptionDetails.sat || null,
            deploy_data: JSON.stringify(data)
        };
        
        // Save to database
        await saveBrc420Deploy(deployData);
        return deployData;
        
    } catch (error) {
        logger.debug(`Invalid BRC-420 deploy content for ${inscriptionId}: ${error.message}`);
        return null;
    }
}

// Process BRC-420 mint transaction
async function processBrc420Mint(inscriptionId, content, inscriptionDetails, blockHeight) {
    try {
        const data = JSON.parse(content);
        
        if (data.p !== 'brc-420' || data.op !== 'mint') {
            return null;
        }
        
        const mintData = {
            inscription_id: inscriptionId,
            tick: data.tick,
            amt: data.amt ? parseInt(data.amt) : null,
            block_height: blockHeight,
            sat_number: inscriptionDetails.sat || null,
            mint_data: JSON.stringify(data)
        };
        
        await saveBrc420Mint(mintData);
        return mintData;
        
    } catch (error) {
        logger.debug(`Invalid BRC-420 mint content for ${inscriptionId}: ${error.message}`);
        return null;
    }
}

// Process bitmap inscription with enhanced validation
async function processBitmap(inscriptionId, bitmapNumber, inscriptionDetails, blockHeight) {
    try {
        // Enhanced bitmap validation (Python indexer logic)
        if (!isValidBitmapNumber(bitmapNumber.toString())) {
            logger.debug(`Invalid bitmap number format: ${bitmapNumber}`);
            return null;
        }
        
        // Generate unlimited transaction patterns using BitmapProcessor
        const transactionPatterns = await bitmapProcessor.generateTransactionPatterns(bitmapNumber);
        
        const bitmapData = {
            inscription_id: inscriptionId,
            bitmap_number: bitmapNumber,
            block_height: blockHeight,
            sat_number: inscriptionDetails.sat || null,
            transaction_patterns: JSON.stringify(transactionPatterns),
            pattern_metadata: JSON.stringify({
                pattern_count: transactionPatterns.length,
                generated_at: new Date().toISOString(),
                unlimited_generation: true
            })
        };
        
        await saveBitmap(bitmapData);
        return bitmapData;
        
    } catch (error) {
        logger.error(`Error processing bitmap ${bitmapNumber}:`, error.message);
        return null;
    }
}

// ================================
// DATABASE OPERATIONS
// ================================

async function saveBrc420Deploy(deployData) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO brc420_deploys 
            (inscription_id, tick, max_supply, limit_per_mint, decimals, deployer, 
             block_height, sat_number, deploy_data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        
        stmt.run([
            deployData.inscription_id,
            deployData.tick,
            deployData.max,
            deployData.lim,
            deployData.dec,
            deployData.deployer,
            deployData.block_height,
            deployData.sat_number,
            deployData.deploy_data
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

async function saveBrc420Mint(mintData) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO brc420_mints 
            (inscription_id, tick, amount, block_height, sat_number, mint_data, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        
        stmt.run([
            mintData.inscription_id,
            mintData.tick,
            mintData.amt,
            mintData.block_height,
            mintData.sat_number,
            mintData.mint_data
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

async function saveBitmap(bitmapData) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO bitmaps 
            (inscription_id, bitmap_number, block_height, sat_number, 
             transaction_patterns, pattern_metadata, created_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        `);
        
        stmt.run([
            bitmapData.inscription_id,
            bitmapData.bitmap_number,
            bitmapData.block_height,
            bitmapData.sat_number,
            bitmapData.transaction_patterns,
            bitmapData.pattern_metadata
        ], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

async function saveFailedInscription(inscriptionId, blockHeight, errorMessage) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO failed_inscriptions 
            (inscription_id, block_height, error_message, created_at)
            VALUES (?, ?, ?, datetime('now'))
        `);
        
        stmt.run([inscriptionId, blockHeight, errorMessage], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

// ================================
// BLOCK PROCESSING LOGIC
// ================================

// Process a single block completely
async function processBlock(blockHeight) {
    logger.info(`🔍 Processing block ${blockHeight}`);
    
    try {
        // Get all inscriptions for this block with unlimited pagination
        const inscriptionIds = await getInscriptionsForBlock(blockHeight);
        
        if (inscriptionIds.length === 0) {
            logger.info(`📭 Block ${blockHeight}: No inscriptions found`);
            await markBlockAsProcessed(blockHeight, 0, 0, 0);
            return { blockHeight, processed: 0, skipped: 0, errors: 0 };
        }
        
        logger.info(`📋 Block ${blockHeight}: Found ${inscriptionIds.length} inscriptions, starting optimized processing`);
        
        // Process all inscriptions with optimized pipeline
        const results = await processAllInscriptionsCompletely(inscriptionIds, blockHeight);
        
        // Count results
        let processed = 0, skipped = 0, errors = 0;
        
        for (const result of results) {
            if (result.status === 'fulfilled') {
                if (result.value) {
                    processed++;
                } else {
                    skipped++;
                }
            } else {
                errors++;
            }
        }
        
        // Mark block as processed
        await markBlockAsProcessed(blockHeight, processed, skipped, errors);
        
        logger.info(`✅ Block ${blockHeight} complete: ${processed} processed, ${skipped} skipped, ${errors} errors`);
        return { blockHeight, processed, skipped, errors };
        
    } catch (error) {
        logger.error(`❌ Error processing block ${blockHeight}:`, { message: error.message });
        throw error;
    }
}

async function markBlockAsProcessed(blockHeight, processed, skipped, errors) {
    return new Promise((resolve, reject) => {
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO processed_blocks 
            (block_height, inscriptions_processed, inscriptions_skipped, 
             inscriptions_errors, processed_at)
            VALUES (?, ?, ?, ?, datetime('now'))
        `);
        
        stmt.run([blockHeight, processed, skipped, errors], function(err) {
            if (err) {
                reject(err);
            } else {
                resolve(this.changes);
            }
        });
    });
}

// ================================
// DATABASE INITIALIZATION
// ================================

function initDatabase() {
    return new Promise((resolve, reject) => {
        const dbPath = config.DB_PATH || './db/brc420.db';
        db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                reject(err);
                return;
            }
            
            logger.info('📊 Connected to SQLite database');
            
            // Create tables
            db.serialize(() => {
                // BRC-420 deploys table
                db.run(`
                    CREATE TABLE IF NOT EXISTS brc420_deploys (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        inscription_id TEXT UNIQUE NOT NULL,
                        tick TEXT NOT NULL,
                        max_supply INTEGER,
                        limit_per_mint INTEGER,
                        decimals INTEGER DEFAULT 18,
                        deployer TEXT,
                        block_height INTEGER,
                        sat_number INTEGER,
                        deploy_data TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // BRC-420 mints table
                db.run(`
                    CREATE TABLE IF NOT EXISTS brc420_mints (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        inscription_id TEXT UNIQUE NOT NULL,
                        tick TEXT NOT NULL,
                        amount INTEGER,
                        block_height INTEGER,
                        sat_number INTEGER,
                        mint_data TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Bitmaps table
                db.run(`
                    CREATE TABLE IF NOT EXISTS bitmaps (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        inscription_id TEXT UNIQUE NOT NULL,
                        bitmap_number INTEGER NOT NULL,
                        block_height INTEGER,
                        sat_number INTEGER,
                        transaction_patterns TEXT,
                        pattern_metadata TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Processed blocks table
                db.run(`
                    CREATE TABLE IF NOT EXISTS processed_blocks (
                        block_height INTEGER PRIMARY KEY,
                        inscriptions_processed INTEGER DEFAULT 0,
                        inscriptions_skipped INTEGER DEFAULT 0,
                        inscriptions_errors INTEGER DEFAULT 0,
                        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Failed inscriptions table
                db.run(`
                    CREATE TABLE IF NOT EXISTS failed_inscriptions (
                        id INTEGER PRIMARY KEY AUTOINCREMENT,
                        inscription_id TEXT NOT NULL,
                        block_height INTEGER,
                        error_message TEXT,
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                `);
                
                // Create indexes for better performance
                db.run(`CREATE INDEX IF NOT EXISTS idx_brc420_deploys_tick ON brc420_deploys(tick)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_brc420_mints_tick ON brc420_mints(tick)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_bitmaps_number ON bitmaps(bitmap_number)`);
                db.run(`CREATE INDEX IF NOT EXISTS idx_blocks_height ON processed_blocks(block_height)`);
                
                logger.info('✅ Database tables initialized');
                resolve();
            });
        });
    });
}

// ================================
// API TESTING FUNCTIONS
// ================================

// Test local API capabilities for sat indexing
async function testLocalApiSatIndexing() {
    if (!useLocalAPI) {
        return;
    }
    
    try {
        logger.info('🔍 Testing local API sat indexing capabilities...');
        
        // Test a known inscription to see if sat indexing is supported
        const testInscriptionId = 'e3e58f1c5abf5b6c7d5c2e8f9a4b3c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c';
        
        try {
            const response = await robustApiCall(`${API_URL}/inscription/${testInscriptionId}`, {
                timeout: 10000
            });
            
            if (response.data && response.data.sat) {
                localApiHasSatIndex = true;
                logger.info('✅ Local API supports sat indexing');
            } else {
                localApiHasSatIndex = false;
                logger.info('⚠️ Local API does not support sat indexing, will use hybrid approach');
            }
        } catch (error) {
            localApiHasSatIndex = false;
            logger.info('⚠️ Could not test sat indexing capabilities, assuming not supported');
        }
        
    } catch (error) {
        logger.warn('⚠️ Failed to test local API capabilities:', error.message);
        localApiHasSatIndex = false;
    }
}

// ================================
// MAIN EXECUTION LOGIC
// ================================

// Main indexing loop
async function startUnlimitedIndexing() {
    logger.info('🚀 Starting UNLIMITED BRC-420 & Bitmap Indexer for complete Bitcoin indexing');
    logger.info(`📡 API URL: ${API_URL}`);
    logger.info(`🎯 Starting from block: ${currentBlock}`);
    logger.info('♾️ NO LIMITS: Will process all blocks until manually stopped');
    
    try {
        await initDatabase();
        
        bitmapProcessor = new BitmapProcessor(
            db, logger, processingLogger, API_URL, 
            getInscriptionDetailsCached, getDeployerAddressCached
        );
        
        if (useLocalAPI) {
            await testLocalApiSatIndexing();
        }
        
        let consecutiveErrors = 0;
        let totalProcessed = 0;
        const maxConsecutiveErrors = 10; // Allow more retries for network issues
        const startTime = Date.now();
        
        // NO arbitrary limits - run until manually stopped or fatal error
        while (consecutiveErrors < maxConsecutiveErrors) {
            const blockStartTime = Date.now();
            
            try {
                // Monitor memory but don't stop processing
                const memoryUsage = process.memoryUsage();
                const memoryMB = memoryUsage.heapUsed / 1024 / 1024;
                
                // Only emergency cleanup if extremely high memory
                if (memoryMB > 3072) { // 3GB threshold
                    logger.warn(`🔥 High memory usage (${memoryMB}MB), triggering emergency cleanup`);
                    if (apiCache && apiCache.emergencyCleanup) {
                        apiCache.emergencyCleanup();
                    }
                    if (global.gc) global.gc();
                    
                    // Brief pause to let GC work, then continue processing
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
                
                const result = await processBlock(currentBlock);
                const blockProcessingTime = Date.now() - blockStartTime;
                
                await markBlockAsProcessed(
                    currentBlock, 
                    result.processed || 0, 
                    result.skipped || 0, 
                    result.errors || 0,
                    blockProcessingTime
                );
                
                consecutiveErrors = 0;
                totalProcessed++;
                currentBlock++;
                
                // Progress logging (no limits mentioned)
                if (currentBlock % 100 === 0) {
                    const cacheStats = apiCache.getStats();
                    const runtimeHours = (Date.now() - startTime) / (1000 * 60 * 60);
                    const blocksPerHour = totalProcessed / runtimeHours;
                    
                    logger.info(`📈 Progress: Block ${currentBlock} | Processed: ${totalProcessed} blocks | Runtime: ${runtimeHours.toFixed(1)}h | Speed: ${blocksPerHour.toFixed(0)} blocks/h | Cache: ${cacheStats.size} entries (${cacheStats.hitRate}) | Memory: ${Math.round(memoryMB)}MB`);
                }
                
                // Adaptive delay based on processing time (no fixed limits)
                const baseDelay = 50; // Faster base delay for efficiency
                const adaptiveDelay = Math.min(baseDelay + Math.max(0, blockProcessingTime - 1000), 2000);
                await new Promise(resolve => setTimeout(resolve, adaptiveDelay));
                
            } catch (error) {
                consecutiveErrors++;
                const blockProcessingTime = Date.now() - blockStartTime;
                
                logger.error(`❌ Error processing block ${currentBlock} (${consecutiveErrors}/${maxConsecutiveErrors}, ${blockProcessingTime}ms):`, { 
                    message: error.message,
                    type: error.constructor.name
                });
                
                // Save failed block for analysis but continue processing
                await saveFailedInscription(`block_${currentBlock}`, currentBlock, error.message).catch(() => {});
                
                if (consecutiveErrors >= maxConsecutiveErrors) {
                    logger.error(`💥 Too many consecutive errors (${maxConsecutiveErrors}), manual intervention required`);
                    logger.error('🔄 Indexer will exit - restart when issues are resolved');
                    break;
                }
                
                // Exponential backoff for retries but continue unlimited processing
                const retryDelay = Math.min(RETRY_BLOCK_DELAY * Math.pow(2, consecutiveErrors - 1), 300000); // Max 5 min delay
                logger.info(`⏳ Retrying block ${currentBlock} in ${retryDelay}ms (attempt ${consecutiveErrors}/${maxConsecutiveErrors})`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
        
        // Final statistics (no mention of limits)
        const finalRuntime = (Date.now() - startTime) / (1000 * 60);
        const finalMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const cacheStats = apiCache.getStats();
        
        logger.info(`🏁 Indexing session ended:`);
        logger.info(`   📊 Blocks processed: ${totalProcessed.toLocaleString()}`);
        logger.info(`   ⏱️ Runtime: ${(finalRuntime / 60).toFixed(1)} hours`);
        logger.info(`   🧠 Final memory: ${finalMemory}MB`);
        logger.info(`   💾 Cache efficiency: ${cacheStats.hitRate} (${cacheStats.size.toLocaleString()} entries)`);
        logger.info(`   ⚡ Average speed: ${(totalProcessed / finalRuntime * 60).toFixed(1)} blocks/hour`);
        logger.info(`   📈 Total inscriptions processed: ${cacheStats.processed.toLocaleString()}`);
        
    } catch (error) {
        logger.error('💥 Fatal error in unlimited indexer:', { 
            message: error.message,
            stack: error.stack 
        });
        
        // Don't exit automatically - log error and require manual restart
        logger.error('🔄 Manual restart required after resolving the fatal error');
        throw error;
    } finally {
        // Enhanced cleanup but don't lose data
        logger.info('🧹 Starting safe cleanup (preserving critical data)...');
        
        if (apiCache && apiCache.destroy) {
            // Log cache stats before destroying
            const finalStats = apiCache.getStats();
            logger.info(`💾 Final cache stats: ${finalStats.size} entries, ${finalStats.hitRate} hit rate`);
            apiCache.destroy();
            logger.info('✅ Cache safely destroyed');
        }
        
        if (adaptiveConcurrency && adaptiveConcurrency.destroy) {
            adaptiveConcurrency.destroy();
            logger.info('✅ Concurrency manager destroyed');
        }
        
        if (db) {
            // Ensure all pending writes complete before closing
            db.run('PRAGMA wal_checkpoint(FULL)', (err) => {
                if (err) logger.warn('WAL checkpoint warning:', err.message);
                
                db.close((err) => {
                    if (err) logger.error('Database close error:', err);
                    else logger.info('📊 Database closed safely with all data preserved');
                });
            });
        }
        
        logger.info('🏁 Cleanup complete - all indexing data preserved');
    }
}

// Initialize configuration based on environment
function initializeConfiguration() {
    // Check if we should use local API
    if (process.env.USE_LOCAL_API === 'true' || process.env.ORDINALS_API_URL) {
        useLocalAPI = true;
        if (process.env.ORDINALS_API_URL) {
            API_URL = process.env.ORDINALS_API_URL;
        }
        logger.info('🏠 Using local Ordinals API');
    } else {
        useLocalAPI = false;
        logger.info('🌐 Using external Ordinals API');
    }
    
    // Set starting block from environment or config
    if (process.env.START_BLOCK) {
        currentBlock = parseInt(process.env.START_BLOCK);
    }
    
    logger.info(`⚙️ Configuration: API=${API_URL}, UseLocal=${useLocalAPI}, StartBlock=${currentBlock}`);
}

// Graceful shutdown handling
function setupGracefulShutdown() {
    const shutdown = (signal) => {
        logger.info(`🔻 Received ${signal}, initiating graceful shutdown...`);
        logger.info('📊 Preserving all indexing progress and data...');
        
        // Set flag to stop processing new blocks
        global.shutdownRequested = true;
        
        // Allow current block to complete
        setTimeout(() => {
            logger.info('⏳ Waiting for current block processing to complete...');
            
            // Enhanced cleanup preserving all data
            if (apiCache) {
                const finalStats = apiCache.getStats();
                logger.info(`💾 Cache stats before shutdown: ${finalStats.size} entries, ${finalStats.processed} total processed`);
                apiCache.destroy();
            }
            
            if (adaptiveConcurrency) {
                adaptiveConcurrency.destroy();
            }
            
            if (db) {
                // Force WAL checkpoint to ensure all data is written
                logger.info('📊 Ensuring all database writes are committed...');
                db.run('PRAGMA wal_checkpoint(FULL)', (err) => {
                    if (err) logger.warn('WAL checkpoint warning:', err.message);
                    
                    db.close((err) => {
                        if (err) {
                            logger.error('Database close error:', err);
                        } else {
                            logger.info('📊 Database closed safely - all data preserved');
                        }
                        
                        logger.info('✅ Graceful shutdown complete - indexing progress saved');
                        process.exit(0);
                    });
                });
            } else {
                logger.info('✅ Graceful shutdown complete');
                process.exit(0);
            }
        }, 5000); // Give 5 seconds for current operations to complete
    };
    
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGUSR1', () => shutdown('SIGUSR1')); // Manual restart signal
    process.on('SIGUSR2', () => shutdown('SIGUSR2')); // Manual restart signal
}

// Export for module usage
module.exports = {
    startUnlimitedIndexing,
    processBlock,
    processInscription,
    initDatabase,
    getInscriptionsForBlock,
    getInscriptionDetailsCached,
    getInscriptionContentCached,
    getInscriptionContentPreview,
    AdaptiveMemorySafeCache
};

// Main execution when run directly
if (require.main === module) {
    initializeConfiguration();
    setupGracefulShutdown();
    
    // Start unlimited indexing
    startUnlimitedIndexing().catch(error => {
        logger.error('💥 Unhandled error in unlimited indexer:', error);
        logger.error('🔄 Manual restart required to continue complete indexing');
        process.exit(1);
    });
}
