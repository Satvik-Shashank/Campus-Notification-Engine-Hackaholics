'use strict';

// One command to run the product locally with a populated campus. DEMO_MODE additionally enables
// the unlinked developer verification page (/internal/verify) and lets students sign in without SSO.
const fs = require('node:fs');

if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');
process.env.DEMO_MODE = 'true';
if (!process.env.DB_PATH) process.env.DB_PATH = './data/demo.db';

const { loadConfig } = require('../src/config');
const { runSeed } = require('../src/seed');

runSeed(loadConfig()).then((r) => {
  console.log(`Seeded ${r.students} students (${r.replayed} historical events replayed). Open http://localhost:${process.env.PORT || 3000}/`);
  require('../src/index');
});
