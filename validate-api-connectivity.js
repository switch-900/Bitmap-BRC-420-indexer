#!/usr/bin/env node
// BRC-420 Indexer - API Connectivity Validation
// Run this to verify that all API fixes are working correctly

const config = require('./config.js');
const axios = require('axios');

console.log('🔍 BRC-420 Indexer - API Connectivity Validation');
console.log('================================================');

async function testEndpoint(url, description) {
    try {
        console.log(`Testing ${description}...`);
        const response = await axios.get(url, {
            timeout: 10000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'BRC-420-Complete-Indexer/1.0'
            }
        });
        
        if (response.status === 200) {
            console.log(`✅ ${description}: OK (${response.status})`);
            return true;
        } else {
            console.log(`⚠️ ${description}: HTTP ${response.status}`);
            return false;
        }
    } catch (error) {
        if (error.response && error.response.status === 406) {
            console.log(`❌ ${description}: 406 NOT ACCEPTABLE (This would cause indexer errors)`);
        } else {
            console.log(`❌ ${description}: ${error.message}`);
        }
        return false;
    }
}

async function validateConfiguration() {
    console.log('\n📋 Configuration Validation');
    console.log('============================');
    
    // Test ordinals API endpoints in priority order
    const ordinalsEndpoints = config.getLocalApiEndpoints();
    console.log(`Found ${ordinalsEndpoints.length} ordinals API endpoints to test:`);
    
    let workingOrdinalsAPI = null;
    for (const endpoint of ordinalsEndpoints) {
        const works = await testEndpoint(`${endpoint}/blockheight`, `Ordinals API: ${endpoint}`);
        if (works && !workingOrdinalsAPI) {
            workingOrdinalsAPI = endpoint;
        }
    }
    
    // Test mempool API endpoints
    const mempoolEndpoints = config.getMempoolApiEndpoints();
    console.log(`\nFound ${mempoolEndpoints.length} mempool API endpoints to test:`);
    
    let workingMempoolAPI = null;
    for (const endpoint of mempoolEndpoints) {
        const works = await testEndpoint(`${endpoint}/blocks/tip/height`, `Mempool API: ${endpoint}`);
        if (works && !workingMempoolAPI) {
            workingMempoolAPI = endpoint;
        }
    }
    
    return { workingOrdinalsAPI, workingMempoolAPI };
}

async function testInscriptionFetching(ordinalsAPI) {
    console.log('\n🔍 Inscription Data Fetching Test');
    console.log('=================================');
    
    // Test inscription details (this was causing 406 errors)
    const testInscriptionId = 'd0865d9ee4bac83e9b4b7cf2304d27d68dd4eb25501ffa95bfb169b34ac76674i0';
    
    try {
        console.log(`Testing inscription details for: ${testInscriptionId.substring(0, 20)}...`);
        const response = await axios.get(`${ordinalsAPI}/inscription/${testInscriptionId}`, {
            timeout: 15000,
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'BRC-420-Complete-Indexer/1.0'
            }
        });
        
        if (response.status === 200 && response.data) {
            console.log(`✅ Inscription details: OK`);
            console.log(`   Sat number: ${response.data.sat || 'null'}`);
            console.log(`   Address: ${response.data.address || 'null'}`);
            return true;
        } else {
            console.log(`⚠️ Inscription details: Unexpected response`);
            return false;
        }
    } catch (error) {
        if (error.response && error.response.status === 406) {
            console.log(`❌ Inscription details: 406 NOT ACCEPTABLE - API connectivity fix needed!`);
        } else {
            console.log(`❌ Inscription details: ${error.message}`);
        }
        return false;
    }
}

async function main() {
    console.log(`Environment: ${config.isUmbrelEnvironment() ? 'Umbrel' : 'Standard'}`);
    console.log(`Use Local APIs Only: ${config.useLocalApisOnly()}`);
    console.log('');
    
    const { workingOrdinalsAPI, workingMempoolAPI } = await validateConfiguration();
    
    if (workingOrdinalsAPI) {
        console.log(`\n🎯 Primary Ordinals API: ${workingOrdinalsAPI}`);
        const inscriptionWorks = await testInscriptionFetching(workingOrdinalsAPI);
        
        if (inscriptionWorks) {
            console.log('\n✅ ALL TESTS PASSED - Indexer should work correctly');
            console.log('   • Local APIs are accessible');
            console.log('   • Inscription data can be fetched');
            console.log('   • No 406 errors detected');
        } else {
            console.log('\n❌ INSCRIPTION TEST FAILED - Indexer may have issues');
        }
    } else {
        console.log('\n❌ NO WORKING ORDINALS API FOUND - Indexer will fail');
        console.log('   Please check that the Ordinals app is running on Umbrel');
    }
    
    if (workingMempoolAPI) {
        console.log(`\n🎯 Primary Mempool API: ${workingMempoolAPI}`);
    } else {
        console.log('\n⚠️ NO WORKING MEMPOOL API FOUND - Block data may be limited');
    }
    
    console.log('\n📋 Summary');
    console.log('===========');
    console.log(`Ordinals API: ${workingOrdinalsAPI ? '✅ Working' : '❌ Failed'}`);
    console.log(`Mempool API: ${workingMempoolAPI ? '✅ Working' : '❌ Failed'}`);
    console.log(`Status: ${workingOrdinalsAPI ? 'Ready for indexing' : 'Needs troubleshooting'}`);
}

main().catch(console.error);
