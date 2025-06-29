require('dotenv').config();
const fs = require('fs');

class ProductionConfig {
    constructor() {
        this.environment = process.env.NODE_ENV || 'development';
        this.isProduction = this.environment === 'production';
        this.isDevelopment = this.environment === 'development';
        this.isUmbrel = this.detectUmbrelEnvironment();
        
        // Cache for tested endpoints to avoid repeated checks
        this.testedEndpoints = new Map();
        this.lastEndpointTest = 0;
        this.endpointTestInterval = 300000; // 5 minutes
        
        console.log(`[CONFIG] Environment: ${this.environment}`);
        console.log(`[CONFIG] Umbrel detected: ${this.isUmbrel}`);
    }

    // Primary configuration
    get ORD_API_URL() {
        return process.env.ORD_API_URL || null;
    }

    get API_URL() {
        return process.env.API_URL || 'https://ordinals.com';
    }

    get API_WALLET_URL() {
        return process.env.API_WALLET_URL || null;
    }

    // Server configuration
    get START_BLOCK() {
        return parseInt(process.env.START_BLOCK) || 792435;
    }

    get RETRY_BLOCK_DELAY() {
        return parseInt(process.env.RETRY_BLOCK_DELAY) || (this.isProduction ? 5 : 1);
    }

    get DB_PATH() {
        return process.env.DB_PATH || './db/brc420.db';
    }

    get PORT() {
        return parseInt(process.env.PORT) || 5000;
    }

    get WEB_PORT() {
        return parseInt(process.env.WEB_PORT) || 8080;
    }

    // Performance configuration
    get MAX_RETRIES() {
        return parseInt(process.env.MAX_RETRIES) || (this.isProduction ? 3 : 5);
    }

    get RETRY_DELAY() {
        return parseInt(process.env.RETRY_DELAY) || (this.isProduction ? 2000 : 1000);
    }

    get CONCURRENCY_LIMIT() {
        return parseInt(process.env.CONCURRENCY_LIMIT) || (this.isProduction ? 5 : 10);
    }

    get RUN_INDEXER() {
        // Default to false in production for safety, true in development
        const defaultValue = this.isProduction ? false : true;
        return process.env.RUN_INDEXER === 'true' || 
               (process.env.RUN_INDEXER === undefined && defaultValue);
    }

    // Timeout configuration
    get API_TIMEOUT() {
        return parseInt(process.env.API_TIMEOUT) || (this.isProduction ? 15000 : 30000);
    }

    get STATUS_TIMEOUT() {
        return parseInt(process.env.STATUS_TIMEOUT) || (this.isProduction ? 5000 : 10000);
    }

    // Environment detection
    detectUmbrelEnvironment() {
        return !!(
            process.env.UMBREL_ROOT || 
            process.env.USE_LOCAL_APIS_ONLY === 'true' ||
            process.env.UMBREL === 'true' ||
            fs.existsSync('/umbrel') ||
            process.env.HOME?.includes('umbrel')
        );
    }

    get USE_LOCAL_APIS_ONLY() {
        return process.env.USE_LOCAL_APIS_ONLY === 'true' || this.isUmbrel;
    }

    useLocalApisOnly() {
        return this.USE_LOCAL_APIS_ONLY;
    }

    // API URL resolution with caching and fallback
    getApiUrl() {
        try {
            // In Umbrel environment, prioritize local ORD API if available
            if (this.useLocalApisOnly() && this.ORD_API_URL) {
                return this.ORD_API_URL;
            }
            
            // Fall back to external API with validation
            const externalUrl = this.API_URL;
            if (!externalUrl || !externalUrl.startsWith('http')) {
                console.warn('[CONFIG] Invalid API_URL, using default');
                return 'https://ordinals.com';
            }
            
            return externalUrl;
        } catch (error) {
            console.error('[CONFIG] Error resolving API URL:', error.message);
            return 'https://ordinals.com';
        }
    }

