const tools = require('auth0-extension-express-tools');

const expressApp = require('./server');
const logger = require('./server/lib/logger');

module.exports = tools.createServer((config, storage) => {
  logger.info('Starting Logs to Papertrail extension - Version:', process.env.CLIENT_VERSION);
  return expressApp(config, storage);
});
