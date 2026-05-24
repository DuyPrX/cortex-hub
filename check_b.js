import Database from 'better-sqlite3';
const db = new Database('/app/data/cortex.db');
console.log(JSON.stringify(db.prepare('SELECT id, name, created_at, last_used_at, expires_at FROM api_keys').all(), null, 2));
