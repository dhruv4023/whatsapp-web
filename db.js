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
    CREATE TABLE IF NOT EXISTS whatsapp_web_session (
      client_id VARCHAR(255) NOT NULL PRIMARY KEY,
      creds TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_modified_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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
    INSERT INTO whatsapp_web_session (client_id, creds)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE creds = VALUES(creds)
  `;

  await pool.query(sql, [clientId, credsStr]);
}

async function getCredsFromDb(clientId) {
  const [rows] = await pool.query('SELECT creds FROM whatsapp_web_session WHERE client_id = ?', [clientId]);
  if (rows.length === 0) return null;
  return { creds: parseBaileysData(rows[0].creds) };
}

async function deleteCredsFromDb(clientId) {
  try {
    await pool.query('DELETE FROM whatsapp_web_session WHERE client_id = ?', [clientId]);
  } catch (error) {
  }
}

async function updateWhatsAppStatus(studioId, status) {
  try {
    const sql = `UPDATE branch SET whatsapp_status = ? WHERE id = ?`;
    await pool.query(sql, [status, studioId]);
  } catch (err) {
    console.error('Error updating WhatsApp status:', err.message);
  }
}


module.exports = {
  initDb,
  saveToDb,
  getCredsFromDb,
  deleteCredsFromDb,
  updateWhatsAppStatus
};
