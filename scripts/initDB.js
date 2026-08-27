const db = require('../core/db/sqlite');

async function main() {
  try {
    console.log('🗄️  Initializing GoMaa Raga Vidya v3 database...');
    await db.getDb();

    // Migration: add analysisJson column if missing (for existing DBs)
    try {
      db.run('ALTER TABLE music ADD COLUMN analysisJson TEXT');
      console.log('✅ Migrated: added analysisJson column to music table');
    } catch(e) {
      if (e.message && e.message.includes('duplicate column')) {
        console.log('ℹ️  analysisJson column already exists');
      } else {
        console.log('ℹ️  analysisJson column check:', e.message);
      }
    }

    console.log('✅ Database ready at models/music.db');
    console.log('   Run: npm run ingest  to populate with music data');
    process.exit(0);
  } catch (e) {
    console.error('❌ DB init failed:', e.message);
    process.exit(1);
  }
}

main();