    // Local API URL with validation
    getLocalApiUrl() {
        try {
            if (this.ORD_API_URL) {
                let url = this.ORD_API_URL.trim();
                
                // Ensure URL is properly formatted
                if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
                    // If it's just a hostname:port, add http://
                    if (url.includes(':')) {
                        url = `http://${url}`;
                    }
                }
                
                // Validate URL format
                try {
                    new URL(url);
                    return url;
                } catch (urlError) {
                    console.warn('[CONFIG] Invalid local API URL format:', url);
                    return null;
                }
            }
            
            return null;
        } catch (error) {
            console.error('[CONFIG] Error getting local API URL:', error.message);
            return null;
        }
    }

    // Local Ordinals URL for frontend content
    getLocalOrdinalsUrl() {
        try {
            if (this.ORD_API_URL) {
                // Extract base URL from API URL (remove /api suffix)
                const baseUrl = this.ORD_API_URL.replace(/\/api\/?$/, '');
                return baseUrl;
            }
            
            // Return first available endpoint from tested list
            const endpoints = this.getLocalApiEndpoints();
            return endpoints.length > 0 ? endpoints[0].replace(/\/api\/?$/, '') : null;
        } catch (error) {
            console.error('[CONFIG] Error getting local Ordinals URL:', error.message);
            return null;
        }
    }

    // Get all possible local API endpoints (production-optimized)
    getLocalApiEndpoints() {
        const endpoints = [];
        
        try {
            // If explicitly configured, try that first
            if (this.ORD_API_URL) {
                endpoints.push(this.ORD_API_URL);
            }
            
            // Production Umbrel patterns (most reliable first)
            const productionEndpoints = [
                'http://umbrel.local:4000',        // Most reliable external access
                'http://ordinals_web_1:4000',      // Official Umbrel pattern
                'http://ordinals_server_1:4000',   // Alternative service name
                'http://172.17.0.1:4000',          // Docker gateway (often works)
                'http://localhost:4000',           // Local fallback
            ];
            
            // Environment variable approach (official Umbrel pattern)
            if (process.env.APP_ORDINALS_NODE_IP) {
                endpoints.unshift(`http://${process.env.APP_ORDINALS_NODE_IP}:4000`);
            }
            
            // Add production endpoints
            endpoints.push(...productionEndpoints);
            
            // Only add experimental endpoints in development
            if (this.isDevelopment) {
                const experimentalEndpoints = [
                    'http://10.21.21.9:4000',
                    'http://127.0.0.1:4000',
                    'http://ordinals_app_1:4000',
                ];
                endpoints.push(...experimentalEndpoints);
            }
            
            // Remove duplicates and validate
            const uniqueEndpoints = [...new Set(endpoints)].filter(endpoint => {
                try {
                    new URL(endpoint);
                    return true;
                } catch {
                    return false;
                }
            });
            
            return uniqueEndpoints;
        } catch (error) {
            console.error('[CONFIG] Error getting local API endpoints:', error.message);
            return [];
        }
    }

    // Get mempool API endpoints (production-optimized)
    getMempoolApiEndpoints() {
        const endpoints = [];
        
        try {
            // If explicitly configured, try that first
            if (this.API_WALLET_URL) {
                endpoints.push(this.API_WALLET_URL);
            }
            
            // Production Umbrel mempool patterns
            const productionMempoolEndpoints = [
                'http://umbrel.local:3006/api',         // Most reliable
                'http://mempool_web_1:3006/api',        // Official pattern
                'http://10.21.21.26:3006/api',          // Known working IP
                'http://172.17.0.1:3006/api',           // Docker gateway
            ];
            
            // Environment variables
            if (process.env.APP_MEMPOOL_NODE_IP) {
                endpoints.unshift(`http://${process.env.APP_MEMPOOL_NODE_IP}:3006/api`);
            }
            
            if (process.env.APP_MEMPOOL_API_IP) {
                endpoints.unshift(`http://${process.env.APP_MEMPOOL_API_IP}:3006/api`);
            }
            
            // Add production endpoints
            endpoints.push(...productionMempoolEndpoints);
            
            // External fallback only if not in local-only mode
            if (!this.useLocalApisOnly()) {
                endpoints.push('https://mempool.space/api');
            }
            
            // Remove duplicates and validate
            const uniqueEndpoints = [...new Set(endpoints)].filter(endpoint => {
                try {
                    new URL(endpoint);
                    return true;
                } catch {
                    return false;
                }
            });
            
            return uniqueEndpoints;
        } catch (error) {
            console.error('[CONFIG] Error getting mempool API endpoints:', error.message);
            return [];
        }
    }

    // Get appropriate mempool API URL
    getMempoolApiUrl() {
        try {
            // If explicitly set, validate and use that
            if (this.API_WALLET_URL) {
                try {
                    new URL(this.API_WALLET_URL);
                    return this.API_WALLET_URL;
                } catch {
                    console.warn('[CONFIG] Invalid API_WALLET_URL format');
                }
            }
            
            // If in Umbrel environment, don't use external API by default
            if (this.useLocalApisOnly()) {
                return null; // Will trigger endpoint testing
            }
            
            // Default fallback to external API
            return 'https://mempool.space/api';
        } catch (error) {
            console.error('[CONFIG] Error getting mempool API URL:', error.message);
            return 'https://mempool.space/api';
        }
    }

    // Test endpoint connectivity with caching
    async testEndpoint(url, timeout = 5000) {
        const now = Date.now();
        
        // Use cached result if recent
        if (this.testedEndpoints.has(url) && 
            (now - this.lastEndpointTest) < this.endpointTestInterval) {
            return this.testedEndpoints.get(url);
        }
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            
            const response = await fetch(`${url}/status`, {
                signal: controller.signal,
                method: 'GET',
                headers: { 'User-Agent': 'BRC-420-Indexer/1.0' }
            });
            
            clearTimeout(timeoutId);
            const isHealthy = response.ok;
            
            // Cache result
            this.testedEndpoints.set(url, isHealthy);
            this.lastEndpointTest = now;
            
            return isHealthy;
        } catch (error) {
            // Cache negative result
            this.testedEndpoints.set(url, false);
            return false;
        }
    }

    // Get configuration for frontend
    getFrontendConfig() {
        return {
            apiUrl: '/api',
            localOrdinalsUrl: this.getLocalOrdinalsUrl(),
            environment: this.environment,
            features: {
                brc420: true,
                bitmaps: true,
                patterns: true,
                indexer: this.RUN_INDEXER
            },
            endpoints: {
                health: '/health',
                ready: '/ready',
                config: '/api/config'
            }
        };
    }

    // Validate configuration
    validate() {
        const issues = [];
        
        try {
            // Check required configuration
            if (!this.DB_PATH) {
                issues.push('DB_PATH is required');
            }
            
            if (this.WEB_PORT < 1 || this.WEB_PORT > 65535) {
                issues.push('WEB_PORT must be between 1 and 65535');
            }
            
            if (this.API_TIMEOUT < 1000) {
                issues.push('API_TIMEOUT should be at least 1000ms');
            }
            
            // Validate API URLs if provided
            if (this.ORD_API_URL) {
                try {
                    new URL(this.ORD_API_URL);
                } catch {
                    issues.push('ORD_API_URL has invalid format');
                }
            }
            
            if (this.API_WALLET_URL) {
                try {
                    new URL(this.API_WALLET_URL);
                } catch {
                    issues.push('API_WALLET_URL has invalid format');
                }
            }
            
            return {
                valid: issues.length === 0,
                issues: issues
            };
        } catch (error) {
            return {
                valid: false,
                issues: [`Configuration validation error: ${error.message}`]
            };
        }
    }

    // Print configuration summary
    printSummary() {
        console.log('[CONFIG] =================================');
        console.log('[CONFIG] BRC-420 Indexer Configuration');
        console.log('[CONFIG] =================================');
        console.log(`[CONFIG] Environment: ${this.environment}`);
        console.log(`[CONFIG] Web Port: ${this.WEB_PORT}`);
        console.log(`[CONFIG] API Port: ${this.PORT}`);
        console.log(`[CONFIG] Database: ${this.DB_PATH}`);
        console.log(`[CONFIG] Start Block: ${this.START_BLOCK}`);
        console.log(`[CONFIG] Run Indexer: ${this.RUN_INDEXER}`);
        console.log(`[CONFIG] Use Local APIs: ${this.useLocalApisOnly()}`);
        console.log(`[CONFIG] API URL: ${this.getApiUrl()}`);
        console.log(`[CONFIG] Local API: ${this.getLocalApiUrl() || 'Not configured'}`);
        console.log(`[CONFIG] Concurrency: ${this.CONCURRENCY_LIMIT}`);
        console.log(`[CONFIG] API Timeout: ${this.API_TIMEOUT}ms`);
        console.log('[CONFIG] =================================');
        
        // Validate and show any issues
        const validation = this.validate();
        if (!validation.valid) {
            console.warn('[CONFIG] ⚠️  Configuration Issues:');
            validation.issues.forEach(issue => {
                console.warn(`[CONFIG]    - ${issue}`);
            });
        } else {
            console.log('[CONFIG] ✅ Configuration is valid');
        }
    }
}

// Create and export singleton instance
const config = new ProductionConfig();

// Print configuration summary on load
if (process.env.NODE_ENV !== 'test') {
    config.printSummary();
}

module.exports = config;