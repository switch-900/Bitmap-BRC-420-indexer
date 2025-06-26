require('dotenv').config();

module.exports = {    // Primary API URLs - prefer local Umbrel services if available
    ORD_API_URL: process.env.ORD_API_URL || null, // Will be tested dynamically
    API_URL: process.env.API_URL || 'https://ordinals.com/api',
    API_WALLET_URL: process.env.API_WALLET_URL || null, // Will be tested dynamically for Umbrel patterns
    
    // Bitcoin RPC connection for direct node access
    BITCOIN_RPC_HOST: process.env.BITCOIN_RPC_HOST || null,
    BITCOIN_RPC_PORT: parseInt(process.env.BITCOIN_RPC_PORT) || 8332,
    BITCOIN_RPC_USER: process.env.BITCOIN_RPC_USER || null,
    BITCOIN_RPC_PASS: process.env.BITCOIN_RPC_PASS || null,
      // Indexing configuration - optimized for local node
    START_BLOCK: parseInt(process.env.START_BLOCK) || 792435, // first brc-420 in block 807604 first bitmap in block 792435
    RETRY_BLOCK_DELAY: parseInt(process.env.RETRY_BLOCK_DELAY) || 1, // Reduced delay for local node
    DB_PATH: process.env.DB_PATH || './db/brc420.db',
    PORT: parseInt(process.env.PORT) || 5000,
    WEB_PORT: parseInt(process.env.WEB_PORT) || 8080,
    MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 5, // Increased retries
    RETRY_DELAY: parseInt(process.env.RETRY_DELAY) || 1000, // Reduced delay for local node  
    CONCURRENCY_LIMIT: parseInt(process.env.CONCURRENCY_LIMIT) || 10, // Increased concurrency for local node
    RUN_INDEXER: process.env.RUN_INDEXER === 'true',
    
    // API timeout settings for local node
    API_TIMEOUT: parseInt(process.env.API_TIMEOUT) || 30000, // 30 seconds for local node
    STATUS_TIMEOUT: parseInt(process.env.STATUS_TIMEOUT) || 10000, // 10 seconds for status checks
    
    // Determine if we're running in Umbrel environment
    isUmbrelEnvironment() {
        return !!(this.BITCOIN_RPC_HOST && this.BITCOIN_RPC_USER && this.BITCOIN_RPC_PASS);
    },    // Get the appropriate API URL based on environment
    getApiUrl() {
        // Always prioritize the fallback API_URL for reliability
        // ORD_API_URL is for local services which may not be available
        return this.API_URL;
    },
      // Get local API URL for testing connectivity
    getLocalApiUrl() {
        // If explicitly set via environment variable, use that
        if (process.env.ORD_API_URL) {
            let url = process.env.ORD_API_URL;
            // Ensure URL is properly formatted
            if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
                // If it's just a hostname, add http://
                if (url.includes(':')) {
                    url = `http://${url}`;
                }
            }
            return url;
        }
        
        // Return null if no local API configured - will trigger testing of multiple endpoints
        return null;
    },      // Get local Ordinals URL for frontend content
    getLocalOrdinalsUrl() {
        if (process.env.ORD_API_URL) {
            // Extract base URL from API URL (remove /api suffix)
            return process.env.ORD_API_URL.replace('/api', '');
        }
        // Return first available endpoint
        const endpoints = this.getLocalApiEndpoints();
        return endpoints.length > 0 ? endpoints[0] : null;
    },
    
    // Get all possible local API endpoints to test (OFFICIAL UMBREL PATTERNS)
    getLocalApiEndpoints() {
        const endpoints = [];
        
        // If explicitly configured, try that first
        if (process.env.ORD_API_URL) {
            endpoints.push(process.env.ORD_API_URL);
        }
        
        // OFFICIAL UMBREL SERVICE NAMING PATTERN: {app-id}_{service-name}_{instance-number}
        const officialUmbrelEndpoints = [
            'http://ordinals_web_1:4000',      // Most likely official pattern
            'http://ordinals_server_1:4000',   // Alternative service name
            'http://ordinals_app_1:4000',      // Another alternative
            'http://bitcoin-ordinals_web_1:4000',   // If app-id includes 'bitcoin-'
            'http://bitcoin-ordinals_server_1:4000'
        ];
        
        // Environment variable approach (official Umbrel pattern)
        if (process.env.APP_ORDINALS_NODE_IP) {
            endpoints.push(`http://${process.env.APP_ORDINALS_NODE_IP}:4000`);
        }
        
        // System hostnames (from official docs)
        if (process.env.DEVICE_HOSTNAME && process.env.DEVICE_DOMAIN_NAME) {
            endpoints.push(`http://${process.env.DEVICE_HOSTNAME}.${process.env.DEVICE_DOMAIN_NAME}:4000`);
        }
        
        // Legacy/fallback endpoints
        const fallbackEndpoints = [
            'http://umbrel.local:4000',
            'http://10.21.21.9:4000',       // Common Umbrel IP
            'http://172.17.0.1:4000',       // Docker gateway
            'http://localhost:4000',
            'http://127.0.0.1:4000'
        ];
          // Combine all endpoints with official patterns first
        endpoints.push(...officialUmbrelEndpoints, ...fallbackEndpoints);
        return [...new Set(endpoints)]; // Remove duplicates
    },
    
    // Get all possible mempool API endpoints to test (OFFICIAL UMBREL PATTERNS)
    getMempoolApiEndpoints() {
        const endpoints = [];
        
        // If explicitly configured, try that first
        if (process.env.API_WALLET_URL) {
            endpoints.push(process.env.API_WALLET_URL);
        }
        
        // OFFICIAL UMBREL SERVICE NAMING PATTERN: {app-id}_{service-name}_{instance-number}
        // Based on official mempool app configuration from Umbrel repository
        const officialUmbrelMempoolEndpoints = [
            'http://mempool_web_1:3006/api',        // Most likely official pattern
            'http://mempool_api_1:3006/api',        // Alternative service name
            'http://mempool_server_1:3006/api',     // Another alternative
            'http://bitcoin-mempool_web_1:3006/api', // If app-id includes 'bitcoin-'
            'http://bitcoin-mempool_api_1:3006/api'
        ];
        
        // Environment variable approach (official Umbrel pattern)
        if (process.env.APP_MEMPOOL_NODE_IP) {
            endpoints.push(`http://${process.env.APP_MEMPOOL_NODE_IP}:3006/api`);
        }
        
        // From official Umbrel mempool app exports.sh - use internal Docker IP
        if (process.env.APP_MEMPOOL_API_IP) {
            endpoints.push(`http://${process.env.APP_MEMPOOL_API_IP}:3006/api`);
        }
        
        // System hostnames (from official docs)
        if (process.env.DEVICE_HOSTNAME && process.env.DEVICE_DOMAIN_NAME) {
            endpoints.push(`http://${process.env.DEVICE_HOSTNAME}.${process.env.DEVICE_DOMAIN_NAME}:3006/api`);
        }
        
        // Legacy/fallback endpoints (including external API)
        const fallbackEndpoints = [
            'http://umbrel.local:3006/api',
            'http://10.21.21.27:3006/api',      // Official Umbrel mempool API IP
            'http://10.21.21.26:3006/api',      // Official Umbrel mempool main IP
            'http://172.17.0.1:3006/api',       // Docker gateway
            'http://localhost:3006/api',
            'http://127.0.0.1:3006/api',
            'https://mempool.space/api'         // External fallback
        ];
        
        // Combine all endpoints with official patterns first
        endpoints.push(...officialUmbrelMempoolEndpoints, ...fallbackEndpoints);
        
        return [...new Set(endpoints)]; // Remove duplicates
    },
    
    // Get the appropriate mempool API URL for the current environment  
    getMempoolApiUrl() {
        // If explicitly set, use that
        if (process.env.API_WALLET_URL) {
            return process.env.API_WALLET_URL;
        }
          // Default fallback to external API - will be tested dynamically for local services
        return 'https://mempool.space/api';
    }
};
