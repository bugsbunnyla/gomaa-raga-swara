const db = require('../core/db/sqlite');
const fs = require('fs');
const path = require('path');

async function main() {
  try {
    console.log('🗄️  Initializing GoMaa Raga Vidya v3 database...');

    // Ensure DB is connected
    await db.getDb();

    // Read and execute schema
    const schemaPath = path.join(__dirname, '../core/db/schema.sql');
    if (fs.existsSync(schemaPath)) {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      await db.exec(schema);
      console.log('✅ Schema applied');
    } else {
      console.warn('⚠️  schema.sql not found, skipping schema creation');
    }

    // Run migrations for columns that might be missing in existing DBs
    const migrations = [
      'ALTER TABLE music ADD COLUMN analysisJson TEXT',
      'ALTER TABLE music ADD COLUMN lyricsJson TEXT',
      'ALTER TABLE music ADD COLUMN transcriptionJson TEXT',
    ];

    for (const sql of migrations) {
      try {
        await db.run(sql);
        console.log('✅ Migrated:', sql);
      } catch(e) {
        if (e.message && (e.message.includes('duplicate column') || e.message.includes('already exists'))) {
          console.log('ℹ️  Column already exists');
        } else {
          console.log('ℹ️  Migration check:', e.message);
        }
      }
    }

    console.log('✅ Database ready at', db.DB_PATH);
    console.log('   Run: npm run ingest  to populate with music data');
    process.exit(0);
  } catch (e) {
    console.error('❌ DB init failed:', e.message);
    process.exit(1);
  }
}

main();
