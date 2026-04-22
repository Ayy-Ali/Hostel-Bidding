const bcrypt = require("bcryptjs");

const {
  ADMIN_ACCOUNT,
  AUCTION_SETTINGS,
  DEFAULT_SESSION_ID,
} = require("./config");
const { query, withTransaction } = require("./db");

async function columnExists(tableName, columnName) {
  const rows = await query(
    `SELECT 1
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
     LIMIT 1`,
    [tableName, columnName],
  );

  return rows.length > 0;
}

async function indexExists(tableName, indexName) {
  const rows = await query(
    `SELECT 1
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND INDEX_NAME = ?
     LIMIT 1`,
    [tableName, indexName],
  );

  return rows.length > 0;
}

async function createTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS admins (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS captain_slots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      slot_key VARCHAR(64) NOT NULL UNIQUE,
      slot_number INT NOT NULL UNIQUE,
      slot_label VARCHAR(64) NOT NULL,
      default_team_name VARCHAR(64) NOT NULL,
      captain_code VARCHAR(64) NOT NULL UNIQUE,
      accent VARCHAR(16) NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS auction_sessions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_key VARCHAR(80) NOT NULL UNIQUE,
      title VARCHAR(120) NOT NULL,
      status ENUM('setup', 'waiting', 'running', 'paused', 'complete') NOT NULL DEFAULT 'setup',
      base_price INT NOT NULL,
      min_increment INT NOT NULL,
      team_budget INT NOT NULL,
      auction_duration_ms INT NOT NULL,
      current_lot_id INT NULL,
      current_bid INT NULL,
      current_highest_team_id INT NULL,
      current_highest_captain_name VARCHAR(80) NULL,
      auction_end_time DATETIME NULL,
      paused_remaining_ms INT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS teams (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      captain_slot_id INT NULL,
      captain_code VARCHAR(80) NULL,
      team_name VARCHAR(80) NOT NULL,
      captain_display_name VARCHAR(80) NULL,
      total_budget INT NOT NULL,
      remaining_budget INT NOT NULL,
      accent VARCHAR(16) NOT NULL DEFAULT '#ff7a18',
      created_order INT NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_session_slot (session_id, captain_slot_id),
      UNIQUE KEY unique_session_captain_code (session_id, captain_code),
      CONSTRAINT fk_teams_session FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_teams_slot FOREIGN KEY (captain_slot_id) REFERENCES captain_slots(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS players (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      player_name VARCHAR(120) NOT NULL,
      entered_order INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY unique_player_order (session_id, entered_order),
      CONSTRAINT fk_players_session FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS auction_lots (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      player_id INT NOT NULL,
      source_lot_id INT NULL,
      lot_number INT NOT NULL,
      rebid_round INT NOT NULL DEFAULT 0,
      base_price INT NOT NULL,
      status ENUM('queued', 'running', 'sold', 'unsold') NOT NULL DEFAULT 'queued',
      queued_for_rebid TINYINT(1) NOT NULL DEFAULT 0,
      ended_by ENUM('timer', 'admin') NULL,
      winning_team_id INT NULL,
      winning_captain_name VARCHAR(80) NULL,
      final_price INT NULL,
      sold_at DATETIME NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_lot_number (session_id, lot_number),
      CONSTRAINT fk_lots_session FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_lots_player FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
      CONSTRAINT fk_lots_source_lot FOREIGN KEY (source_lot_id) REFERENCES auction_lots(id) ON DELETE SET NULL,
      CONSTRAINT fk_lots_team FOREIGN KEY (winning_team_id) REFERENCES teams(id) ON DELETE SET NULL
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS bids (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      lot_id INT NOT NULL,
      team_id INT NOT NULL,
      captain_name VARCHAR(80) NOT NULL,
      bid_amount INT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_bids_session FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_bids_lot FOREIGN KEY (lot_id) REFERENCES auction_lots(id) ON DELETE CASCADE,
      CONSTRAINT fk_bids_team FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS match_history (
      id INT AUTO_INCREMENT PRIMARY KEY,
      match_date DATE NOT NULL,
      title VARCHAR(120) NOT NULL,
      venue VARCHAR(80) NULL,
      result VARCHAR(40) NULL,
      score VARCHAR(40) NULL,
      notes VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS session_matchups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      session_id INT NOT NULL,
      round_number INT NOT NULL,
      team_one_id INT NOT NULL,
      team_two_id INT NULL,
      match_label VARCHAR(180) NOT NULL,
      status VARCHAR(40) NOT NULL DEFAULT 'scheduled',
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      CONSTRAINT fk_matchups_session FOREIGN KEY (session_id) REFERENCES auction_sessions(id) ON DELETE CASCADE,
      CONSTRAINT fk_matchups_team_one FOREIGN KEY (team_one_id) REFERENCES teams(id) ON DELETE CASCADE,
      CONSTRAINT fk_matchups_team_two FOREIGN KEY (team_two_id) REFERENCES teams(id) ON DELETE SET NULL
    )
  `);
}

async function runMigrations() {
  await query(`
    ALTER TABLE auction_sessions
    MODIFY status ENUM('setup', 'waiting', 'running', 'paused', 'complete') NOT NULL DEFAULT 'setup'
  `);

  if (!(await columnExists("auction_sessions", "paused_remaining_ms"))) {
    await query(`
      ALTER TABLE auction_sessions
      ADD COLUMN paused_remaining_ms INT NULL AFTER auction_end_time
    `);
  }

  await query(`
    ALTER TABLE teams
    MODIFY captain_slot_id INT NULL
  `);

  if (!(await columnExists("teams", "captain_code"))) {
    await query(`
      ALTER TABLE teams
      ADD COLUMN captain_code VARCHAR(80) NULL AFTER captain_slot_id
    `);
  }

  if (!(await columnExists("teams", "accent"))) {
    await query(`
      ALTER TABLE teams
      ADD COLUMN accent VARCHAR(16) NOT NULL DEFAULT '#ff7a18' AFTER remaining_budget
    `);
  }

  if (!(await columnExists("teams", "created_order"))) {
    await query(`
      ALTER TABLE teams
      ADD COLUMN created_order INT NOT NULL DEFAULT 0 AFTER accent
    `);
  }

  if (!(await indexExists("teams", "unique_session_captain_code"))) {
    await query(`
      CREATE UNIQUE INDEX unique_session_captain_code
      ON teams (session_id, captain_code)
    `);
  }
}

async function seedAdmin() {
  const passwordHash = await bcrypt.hash(ADMIN_ACCOUNT.password, 10);
  const existingRows = await query(`SELECT id FROM admins WHERE username = ? LIMIT 1`, [
    ADMIN_ACCOUNT.username,
  ]);

  if (existingRows.length) {
    await query(`UPDATE admins SET password_hash = ? WHERE id = ?`, [
      passwordHash,
      existingRows[0].id,
    ]);
    return;
  }

  await query(`INSERT INTO admins (username, password_hash) VALUES (?, ?)`, [
    ADMIN_ACCOUNT.username,
    passwordHash,
  ]);
}

async function cleanupLegacyTeams(connection, sessionId) {
  const [activityRows] = await connection.execute(
    `SELECT
        (SELECT COUNT(*) FROM auction_lots WHERE session_id = ?) AS lot_count,
        (SELECT COUNT(*) FROM bids WHERE session_id = ?) AS bid_count,
        (SELECT COUNT(*) FROM teams WHERE session_id = ? AND captain_code IS NOT NULL) AS dynamic_team_count
     `,
    [sessionId, sessionId, sessionId],
  );

  const activity = activityRows[0];

  if (Number(activity.lot_count) > 0 || Number(activity.bid_count) > 0) {
    return;
  }

  if (Number(activity.dynamic_team_count) > 0) {
    await connection.execute(
      `DELETE FROM teams
       WHERE session_id = ? AND captain_code IS NULL`,
      [sessionId],
    );
    return;
  }

  await connection.execute(`DELETE FROM teams WHERE session_id = ?`, [sessionId]);
}

async function ensureSession(sessionKey = DEFAULT_SESSION_ID) {
  return withTransaction(async (connection) => {
    const [existingSessions] = await connection.execute(
      `SELECT id
       FROM auction_sessions
       WHERE session_key = ?
       LIMIT 1`,
      [sessionKey],
    );

    let sessionId;

    if (existingSessions.length) {
      sessionId = existingSessions[0].id;
      await connection.execute(
        `UPDATE auction_sessions
         SET title = ?, base_price = ?, min_increment = ?, team_budget = ?, auction_duration_ms = ?
         WHERE id = ?`,
        [
          "Hostel Football Auction",
          AUCTION_SETTINGS.basePrice,
          AUCTION_SETTINGS.minIncrement,
          AUCTION_SETTINGS.teamBudget,
          AUCTION_SETTINGS.auctionDurationMs,
          sessionId,
        ],
      );
    } else {
      const [insertSession] = await connection.execute(
        `INSERT INTO auction_sessions (
           session_key,
           title,
           status,
           base_price,
           min_increment,
           team_budget,
           auction_duration_ms
         )
         VALUES (?, ?, 'setup', ?, ?, ?, ?)`,
        [
          sessionKey,
          "Hostel Football Auction",
          AUCTION_SETTINGS.basePrice,
          AUCTION_SETTINGS.minIncrement,
          AUCTION_SETTINGS.teamBudget,
          AUCTION_SETTINGS.auctionDurationMs,
        ],
      );

      sessionId = insertSession.insertId;
    }

    await cleanupLegacyTeams(connection, sessionId);

    return sessionId;
  });
}

async function initializeDatabase() {
  await createTables();
  await runMigrations();
  await seedAdmin();
  await ensureSession(DEFAULT_SESSION_ID);
}

module.exports = {
  ensureSession,
  initializeDatabase,
};
