import dotenv from 'dotenv';
dotenv.config();

export const config = {
    API_URL: process.env.API_URL,
    API_WALLET_URL: process.env.API_WALLET_URL,
    START_BLOCK: 807604,
    RETRY_BLOCK_DELAY: 3,
    DB_PATH: './db/brc420.db',
    PORT: 5000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 5000,
    CONCURRENCY_LIMIT: 10
};
