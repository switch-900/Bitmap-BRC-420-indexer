#!/usr/bin/env node

/**
 * BRC-420 Debug Script
 * 
 * This script tests BRC-420 content fetching from various API endpoints
 * to understand why deploys/mints are not being detected.
 */

const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();

// Configuration
const API_ENDPOINTS = [
    'https://ordinals.com',
    'https://api.ordinals.com',
    'https://ordinals.hiro.so',
    'https://blockstream.info/api'
];

const DB_PATH = './db/brc420.db';

// Known BRC-420 inscription IDs for testing
const TEST_INSCRIPTIONS = {
    // First known BRC-420 deploy (approximate)
    deploy: '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0',
    // Common BRC-420 mint pattern
    mint: '7a4c32e7a2b2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8i0'
};

// Additional test inscriptions from blocks where BRC-420 should exist
const BLOCK_TEST_INSCRIPTIONS = [
    // Block 807604 - First BRC-420
    '6fb976ab49dcec017f1e201e84395983204ae1a7c2abf7ced0a85d692e442799i0',
    // Block 808000 - Early BRC-420 period
    '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdefi0'
];

async function testContentFetching() {
    console.log('🔍 BRC-420 Content Fetching Debug Script');
    console.log('==========================================\n');

    // Test each API endpoint
    for (const baseUrl of API_ENDPOINTS) {
        console.log(`\n📡 Testing API endpoint: ${baseUrl}`);
        console.log('-'.repeat(50));

        for (const [type, inscriptionId] of Object.entries(TEST_INSCRIPTIONS)) {
            await testInscriptionContent(baseUrl, inscriptionId, type);
        }
    }

    // Check database for actual inscriptions to test
    await checkDatabaseInscriptions();
}

async function testInscriptionContent(baseUrl, inscriptionId, type) {
    const endpoints = [
        `${baseUrl}/content/${inscriptionId}`,
        `${baseUrl}/inscription/${inscriptionId}/content`,
        `${baseUrl}/api/content/${inscriptionId}`,
        `${baseUrl}/api/inscription/${inscriptionId}/content`
    ];

    console.log(`  Testing ${type} inscription: ${inscriptionId.substring(0, 20)}...`);

    for (const endpoint of endpoints) {
        try {
            const response = await axios.get(endpoint, {
                headers: { 
                    'Accept': 'text/plain, application/json, */*',
                    'User-Agent': 'BRC-420-Debug/1.0'
                },
                timeout: 10000,
                validateStatus: () => true // Don't throw on HTTP errors
            });

            const content = response.data || '';
            const status = response.status;
            
            if (status === 200 && content && content.length > 0) {
                console.log(`    ✅ ${endpoint}`);
                console.log(`       Status: ${status}, Length: ${content.length} chars`);
                console.log(`       Content: ${content.substring(0, 100)}...`);
                
                // Check for BRC-420 patterns
                const isBrc420Deploy = content.includes('"p":"brc-420"') && content.includes('"op":"deploy"');
                const isBrc420Mint = content.trim().startsWith('/content/');
                console.log(`       BRC-420 Deploy: ${isBrc420Deploy}, BRC-420 Mint: ${isBrc420Mint}`);
            } else {
                console.log(`    ❌ ${endpoint}`);
                console.log(`       Status: ${status}, Length: ${content.length} chars`);
            }
        } catch (error) {
            console.log(`    ❌ ${endpoint}`);
            console.log(`       Error: ${error.message}`);
        }
    }
}

async function checkDatabaseInscriptions() {
    console.log(`\n💾 Checking database for recent inscriptions to test...`);
    console.log('-'.repeat(50));

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY, (err) => {
        if (err) {
            console.log(`❌ Could not open database: ${err.message}`);
            return;
        }
    });

    // Get recent inscriptions from the highest processed blocks
    const query = `
        SELECT DISTINCT inscription_id, block_height 
        FROM (
            SELECT inscription_id, block_height FROM bitmaps 
            WHERE block_height > (SELECT MAX(block_height) - 100 FROM bitmaps)
            LIMIT 10
        )
        ORDER BY block_height DESC
    `;

    db.all(query, [], async (err, rows) => {
        if (err) {
            console.log(`❌ Database query error: ${err.message}`);
            return;
        }

        console.log(`Found ${rows.length} recent inscriptions to test:`);

        for (const row of rows) {
            console.log(`\n  📋 Testing inscription from block ${row.block_height}: ${row.inscription_id}`);
            
            // Test with primary API endpoint
            await testInscriptionContent('https://ordinals.com', row.inscription_id, 'database');
        }

        db.close();
    });
}

async function analyzeBlockStats() {
    console.log(`\n📊 Analyzing block processing statistics...`);
    console.log('-'.repeat(50));

    const db = new sqlite3.Database(DB_PATH, sqlite3.OPEN_READONLY);

    const queries = [
        {
            name: 'Total Blocks Processed',
            sql: 'SELECT COUNT(*) as count FROM block_stats'
        },
        {
            name: 'Blocks with Inscriptions',
            sql: 'SELECT COUNT(*) as count FROM block_stats WHERE total_inscriptions > 0'
        },
        {
            name: 'Blocks with BRC-420 Deploys',
            sql: 'SELECT COUNT(*) as count FROM block_stats WHERE brc420_deploys > 0'
        },
        {
            name: 'Blocks with BRC-420 Mints', 
            sql: 'SELECT COUNT(*) as count FROM block_stats WHERE brc420_mints > 0'
        },
        {
            name: 'Recent High-Activity Blocks',
            sql: `SELECT block_height, total_inscriptions, brc420_deploys, brc420_mints, bitmaps 
                  FROM block_stats 
                  WHERE total_inscriptions > 50 
                  ORDER BY block_height DESC 
                  LIMIT 5`
        }
    ];

    for (const query of queries) {
        db.all(query.sql, [], (err, rows) => {
            if (err) {
                console.log(`❌ Query error for ${query.name}: ${err.message}`);
                return;
            }

            if (query.name === 'Recent High-Activity Blocks') {
                console.log(`\n${query.name}:`);
                rows.forEach(row => {
                    console.log(`  Block ${row.block_height}: ${row.total_inscriptions} inscriptions, ${row.brc420_deploys} deploys, ${row.brc420_mints} mints, ${row.bitmaps} bitmaps`);
                });
            } else {
                console.log(`${query.name}: ${rows[0]?.count || 0}`);
            }
        });
    }

    setTimeout(() => {
        db.close();
        console.log('\n🏁 Debug analysis complete!');
        console.log('\nNext steps:');
        console.log('1. Check if content is being fetched successfully');
        console.log('2. Verify BRC-420 pattern detection logic');
        console.log('3. Ensure validation functions are working');
        console.log('4. Test with known BRC-420 inscriptions');
    }, 2000);
}

// Run the debug script
testContentFetching()
    .then(() => analyzeBlockStats())
    .catch(error => {
        console.error('❌ Debug script error:', error);
    });
