const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Open database
const dbPath = path.join(__dirname, 'indexer.db');
const db = new sqlite3.Database(dbPath);

console.log('🔍 Checking sat numbers in bitmaps table...\n');

// Check total bitmaps
db.get("SELECT COUNT(*) as total FROM bitmaps", (err, row) => {
    if (err) {
        console.error('Error:', err.message);
        return;
    }
    console.log(`📊 Total bitmaps: ${row.total}`);
});

// Check bitmaps with sat numbers
db.get("SELECT COUNT(*) as with_sat FROM bitmaps WHERE sat IS NOT NULL", (err, row) => {
    if (err) {
        console.error('Error:', err.message);
        return;
    }
    console.log(`✅ Bitmaps with sat numbers: ${row.with_sat}`);
});

// Check bitmaps without sat numbers
db.get("SELECT COUNT(*) as without_sat FROM bitmaps WHERE sat IS NULL", (err, row) => {
    if (err) {
        console.error('Error:', err.message);
        return;
    }
    console.log(`❌ Bitmaps without sat numbers: ${row.without_sat}\n`);
});

// Show sample bitmaps with sat numbers
console.log('📋 Sample bitmaps with sat numbers:');
db.all(`
    SELECT bitmap_number, inscription_id, sat, block_height 
    FROM bitmaps 
    WHERE sat IS NOT NULL 
    ORDER BY block_height DESC 
    LIMIT 5
`, (err, rows) => {
    if (err) {
        console.error('Error:', err.message);
        return;
    }
    
    if (rows.length === 0) {
        console.log('   No bitmaps with sat numbers found');
    } else {
        rows.forEach(row => {
            console.log(`   Bitmap #${row.bitmap_number}: sat ${row.sat?.toLocaleString()} (block ${row.block_height})`);
        });
    }
    console.log();
});

// Show sample bitmaps without sat numbers
console.log('📋 Sample bitmaps WITHOUT sat numbers:');
db.all(`
    SELECT bitmap_number, inscription_id, block_height 
    FROM bitmaps 
    WHERE sat IS NULL 
    ORDER BY block_height DESC 
    LIMIT 5
`, (err, rows) => {
    if (err) {
        console.error('Error:', err.message);
        db.close();
        return;
    }
    
    if (rows.length === 0) {
        console.log('   All bitmaps have sat numbers! ✅');
    } else {
        console.log('   These bitmaps are missing sat numbers:');
        rows.forEach(row => {
            console.log(`   Bitmap #${row.bitmap_number}: ${row.inscription_id.substring(0, 12)}... (block ${row.block_height})`);
        });
    }
    
    console.log('\n🎯 SUMMARY:');
    console.log('- Your indexer IS configured to fetch sat numbers');
    console.log('- The database has a sat column');
    console.log('- Check the results above to see current state');
    console.log('\nIf many bitmaps are missing sat numbers, this could be due to:');
    console.log('1. API issues when fetching inscription details');
    console.log('2. Historical data from before sat column was added');
    console.log('3. Network connectivity issues');
    
    db.close();
});
