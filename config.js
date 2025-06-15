require('dotenv').config();

module.exports = {
    // Primary API URLs - prefer local Umbrel services if available
    ORD_API_URL: process.env.ORD_API_URL || process.env.API_URL || 'https://ordinals.com/api',
    API_URL: process.env.API_URL || 'https://ordinals.com/api',
    API_WALLET_URL: process.env.API_WALLET_URL || 'https://mempool.space/api',
    
    // Bitcoin RPC connection for direct node access
    BITCOIN_RPC_HOST: process.env.BITCOIN_RPC_HOST || null,
    BITCOIN_RPC_PORT: parseInt(process.env.BITCOIN_RPC_PORT) || 8332,
    BITCOIN_RPC_USER: process.env.BITCOIN_RPC_USER || null,
    BITCOIN_RPC_PASS: process.env.BITCOIN_RPC_PASS || null,
    
    // Indexing configuration
    START_BLOCK: parseInt(process.env.START_BLOCK) || 792435, // first brc-420 in block 807604 first bitmap in block 792435
    RETRY_BLOCK_DELAY: parseInt(process.env.RETRY_BLOCK_DELAY) || 3,
    DB_PATH: process.env.DB_PATH || './db/brc420.db',
    PORT: parseInt(process.env.PORT) || 5000,
    WEB_PORT: parseInt(process.env.WEB_PORT) || 8080,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 5000,
    CONCURRENCY_LIMIT: parseInt(process.env.CONCURRENCY_LIMIT) || 5,
    RUN_INDEXER: process.env.RUN_INDEXER === 'true',
    
    // Determine if we're running in Umbrel environment
    isUmbrelEnvironment() {
        return !!(this.BITCOIN_RPC_HOST && this.BITCOIN_RPC_USER && this.BITCOIN_RPC_PASS);
    },
    
    // Get the appropriate API URL based on environment
    getApiUrl() {
        return this.ORD_API_URL || this.API_URL;
    },
      // Get local Ordinals URL for frontend content
    getLocalOrdinalsUrl() {
        if (process.env.ORD_API_URL) {
            // Extract base URL from API URL (remove /api suffix)
            return process.env.ORD_API_URL.replace('/api', '');
        }
        // Use Umbrel's standard hostname first, then try other local addresses
        const localAddresses = [
            'http://umbrel.local:4000',
            'http://localhost:4000',
            'http://127.0.0.1:4000'
        ];
        return localAddresses[0]; // Default to umbrel.local
    }
};
