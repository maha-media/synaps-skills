/**
 * @file bridge/core/db/connect.test.js
 *
 * Tests for the lazy mongoose connection singleton.
 *
 * Uses mongodb-memory-server to run an in-process MongoDB instance.
 * If the binary download is blocked at install time, set:
 *   MONGOMS_DISABLE_POSTINSTALL=1 npm install
 * and the binary will be fetched on first test run instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { getMongoose, disconnect, isConnected } from './connect.js';

let mongod;
let uri;

/** Suppress connect/disconnect log noise in tests. */
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri();
}, 120_000); // allow time for first-run binary download

afterAll(async () => {
  await disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  // Start each test disconnected so state is predictable.
  await disconnect();
});

describe('getMongoose()', () => {
  it('returns a mongoose instance and isConnected() becomes true', async () => {
    expect(isConnected()).toBe(false);
    const m = await getMongoose(uri, { logger: silentLogger });
    expect(m).toBeDefined();
    expect(typeof m.connect).toBe('function');
    expect(isConnected()).toBe(true);
  });

  it('calling twice returns the same instance without reconnecting', async () => {
    const m1 = await getMongoose(uri, { logger: silentLogger });
    const m2 = await getMongoose(uri, { logger: silentLogger });
    expect(m1).toBe(m2);
  });

  it('rejects with an error when given a bad URI (timeout)', async () => {
    // Use a URI that will fail server selection quickly.
    const badUri = 'mongodb://127.0.0.1:1/nodb';
    await expect(
      getMongoose(badUri, { logger: silentLogger }),
    ).rejects.toThrow();
  }, 10_000);
});

describe('disconnect()', () => {
  it('sets isConnected() to false after disconnecting', async () => {
    await getMongoose(uri, { logger: silentLogger });
    expect(isConnected()).toBe(true);
    await disconnect();
    expect(isConnected()).toBe(false);
  });

  it('allows reconnect after disconnect', async () => {
    await getMongoose(uri, { logger: silentLogger });
    await disconnect();
    expect(isConnected()).toBe(false);

    const m = await getMongoose(uri, { logger: silentLogger });
    expect(isConnected()).toBe(true);
    expect(m).toBeDefined();
  });

  it('is idempotent when already disconnected', async () => {
    // Should not throw.
    await disconnect();
    await disconnect();
    expect(isConnected()).toBe(false);
  });
});
