require('dotenv').config();

module.exports = {
    API_URL: process.env.API_URL,
    API_WALLET_URL: process.env.API_WALLET_URL,
    START_BLOCK: 792435,
    RETRY_BLOCK_DELAY: 3,
    DB_PATH: './db/brc420.db',
    PORT: 5000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 5000,
    CONCURRENCY_LIMIT: process.env.CONCURRENCY_LIMIT || 10,
    REDIS_HOST: process.env.REDIS_HOST || '127.0.0.1',
    REDIS_PORT: process.env.REDIS_PORT || 6379,
    REDIS_TTL: process.env.REDIS_TTL || 3600, // Cache TTL in seconds
    RATE_LIMIT_WINDOW: process.env.RATE_LIMIT_WINDOW || 15 * 60 * 1000, // 15 minutes
    RATE_LIMIT_MAX_REQUESTS: process.env.RATE_LIMIT_MAX_REQUESTS || 100, // Max requests per window
    BATCH_SIZE: process.env.BATCH_SIZE || 500, // Size of batches for processing
};
