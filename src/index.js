'use strict';

const fs = require('node:fs');
const { loadConfig, assertSafeForProduction } = require('./config');
const { createLogger } = require('./logger');
const { createEngine } = require('./engine');
const { createApp } = require('./http/app');
const { attachRealtime } = require('./http/realtime');

if (fs.existsSync('.env') && typeof process.loadEnvFile === 'function') process.loadEnvFile('.env');

const config = loadConfig();
assertSafeForProduction(config);
const logger = createLogger();
const engine = createEngine({ config, logger });
const app = createApp(engine);

engine.startWorker();
const server = app.listen(config.port, () => {
  logger.info('campus-notification-engine listening', {
    port: config.port, db: config.dbPath, emailProvider: engine.ctx.emailProvider.name,
    inboxSessionAuth: config.inboxSessionAuth,
  });
});

const realtime = attachRealtime(server, engine);

const shutdown = async () => {
  realtime.close();
  server.close();
  await engine.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
