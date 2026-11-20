import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { once } from 'node:events';

import app from '../src/app.js';
import { createServerlessHandler } from '../src/serverless-handler.js';

function fakeApp() {
  const calls = [];

  const app = (req, res) => {
    calls.push({ req, res });
    return 'app-result';
  };

  return { app, calls };
}

test('serverless handler connects once for concurrent invocations', async () => {
  let connectCalls = 0;
  let resolveConnection;

  const connectToDatabase = () => {
    connectCalls += 1;
    return new Promise((resolve) => {
      resolveConnection = resolve;
    });
  };

  const { app: expressApp, calls } = fakeApp();
  const handler = createServerlessHandler({
    app: expressApp,
    connectToDatabase,
  });

  const reqA = { url: '/a' };
  const reqB = { url: '/b' };

  const first = handler(reqA, {});
  const second = handler(reqB, {});

  assert.equal(connectCalls, 1);

  resolveConnection();

  const results = await Promise.all([first, second]);

  assert.deepEqual(results, ['app-result', 'app-result']);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].req, reqA);
  assert.equal(calls[1].req, reqB);
});

test('serverless handler retries connection after a failure but still calls the app', async () => {
  let attempts = 0;
  const errors = [];

  const connectToDatabase = async () => {
    attempts += 1;

    if (attempts === 1) {
      throw new Error('connection failed');
    }
  };

  const { app: expressApp, calls } = fakeApp();
  const handler = createServerlessHandler({
    app: expressApp,
    connectToDatabase,
    onConnectionError: (error) => errors.push(error.message),
  });

  await handler({}, {});
  await handler({}, {});

  assert.equal(attempts, 2);
  assert.deepEqual(errors, ['connection failed']);
  assert.equal(calls.length, 2);
});

test('vercel rewrites all paths to the serverless entry point', () => {
  const config = JSON.parse(
    readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')
  );

  assert.deepEqual(config.rewrites, [
    { source: '/(.*)', destination: '/api/index.js' },
  ]);
});

test('the deployed entry point exports a callable handler', async () => {
  const module = await import('../api/index.js');

  assert.equal(typeof module.default, 'function');
});

test('Express root returns a simple health response', async () => {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.service, 'MentorLagbe API');
    assert.equal(body.health, '/api/health');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('health route reports database state without requiring a connection', async () => {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.success, false);
    assert.equal(body.status, 'degraded');
    assert.equal(body.database, 'disconnected');
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('unknown routes still use the existing not-found response', async () => {
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/missing`);
    const body = await response.json();

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.message, 'Route not found');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
