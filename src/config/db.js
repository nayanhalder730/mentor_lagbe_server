import { MongoClient } from 'mongodb';

const DEFAULT_DB_NAME = 'mentor_lagbe';

let client = null;
let db = null;
let connectionPromise = null;

/**
 * Resolves the database name:
 * 1. Explicit DB_NAME environment variable.
 * 2. Database path from the MongoDB URI, when present.
 * 3. Project default.
 */
function resolveDbName() {
  if (process.env.DB_NAME) {
    return process.env.DB_NAME;
  }

  const uri = process.env.MONGODB_URI || '';
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);

  if (match && match[1]) {
    return decodeURIComponent(match[1]);
  }

  return DEFAULT_DB_NAME;
}

/**
 * Creates a single reusable MongoDB connection.
 * Safe to call multiple times; concurrent calls share the same promise.
 */
export async function connectToDatabase() {
  if (db) {
    return db;
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }

  connectionPromise = (async () => {
    const mongoClient = new MongoClient(process.env.MONGODB_URI);

    try {
      await mongoClient.connect();
      const database = mongoClient.db(resolveDbName());
      await database.command({ ping: 1 });

      client = mongoClient;
      db = database;

      console.log(`MongoDB connected (database: ${resolveDbName()})`);
      return db;
    } catch (error) {
      await mongoClient.close().catch(() => {});
      throw error;
    } finally {
      connectionPromise = null;
    }
  })();

  return connectionPromise;
}

/**
 * Returns the connected database instance.
 * Throws if connectToDatabase() has not completed successfully.
 */
export function getDb() {
  if (!db) {
    throw new Error('Database is not connected');
  }

  return db;
}

/**
 * Checks the live database connection without leaking error details.
 */
export async function isDatabaseConnected() {
  if (!db) {
    return false;
  }

  try {
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the MongoDB client (used during graceful shutdown).
 */
export async function closeDatabase() {
  if (client) {
    await client.close();
  }

  client = null;
  db = null;
  connectionPromise = null;
}
