// Builds the Arclight Labs development dataset into an empty organisation
// (docs/SEED_DATA_ARCHITECTURE.md). Usage, from backend/:
//   npm run db:backup:dev
//   npm run db:reset:dev -- --confirm meeting_action --backup <file printed by db:backup:dev>
//   npm run db:seed
// Optional: SEED_USER_PASSWORD (min 12 characters; without it accounts cannot sign in),
// SEED_ANCHOR_DATE, SEED_COMPANY_DOMAIN, SEED_KAVYA_EMAIL (see demo/config.js).
// No AI provider is called and nothing is sent outside WorkAgent.

// The engine's cancellation window is a real-time wait; historical plans are executed at once and
// then placed at their date. Set before the configuration is loaded.
process.env.ACTION_CANCEL_SECONDS = '0';

const { seed } = await import('./demo/run.js');
const { pool } = await import('../pool.js');

if (process.env.SEED_USER_PASSWORD && process.env.SEED_USER_PASSWORD.length < 12) {
  console.error('SEED_USER_PASSWORD must be at least 12 characters');
  process.exit(1);
}
try {
  await seed();
  console.log('seed complete');
} catch (err) {
  console.error(`seed failed: ${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
