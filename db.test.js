const { test } = require('node:test');
const assert = require('node:assert');

const DB_ENV_VARS = {
  DB_HOST: 'localhost',
  DB_PORT: '5432',
  DB_USER: 'user',
  DB_PASSWORD: 'password',
  DB_DATABASE: 'database',
};

test('db.js loads when all required env vars are set', { concurrency: false }, () => {
  for (const [key, value] of Object.entries(DB_ENV_VARS)) {
    process.env[key] = value;
  }
  delete require.cache[require.resolve('./db')];
  assert.doesNotThrow(() => require('./db'));
});

test('db.js throws if a required env var is missing', { concurrency: false }, () => {
  for (const [key, value] of Object.entries(DB_ENV_VARS)) {
    process.env[key] = value;
  }
  delete process.env.DB_HOST;
  delete require.cache[require.resolve('./db')];
  assert.throws(() => require('./db'), /DB_HOST/);
});
