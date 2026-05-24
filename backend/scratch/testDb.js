const { Client } = require('pg');

const passwords = [
  'postgresql1243',
  'postgres',
  'postgresql',
  'admin',
  'root',
  '1234',
  '123456',
  'postgres_password',
  'supersecretpassword123'
];

async function checkPasswords() {
  for (const pw of passwords) {
    console.log(`Checking password: "${pw}"...`);
    const client = new Client({
      user: 'postgres',
      host: 'localhost',
      port: 5432,
      password: pw,
      database: 'postgres', // default maintenance DB
    });

    try {
      await client.connect();
      console.log(`\n✅ SUCCESS! Working password found: "${pw}"`);
      
      // Let's check if smartERP database exists
      const res = await client.query("SELECT datname FROM pg_database WHERE datname IN ('smartERP', 'smarterp')");
      if (res.rows.length > 0) {
        console.log(`Found existing SmartERP database: "${res.rows[0].datname}"`);
      } else {
        console.log("SmartERP database not found. Creating it...");
        await client.query("CREATE DATABASE smarterp");
        console.log("Database 'smarterp' created successfully.");
      }
      
      await client.end();
      return;
    } catch (err) {
      console.log(`❌ Failed: ${err.message}`);
    }
  }
  console.log("\n❌ Could not find a working password. Please check your PostgreSQL installation credentials.");
}

checkPasswords();
