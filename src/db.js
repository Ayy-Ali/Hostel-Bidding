const mysql = require("mysql2/promise");
const { DB_CONFIG } = require("./config");

let pool;

function escapeIdentifier(value) {
  if (!/^[A-Za-z0-9_]+$/.test(value)) {
    throw new Error("Database name contains unsupported characters.");
  }

  return `\`${value}\``;
}

async function createDatabaseIfNeeded() {
  const bootstrapPool = mysql.createPool({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    waitForConnections: true,
    connectionLimit: 4,
  });

  await bootstrapPool.query(
    `CREATE DATABASE IF NOT EXISTS ${escapeIdentifier(DB_CONFIG.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await bootstrapPool.end();
}

async function initializePool() {
  if (pool) {
    return pool;
  }

  await createDatabaseIfNeeded();

  pool = mysql.createPool({
    host: DB_CONFIG.host,
    port: DB_CONFIG.port,
    database: DB_CONFIG.database,
    user: DB_CONFIG.user,
    password: DB_CONFIG.password,
    ssl: DB_CONFIG.ssl ? {} : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: "local",
  });

  return pool;
}

async function getPool() {
  return initializePool();
}

async function closePool() {
  if (!pool) {
    return;
  }

  const activePool = pool;
  pool = null;
  await activePool.end();
}

async function query(sql, params = []) {
  const activePool = await initializePool();
  const [rows] = await activePool.query(sql, params);
  return rows;
}

async function execute(sql, params = []) {
  const activePool = await initializePool();
  const [result] = await activePool.execute(sql, params);
  return result;
}

async function withTransaction(work) {
  const activePool = await initializePool();
  const connection = await activePool.getConnection();

  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

module.exports = {
  closePool,
  execute,
  getPool,
  query,
  withTransaction,
};
