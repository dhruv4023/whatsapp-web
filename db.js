const mysql = require('mysql2/promise');

// Configure your DB connection here
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'whatsapp_db',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

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
    INSERT INTO sessions (client_id, creds)
    VALUES (?, ?)
    ON DUPLICATE KEY UPDATE creds = VALUES(creds)
  `;

  await pool.query(sql, [clientId, credsStr]);
}

async function getCredsFromDb(clientId) {
  const [rows] = await pool.query('SELECT creds FROM sessions WHERE client_id = ?', [clientId]);
  if (rows.length === 0) return null;
  return { creds: parseBaileysData(rows[0].creds) };
}

async function deleteCredsFromDb(clientId) {
  await pool.query('DELETE FROM sessions WHERE client_id = ?', [clientId]);
}

module.exports = {
  saveToDb,
  getCredsFromDb,
  deleteCredsFromDb
};

// async function x() {
//   console.log((await getCredsFromDb("clientA")))
// }

// x()

