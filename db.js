const mysql = require('mysql2/promise');
require('dotenv').config(); // Load environment variables

// Configure your DB connection here
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

async function initDb() {
  const sql = `
    CREATE TABLE IF NOT EXISTS ww_sessions (
      client_id VARCHAR(255) NOT NULL PRIMARY KEY,
      creds TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      test INT NOT NULL DEFAULT 0
    ) ENGINE = InnoDB;
  `;
  await pool.query(sql);
}

function parseBaileysData(jsonStr) {
  function reviveBuffer(key, value) {
    if (
      value &&
      typeof value === 'object' &&
      value.type === 'Buffer' &&
      Array.isArray(value.data)
    ) {
      return Buffer.from(value.data);
    }
    return value;
  }

  try {
    const parsed = JSON.parse(jsonStr, reviveBuffer);
    return parsed;
  } catch (err) {
    console.error('Failed to parse:', err.message);
    return null;
  }
}


async function saveToDb(clientId, creds) {
  const credsStr = JSON.stringify(creds);
  const sql = `
    INSERT INTO ww_sessions (client_id, creds)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE creds = VALUES(creds)
  `;

  await pool.query(sql, [clientId, credsStr]);
}

async function getCredsFromDb(clientId) {
  const [rows] = await pool.query('SELECT creds FROM ww_sessions WHERE client_id = ?', [clientId]);
  if (rows.length === 0) return null;
  return { creds: parseBaileysData(rows[0].creds) };
}

async function deleteCredsFromDb(clientId) {
  try {
    await pool.query('DELETE FROM ww_sessions WHERE client_id = ?', [clientId]);
  } catch (error) {
  }
}

module.exports = {
  initDb,
  saveToDb,
  getCredsFromDb,
  deleteCredsFromDb
};

// async function x() {
//   console.log((await getCredsFromDb("clientA")))
// }

// x()

