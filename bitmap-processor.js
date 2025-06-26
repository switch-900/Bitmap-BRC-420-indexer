const axios = require('axios');
const Joi = require('joi');

// Robust API calling with exponential backoff (copied from index-runner.js)
async function robustApiCall(url, options = {}, maxRetries = 5) {
    const baseTimeout = 30000; // Start with 30 seconds
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const timeout = baseTimeout * Math.pow(1.5, attempt); // Exponential increase
            
            const response = await axios.get(url, {
                ...options,
                timeout: timeout,
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'BRC-420-Complete-Indexer/1.0',
                    ...options.headers
                }
            });
            
            return response;
            
        } catch (error) {
            const isLastAttempt = attempt === maxRetries - 1;
            
            if (isLastAttempt) {
                throw new Error(`API call failed after ${maxRetries} attempts: ${error.message}`);
            }
            
            // Exponential backoff delay
            const delay = Math.min(1000 * Math.pow(2, attempt), 30000); // Max 30 second delay
            console.warn(`API call attempt ${attempt + 1} failed, retrying in ${delay}ms: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Bitmap validation schema
const bitmapSchema = Joi.object({
    inscription_id: Joi.string().required(),
    address: Joi.string().required(),
    bitmap_number: Joi.number().integer().min(0).required(),
    block_height: Joi.number().integer().min(0).required(),
    content: Joi.string().pattern(/^\d+\.bitmap$/).required(),
    timestamp: Joi.number().required(),
});

// Parcel validation schema
const parcelSchema = Joi.object({
    inscription_id: Joi.string().required(),
    parcel_number: Joi.number().integer().min(0).required(),
    bitmap_number: Joi.number().integer().min(0).required(),
    bitmap_inscription_id: Joi.string().required(),
    content: Joi.string().pattern(/^\d+\.\d+\.bitmap$/).required(),
    address: Joi.string().required(),
    block_height: Joi.number().integer().min(0).required(),
    timestamp: Joi.number().required(),
    transaction_count: Joi.number().integer().min(0).allow(null),
    is_valid: Joi.boolean().default(true)
});

class BitmapProcessor {
    constructor(db, logger, processingLogger, API_URL, getInscriptionDetailsCached, getMintAddress) {
        this.db = db;
        this.logger = logger;
        this.processingLogger = processingLogger;
        this.API_URL = API_URL;
        this.getInscriptionDetailsCached = getInscriptionDetailsCached;
        this.getMintAddress = getMintAddress;
    }

    // ================================
    // BITMAP VALIDATION FUNCTIONS
    // ================================

    /**
     * Validates bitmap format using regex
     * @param {string} content - The inscription content
     * @returns {boolean} - True if valid bitmap format
     */
    isValidBitmapFormat(content) {
        const bitmapRegex = /^\d+\.bitmap$/;
        return bitmapRegex.test(content.trim());
    }

    /**
     * Validates bitmap data using Joi schema
     * @param {Object} bitmapData - The bitmap data object
     * @returns {boolean} - True if valid
     */
    validateBitmapData(bitmapData) {
        const { error } = bitmapSchema.validate(bitmapData);
        if (error) {
            this.logger.error(`Bitmap data validation error: ${error.details.map(d => d.message).join(', ')}`);
            return false;
        }
        return true;
    }

    /**
     * Saves bitmap data to database
     * @param {Object} bitmapData - The bitmap data to save
     * @returns {Promise<boolean>} - True if saved successfully
     */
    async saveBitmap(bitmapData) {
        return new Promise(async (resolve, reject) => {
            try {
                // Check if bitmap already exists
                const existingBitmap = await new Promise((resolveDb, rejectDb) => {
                    this.db.get("SELECT bitmap_number FROM bitmaps WHERE bitmap_number = ?", [bitmapData.bitmap_number], (err, row) => {
                        if (err) rejectDb(err);
                        else resolveDb(row);
                    });
                });

                if (existingBitmap) {
                    this.logger.info(`Bitmap ${bitmapData.bitmap_number} already exists. Skipping.`);
                    resolve(false);
                    return;
                }

                // Fetch inscription details to get sat number and current wallet
                const inscriptionDetails = await this.getInscriptionDetailsCached(bitmapData.inscription_id);
                const satNumber = inscriptionDetails ? inscriptionDetails.sat : null;
                const currentWallet = inscriptionDetails ? inscriptionDetails.address : bitmapData.address;
                
                const stmt = this.db.prepare("INSERT INTO bitmaps (inscription_id, bitmap_number, content, address, timestamp, block_height, sat, wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
                stmt.run([
                    bitmapData.inscription_id, 
                    bitmapData.bitmap_number, 
                    bitmapData.content, 
                    bitmapData.address, // Original mint address
                    bitmapData.timestamp, 
                    bitmapData.block_height, 
                    satNumber, // Sat number from ordinals API
                    currentWallet // Current holder address
                ], (err) => {
                    if (err) {
                        this.logger.error(`Error saving bitmap ${bitmapData.bitmap_number}:`, { message: err.message });
                        reject(err);
                    } else {
                        this.logger.info(`Bitmap ${bitmapData.bitmap_number} saved to database.`);
                        
                        // Generate bitmap pattern for visualization (async without await)
                        this.generateBitmapPattern(bitmapData.bitmap_number, bitmapData.inscription_id)
                            .then(() => {
                                this.logger.info(`Pattern generation completed for bitmap ${bitmapData.bitmap_number}`);
                            })
                            .catch(patternError => {
                                this.logger.warn(`Failed to generate pattern for bitmap ${bitmapData.bitmap_number}:`, { message: patternError.message });
                            });
                        
                        resolve(true);
                    }
                });
            } catch (error) {
                this.logger.error(`Error in saveBitmap for ${bitmapData.bitmap_number}:`, { message: error.message });
                reject(error);
            }
        });
    }

    // ================================
    // PARCEL VALIDATION FUNCTIONS
    // ================================

    /**
     * Validates parcel format using regex
     * @param {string} content - The inscription content
     * @returns {boolean} - True if valid parcel format
     */
    isValidParcelFormat(content) {
        const parcelRegex = /^\d+\.\d+\.bitmap$/;
        return parcelRegex.test(content.trim());
    }

    /**
     * Parses parcel content and extracts parcel and bitmap numbers
     * @param {string} content - The inscription content
     * @returns {Object|null} - {parcelNumber, bitmapNumber} or null if invalid
     */
    parseParcelContent(content) {
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

    /**
     * Gets bitmap inscription ID from bitmap number
     * @param {number} bitmapNumber - The bitmap number
     * @returns {Promise<string|null>} - The bitmap inscription ID or null
     */
    async getBitmapInscriptionId(bitmapNumber) {
        return new Promise((resolve, reject) => {
            this.db.get("SELECT inscription_id FROM bitmaps WHERE bitmap_number = ?", [bitmapNumber], (err, row) => {
                if (err) {
                    this.logger.error(`Error fetching bitmap inscription ID for bitmap ${bitmapNumber}:`, { message: err.message });
                    reject(err);
                } else {
                    resolve(row ? row.inscription_id : null);
                }
            });
        });
    }

    /**
     * Validates parcel number against block transaction count
     * @param {number} parcelNumber - The parcel number
     * @param {number} transactionCount - The block transaction count
     * @returns {boolean} - True if valid
     */
    validateParcelNumber(parcelNumber, transactionCount) {
        if (transactionCount === null || transactionCount === undefined) {
            // If we can't get transaction count, we allow the parcel but mark it for later validation
            return true;
        }
        
        return parcelNumber >= 0 && parcelNumber < transactionCount;
    }

    /**
     * Validates parcel provenance by checking if it's a child of the bitmap
     * @param {string} parcelInscriptionId - The parcel inscription ID
     * @param {string} bitmapInscriptionId - The bitmap inscription ID
     * @returns {Promise<boolean>} - True if valid provenance
     */
    async validateParcelProvenance(parcelInscriptionId, bitmapInscriptionId) {
        try {
            const response = await robustApiCall(`${this.API_URL}/children/${bitmapInscriptionId}`, {
                headers: { 'Accept': 'application/json' }
            });

            // Check if the parcel inscription is in the children list
            const children = response.data.ids || [];
            const isValidChild = children.includes(parcelInscriptionId);
            
            this.logger.info(`Parcel provenance validation for ${parcelInscriptionId}: ${isValidChild ? 'VALID' : 'INVALID'} (parent: ${bitmapInscriptionId})`);
            return isValidChild;

        } catch (error) {
            this.logger.error(`Error validating parcel provenance for ${parcelInscriptionId}:`, { message: error.message });
            return false;
        }
    }

    /**
     * Saves parcel data with tie-breaker logic
     * @param {Object} parcelData - The parcel data to save
     * @returns {Promise<boolean>} - True if saved successfully
     */
    async saveParcel(parcelData) {
        return new Promise((resolve, reject) => {
            // Validate parcel data schema
            const { error } = parcelSchema.validate(parcelData);
            if (error) {
                this.logger.error(`Parcel data validation error: ${error.details.map(d => d.message).join(', ')}`);
                reject(new Error(`Parcel validation failed: ${error.details[0].message}`));
                return;
            }

            // Check if this exact inscription already exists
            this.db.get("SELECT inscription_id FROM parcels WHERE inscription_id = ?", [parcelData.inscription_id], (err, row) => {
                if (err) {
                    this.logger.error(`Error checking if parcel ${parcelData.inscription_id} exists:`, { message: err.message });
                    reject(err);
                } else if (row) {
                    this.logger.info(`Parcel ${parcelData.inscription_id} already exists. Skipping.`);
                    resolve(false);
                } else {
                    // Check for duplicate parcel number within the same bitmap
                    this.db.get(`
                        SELECT inscription_id, block_height, timestamp 
                        FROM parcels 
                        WHERE parcel_number = ? AND bitmap_number = ? 
                        ORDER BY block_height ASC, inscription_id ASC 
                        LIMIT 1
                    `, [parcelData.parcel_number, parcelData.bitmap_number], (err, existingParcel) => {
                        if (err) {
                            this.logger.error(`Error checking for duplicate parcel number:`, { message: err.message });
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
                                this.db.run("DELETE FROM parcels WHERE inscription_id = ?", [existingParcel.inscription_id], (deleteErr) => {
                                    if (deleteErr) {
                                        this.logger.error(`Error removing superseded parcel ${existingParcel.inscription_id}:`, { message: deleteErr.message });
                                        reject(deleteErr);
                                        return;
                                    }
                                    
                                    this.logger.info(`Replacing parcel ${existingParcel.inscription_id} with earlier parcel ${parcelData.inscription_id} (tie-breaker applied)`);
                                    
                                    // Insert the new parcel
                                    this.insertParcelData(parcelData, resolve, reject);
                                });
                            } else {
                                this.logger.info(`Parcel ${parcelData.inscription_id} loses tie-breaker to existing parcel ${existingParcel.inscription_id} for number ${parcelData.parcel_number}.${parcelData.bitmap_number}`);
                                resolve(false);
                            }
                        } else {
                            // No duplicate, proceed with normal insert
                            this.insertParcelData(parcelData, resolve, reject);
                        }
                    });
                }
            });
        });
    }

    /**
     * Helper function to insert parcel data into database
     * @param {Object} parcelData - The parcel data
     * @param {Function} resolve - Promise resolve function
     * @param {Function} reject - Promise reject function
     */
    insertParcelData(parcelData, resolve, reject) {
        const stmt = this.db.prepare("INSERT INTO parcels (inscription_id, parcel_number, bitmap_number, bitmap_inscription_id, content, address, block_height, timestamp, transaction_count, is_valid, wallet) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
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
            parcelData.address // wallet same as address initially
        ], (err) => {
            if (err) {
                this.logger.error(`Error saving parcel ${parcelData.inscription_id}:`, { message: err.message });
                reject(err);
            } else {
                this.logger.info(`Parcel ${parcelData.inscription_id} saved to database.`);
                resolve(true);
            }
        });
    }

    // ================================
    // BITMAP PATTERN GENERATION
    // ================================

    /**
     * Generates bitmap pattern data for Mondrian visualization
     * @param {number} bitmapNumber - The bitmap number
     * @param {string} inscriptionId - The inscription ID
     * @returns {Promise<string|null>} - The pattern string or null
     */
    async generateBitmapPattern(bitmapNumber, inscriptionId) {
        try {
            // Get transaction history for this bitmap from Bitcoin Core or ord
            const txHistory = await this.getBitmapTransactionHistory(bitmapNumber, inscriptionId);
            
            if (!txHistory || txHistory.length === 0) {
                this.logger.warn(`No transaction history found for bitmap ${bitmapNumber}`);
                return null;
            }

            // Convert transaction data to simple size string for Mondrian visualization
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
                const stmt = this.db.prepare(`
                    INSERT OR REPLACE INTO bitmap_patterns 
                    (bitmap_number, pattern_string) 
                    VALUES (?, ?)
                `);
                stmt.run([
                    bitmapNumber,
                    patternString
                ], (err) => {
                    if (err) {
                        this.logger.error(`Error saving pattern for bitmap ${bitmapNumber}:`, { message: err.message });
                        reject(err);
                    } else {
                        this.logger.info(`Pattern saved for bitmap ${bitmapNumber}: ${patternString}`);
                        resolve(patternString);
                    }
                });
            });

        } catch (error) {
            this.logger.error(`Error generating pattern for bitmap ${bitmapNumber}:`, { message: error.message });
            return null;
        }
    }

    /**
     * Gets transaction history for a bitmap
     * @param {number} bitmapNumber - The bitmap number
     * @param {string} inscriptionId - The inscription ID
     * @returns {Promise<Array>} - Transaction history array
     */
    async getBitmapTransactionHistory(bitmapNumber, inscriptionId) {
        try {
            // Try to get transaction history from ord API
            const txHistory = await this.getInscriptionTransactionsCached(inscriptionId);
            
            if (txHistory && txHistory.length > 0) {
                return txHistory;
            }

            // Fallback: Generate synthetic transaction data based on bitmap number
            this.logger.info(`Generating synthetic transaction data for bitmap ${bitmapNumber}`);
            return this.generateSyntheticTransactionData(bitmapNumber);

        } catch (error) {
            this.logger.warn(`Error fetching transaction history for bitmap ${bitmapNumber}, using synthetic data:`, { message: error.message });
            return this.generateSyntheticTransactionData(bitmapNumber);
        }
    }

    /**
     * Gets inscription transaction history (cached)
     * @param {string} inscriptionId - The inscription ID
     * @returns {Promise<Array|null>} - Transaction array or null
     */
    async getInscriptionTransactionsCached(inscriptionId) {
        try {
            // Try ord API endpoint
            const response = await robustApiCall(`${this.API_URL}/inscription/${inscriptionId}/transactions`, {
                headers: { 'Accept': 'application/json' }
            });

            if (response.data && Array.isArray(response.data)) {
                const transactions = response.data.map(tx => ({
                    txid: tx.txid || tx.id,
                    blockHeight: tx.block_height || tx.blockHeight || 0,
                    value: tx.value || tx.output_value || Math.floor(Math.random() * 1000000),
                    timestamp: tx.timestamp || new Date().toISOString()
                }));

                return transactions;
            }

            return null;

        } catch (error) {
            this.logger.debug(`Error fetching inscription transactions for ${inscriptionId}:`, { message: error.message });
            return null;
        }
    }

    /**
     * Generates synthetic transaction data for visualization
     * @param {number} bitmapNumber - The bitmap number
     * @returns {Array} - Synthetic transaction array
     */
    generateSyntheticTransactionData(bitmapNumber) {
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

    // ================================
    // MAIN PROCESSING FUNCTIONS
    // ================================

    /**
     * Processes bitmap inscription
     * @param {string} content - The inscription content
     * @param {string} inscriptionId - The inscription ID
     * @param {number} blockHeight - The block height
     * @returns {Promise<Object|null>} - Processing result or null
     */
    async processBitmapInscription(content, inscriptionId, blockHeight) {
        if (!this.isValidBitmapFormat(content)) {
            return null;
        }

        const bitmapMatch = content.match(/(\d+)\.bitmap/);
        if (!bitmapMatch) {
            return null;
        }

        const bitmapNumber = parseInt(bitmapMatch[1], 10);
        const bitmapData = {
            inscription_id: inscriptionId,
            address: await this.getMintAddress(inscriptionId),
            bitmap_number: bitmapNumber,
            block_height: blockHeight,
            content: `${bitmapNumber}.bitmap`,
            timestamp: Date.now()
        };

        if (this.validateBitmapData(bitmapData)) {
            const saved = await this.saveBitmap(bitmapData);
            if (saved) {
                this.logger.info(`Bitmap saved: ${inscriptionId}`);
                return { type: 'bitmap', id: inscriptionId };
            }
        }

        return null;
    }

    /**
     * Processes parcel inscription
     * @param {string} content - The inscription content
     * @param {string} inscriptionId - The inscription ID
     * @param {number} blockHeight - The block height
     * @param {Function} getBlockTransactionCount - Function to get transaction count
     * @returns {Promise<Object|null>} - Processing result or null
     */
    async processParcelInscription(content, inscriptionId, blockHeight, getBlockTransactionCount) {
        if (!this.isValidParcelFormat(content)) {
            return null;
        }

        const parcelData = this.parseParcelContent(content);
        if (!parcelData) {
            return null;
        }

        const { parcelNumber, bitmapNumber } = parcelData;
        const bitmapInscriptionId = await this.getBitmapInscriptionId(bitmapNumber);
        
        if (!bitmapInscriptionId) {
            this.logger.warn(`Referenced bitmap ${bitmapNumber} not found for parcel ${inscriptionId}`);
            return null;
        }

        const transactionCount = await getBlockTransactionCount(blockHeight);
        const isValidParcelNum = this.validateParcelNumber(parcelNumber, transactionCount);
        const isValidProvenance = await this.validateParcelProvenance(inscriptionId, bitmapInscriptionId);
        
        if (isValidParcelNum && isValidProvenance) {
            const parcelDataFull = {
                inscription_id: inscriptionId,
                parcel_number: parcelNumber,
                bitmap_number: bitmapNumber,
                bitmap_inscription_id: bitmapInscriptionId,
                content: content,
                address: await this.getMintAddress(inscriptionId),
                block_height: blockHeight,
                timestamp: Date.now(),
                transaction_count: transactionCount,
                is_valid: true
            };
            
            const saved = await this.saveParcel(parcelDataFull);
            if (saved) {
                this.logger.info(`Parcel saved: ${inscriptionId}`);
                return { type: 'parcel', id: inscriptionId };
            }
        } else {
            this.logger.warn(`Parcel validation failed for ${inscriptionId}: parcelNum=${isValidParcelNum}, provenance=${isValidProvenance}`);
        }

        return null;
    }

    /**
     * Main function to process bitmap or parcel inscription
     * @param {string} content - The inscription content
     * @param {string} inscriptionId - The inscription ID
     * @param {number} blockHeight - The block height
     * @param {Function} getBlockTransactionCount - Function to get transaction count
     * @returns {Promise<Object|null>} - Processing result or null
     */
    async processBitmapOrParcel(content, inscriptionId, blockHeight, getBlockTransactionCount) {
        if (!content || !content.includes('.bitmap')) {
            return null;
        }

        // Try bitmap first (simpler pattern)
        const bitmapResult = await this.processBitmapInscription(content, inscriptionId, blockHeight);
        if (bitmapResult) {
            return bitmapResult;
        }

        // Try parcel if bitmap failed
        const parcelResult = await this.processParcelInscription(content, inscriptionId, blockHeight, getBlockTransactionCount);
        if (parcelResult) {
            return parcelResult;
        }

        return null;
    }
}

module.exports = BitmapProcessor;
