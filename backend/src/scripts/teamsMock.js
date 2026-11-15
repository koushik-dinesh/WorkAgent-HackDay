// Microsoft Teams DEVELOPMENT MOCK from the command line (docs/integrations/MICROSOFT_TEAMS_MOCK_SETUP.md).
//   npm run teams:mock:seed    seed Violin Technologies and import the mock Teams data (idempotent)
//   npm run teams:mock:reset   delete only what the mock created
// Needs TEAMS_INTEGRATION_MODE=mock for seeding; refuses to run in production.
import { pool } from '../db/pool.js';
import { mockSummary, resetMock, syncMock } from '../services/integrations/mock/teamsMock.js';

const command = process.argv[2];
try {
  if (command === 'seed') {
    const s = await syncMock();
    console.log(JSON.stringify({ connection: s.connection, counts: s.counts, skippedEmployees: s.skippedEmployees }, null, 2));
  } else if (command === 'reset') {
    console.log(JSON.stringify({ deleted: await resetMock(), after: (await mockSummary()).counts }, null, 2));
  } else {
    console.error('Usage: node src/scripts/teamsMock.js seed|reset');
    process.exitCode = 2;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
