import mysql from "mysql2/promise";

const {
  MYSQL_HOST = "localhost",
  MYSQL_PORT = "3306",
  MYSQL_USER = "root",
  MYSQL_PASSWORD = "",
  MYSQL_DATABASE = "voiceagent",
} = process.env;

export const pool = mysql.createPool({
  host: MYSQL_HOST,
  port: +MYSQL_PORT,
  user: MYSQL_USER,
  password: MYSQL_PASSWORD,
  database: MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

export async function initSchema() {
  await pool.execute(
    `CREATE TABLE IF NOT EXISTS transcriptions (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      callSid VARCHAR(64) NOT NULL,
      streamSid VARCHAR(64) NOT NULL,
      outputPath VARCHAR(255) NOT NULL,
      transcript JSON NOT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_callSid (callSid),
      KEY idx_streamSid (streamSid)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

export async function saveTranscription(callSid, streamSid, outputPath, transcriptObj) {
  const [result] = await pool.execute(
    `INSERT INTO transcriptions (callSid, streamSid, outputPath, transcript) VALUES (?, ?, ?, CAST(? AS JSON))`,
    [callSid, streamSid, outputPath, JSON.stringify(transcriptObj)]
  );
  return result.insertId;
}


