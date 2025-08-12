const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const http = require('http');

// Ensure required env vars exist for session configuration
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'testsecret';

function createApp() {
  const app = express();
  const isProduction = process.env.NODE_ENV === 'production';
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      sameSite: isProduction ? 'strict' : 'lax',
    },
  }));

  // Route that does not touch the session
  app.get('/no-session', (req, res) => {
    res.sendStatus(200);
  });

  // Route that modifies the session
  app.get('/with-session', (req, res) => {
    req.session.touched = true;
    res.sendStatus(200);
  });

  return app;
}

test('session cookie only set after modification', async () => {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();

  const base = `http://127.0.0.1:${port}`;

  // Hitting route without modifying session should not yield a cookie
  let res = await fetch(`${base}/no-session`);
  assert.equal(res.headers.get('set-cookie'), null);

  // Hitting route that modifies session should yield a cookie
  res = await fetch(`${base}/with-session`);
  assert.notEqual(res.headers.get('set-cookie'), null);

  server.close();
});
