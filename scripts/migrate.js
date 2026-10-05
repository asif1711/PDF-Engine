import { runDatabaseMigrations } from '../database.js';

runDatabaseMigrations()
  .then(() => {
    console.log('Database migrations executed successfully.');
    process.exit(0);
  })
  .catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
