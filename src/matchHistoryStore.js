const { query, execute } = require("./db");

function collapseWhitespace(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function sanitizeRecord(payload = {}) {
  return {
    date: collapseWhitespace(payload.date).slice(0, 20),
    title: collapseWhitespace(payload.title).slice(0, 120),
    venue: collapseWhitespace(payload.venue).slice(0, 80),
    result: collapseWhitespace(payload.result).slice(0, 40),
    score: collapseWhitespace(payload.score).slice(0, 40),
    notes: collapseWhitespace(payload.notes).slice(0, 255),
  };
}

async function getMatchHistory() {
  return query(
    `SELECT
        id,
        DATE_FORMAT(match_date, '%Y-%m-%d') AS date,
        title,
        venue,
        result,
        score,
        notes,
        created_at
     FROM match_history
     ORDER BY match_date DESC, created_at DESC`,
  );
}

async function addMatchRecord(payload = {}) {
  const record = sanitizeRecord(payload);

  if (!record.title || !record.date) {
    return {
      ok: false,
      error: "Match title and date are required.",
    };
  }

  const insertResult = await execute(
    `INSERT INTO match_history (match_date, title, venue, result, score, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [record.date, record.title, record.venue || null, record.result || null, record.score || null, record.notes || null],
  );

  const rows = await query(
    `SELECT
        id,
        DATE_FORMAT(match_date, '%Y-%m-%d') AS date,
        title,
        venue,
        result,
        score,
        notes,
        created_at
     FROM match_history
     WHERE id = ?
     LIMIT 1`,
    [insertResult.insertId],
  );

  return {
    ok: true,
    record: rows[0],
  };
}

module.exports = {
  addMatchRecord,
  getMatchHistory,
};
