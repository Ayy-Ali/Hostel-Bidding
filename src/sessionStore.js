const bcrypt = require("bcryptjs");

const {
  ADMIN_ACCOUNT,
  AUCTION_SETTINGS,
  MAX_PLAYERS,
  TEAM_ACCENTS,
} = require("./config");
const { ensureSession } = require("./bootstrap");
const { query, withTransaction } = require("./db");

function collapseWhitespace(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function titleCaseWords(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function sanitizeCaptainName(value) {
  const normalized = titleCaseWords(value);
  return normalized ? normalized.slice(0, 40) : "";
}

function sanitizeTeamName(value) {
  const normalized = collapseWhitespace(value);
  return normalized ? normalized.slice(0, 28) : "";
}

function sanitizePlayerNames(input) {
  const rawNames = Array.isArray(input) ? input : String(input ?? "").split(/\r?\n/);

  return rawNames
    .map((name) => collapseWhitespace(name))
    .filter(Boolean)
    .map((name) => name.slice(0, 50));
}

function normalizeCaptainCode(value) {
  return collapseWhitespace(value).toLowerCase().slice(0, 64);
}

function resolveCaptainIdentity(displayName, captainCode) {
  const rawName = collapseWhitespace(displayName || captainCode);

  return {
    captainDisplayName: sanitizeCaptainName(rawName),
    captainCode: normalizeCaptainCode(captainCode || rawName),
  };
}

function shuffleItems(items) {
  const nextItems = [...items];

  for (let index = nextItems.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [nextItems[index], nextItems[swapIndex]] = [nextItems[swapIndex], nextItems[index]];
  }

  return nextItems;
}

function buildPublicLot(row) {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    lotNumber: row.lot_number,
    name: row.player_name,
    basePrice: row.base_price,
    rebidRound: row.rebid_round,
    sourceLotId: row.source_lot_id,
  };
}

function buildPublicResult(row, teamById) {
  if (!row) {
    return null;
  }

  const winningTeam = row.winning_team_id ? teamById.get(row.winning_team_id) : null;

  return {
    id: row.id,
    lotNumber: row.lot_number,
    name: row.player_name,
    basePrice: row.base_price,
    rebidRound: row.rebid_round,
    sourceLotId: row.source_lot_id,
    status: row.status,
    soldPrice: row.final_price,
    soldTo: winningTeam
      ? {
          teamId: winningTeam.id,
          teamName: winningTeam.name,
          captainName: row.winning_captain_name,
        }
      : null,
    soldAt: row.sold_at ? new Date(row.sold_at).toISOString() : null,
    endedBy: row.ended_by ?? "timer",
    queuedForRebid: Boolean(row.queued_for_rebid),
  };
}

function buildPublicMatchup(row) {
  return {
    id: row.id,
    roundNumber: row.round_number,
    status: row.status,
    matchLabel: row.match_label,
    teamOneName: row.team_one_name,
    teamTwoName: row.team_two_name,
  };
}

async function getSessionRow(sessionKey) {
  await ensureSession(sessionKey);

  const rows = await query(
    `SELECT *
     FROM auction_sessions
     WHERE session_key = ?
     LIMIT 1`,
    [sessionKey],
  );

  return rows[0] ?? null;
}

async function getTeams(sessionId) {
  return query(
    `SELECT
        id,
        team_name AS name,
        captain_display_name AS captain_name,
        captain_code,
        total_budget,
        remaining_budget,
        accent,
        created_order
     FROM teams
     WHERE session_id = ?
     ORDER BY created_order ASC, id ASC`,
    [sessionId],
  );
}

async function getLotRows(sessionId, sqlTail, params = []) {
  return query(
    `SELECT
        l.id,
        l.player_id,
        l.source_lot_id,
        l.lot_number,
        l.rebid_round,
        l.base_price,
        l.status,
        l.queued_for_rebid,
        l.ended_by,
        l.winning_team_id,
        l.winning_captain_name,
        l.final_price,
        l.sold_at,
        p.player_name
     FROM auction_lots l
     INNER JOIN players p ON p.id = l.player_id
     WHERE l.session_id = ?
     ${sqlTail}`,
    [sessionId, ...params],
  );
}

async function clearSessionMatchups(connection, sessionId) {
  await connection.execute(`DELETE FROM session_matchups WHERE session_id = ?`, [sessionId]);
}

async function createSessionMatchups(connection, sessionId) {
  const [teamRows] = await connection.execute(
    `SELECT id, team_name
     FROM teams
     WHERE session_id = ?
     ORDER BY created_order ASC, id ASC`,
    [sessionId],
  );

  if (teamRows.length < 2) {
    return;
  }

  const shuffledTeams = shuffleItems(teamRows);

  for (let index = 0; index < shuffledTeams.length; index += 2) {
    const teamOne = shuffledTeams[index];
    const teamTwo = shuffledTeams[index + 1] ?? null;
    const roundNumber = Math.floor(index / 2) + 1;

    if (teamTwo) {
      await connection.execute(
        `INSERT INTO session_matchups (
           session_id,
           round_number,
           team_one_id,
           team_two_id,
           match_label,
           status
         )
         VALUES (?, ?, ?, ?, ?, 'scheduled')`,
        [
          sessionId,
          roundNumber,
          teamOne.id,
          teamTwo.id,
          `${teamOne.team_name} vs ${teamTwo.team_name}`,
        ],
      );
      continue;
    }

    await connection.execute(
      `INSERT INTO session_matchups (
         session_id,
         round_number,
         team_one_id,
         team_two_id,
         match_label,
         status
       )
       VALUES (?, ?, ?, NULL, ?, 'bye')`,
      [sessionId, roundNumber, teamOne.id, `${teamOne.team_name} gets a bye`],
    );
  }
}

async function getSessionState(sessionKey) {
  const session = await getSessionRow(sessionKey);

  if (!session) {
    throw new Error("Auction session could not be loaded.");
  }

  const [
    teams,
    currentLotRows,
    rosterRows,
    recentRows,
    unsoldRows,
    upcomingRows,
    configuredPlayers,
    completedCountRows,
    matchupRows,
  ] = await Promise.all([
    getTeams(session.id),
    session.current_lot_id
      ? query(
          `SELECT
              l.id,
              l.player_id,
              l.source_lot_id,
              l.lot_number,
              l.rebid_round,
              l.base_price,
              p.player_name
           FROM auction_lots l
           INNER JOIN players p ON p.id = l.player_id
           WHERE l.id = ?
           LIMIT 1`,
          [session.current_lot_id],
        )
      : Promise.resolve([]),
    getLotRows(session.id, `AND l.status = 'sold' ORDER BY l.lot_number ASC`),
    getLotRows(
      session.id,
      `AND l.status IN ('sold', 'unsold') ORDER BY l.lot_number DESC LIMIT 12`,
    ),
    getLotRows(session.id, `AND l.status = 'unsold' ORDER BY l.lot_number DESC`),
    getLotRows(session.id, `AND l.status = 'queued' ORDER BY l.lot_number ASC`),
    query(
      `SELECT player_name
       FROM players
       WHERE session_id = ?
       ORDER BY entered_order ASC`,
      [session.id],
    ),
    query(
      `SELECT COUNT(*) AS count
       FROM auction_lots
       WHERE session_id = ? AND status IN ('sold', 'unsold')`,
      [session.id],
    ),
    query(
      `SELECT
          m.id,
          m.round_number,
          m.status,
          m.match_label,
          t1.team_name AS team_one_name,
          t2.team_name AS team_two_name
       FROM session_matchups m
       INNER JOIN teams t1 ON t1.id = m.team_one_id
       LEFT JOIN teams t2 ON t2.id = m.team_two_id
       WHERE m.session_id = ?
       ORDER BY m.round_number ASC, m.id ASC`,
      [session.id],
    ),
  ]);

  const teamMap = new Map();
  const rosterByTeam = new Map();

  for (const team of teams) {
    const publicTeam = {
      id: team.id,
      name: team.name,
      accent: team.accent,
      captainName: team.captain_name,
      captainCode: team.captain_code,
      budget: team.total_budget,
      remainingBudget: team.remaining_budget,
      spentAmount: team.total_budget - team.remaining_budget,
      playersPurchased: 0,
      roster: [],
    };

    teamMap.set(team.id, publicTeam);
    rosterByTeam.set(team.id, []);
  }

  for (const row of rosterRows) {
    const publicResult = buildPublicResult(row, teamMap);

    if (publicResult?.soldTo) {
      rosterByTeam.get(publicResult.soldTo.teamId).push(publicResult);
    }
  }

  const publicTeams = [...teamMap.values()].map((team) => {
    const roster = rosterByTeam.get(team.id) ?? [];
    return {
      ...team,
      playersPurchased: roster.length,
      roster,
    };
  });

  const leadingTeam = session.current_highest_team_id
    ? publicTeams.find((team) => team.id === session.current_highest_team_id)
    : null;

  const now = Date.now();
  const runningEndTime = session.auction_end_time
    ? new Date(session.auction_end_time).getTime()
    : null;
  const remainingTimeMs = session.status === "paused"
    ? Math.max(Number(session.paused_remaining_ms ?? 0), 0)
    : runningEndTime
      ? Math.max(runningEndTime - now, 0)
      : 0;

  return {
    sessionId: session.session_key,
    status: session.status,
    serverNow: now,
    currentPlayer: buildPublicLot(currentLotRows[0] ?? null),
    currentBid: session.current_lot_id ? session.current_bid : null,
    highestBidder: leadingTeam
      ? {
          teamId: leadingTeam.id,
          teamName: leadingTeam.name,
          displayName: session.current_highest_captain_name,
        }
      : null,
    auctionEndTime: session.status === "running" && runningEndTime ? runningEndTime : null,
    remainingTimeMs,
    teams: publicTeams,
    recentResults: recentRows.map((row) => buildPublicResult(row, teamMap)),
    unsoldPlayers: unsoldRows.map((row) => buildPublicResult(row, teamMap)),
    configuredPlayers: configuredPlayers.map((row) => row.player_name),
    upcomingPlayers: upcomingRows.map(buildPublicLot),
    matchups: matchupRows.map(buildPublicMatchup),
    liveViewers: 0,
    minIncrement: session.min_increment,
    auctionDurationMs: session.auction_duration_ms,
    basePrice: session.base_price,
    teamBudget: session.team_budget,
    maxPlayers: MAX_PLAYERS,
    canConfigurePlayers:
      !session.current_lot_id &&
      Number(completedCountRows[0]?.count ?? 0) === 0 &&
      session.status !== "running" &&
      session.status !== "paused",
    adminConnected: false,
  };
}

async function listRunningAuctions() {
  return query(
    `SELECT session_key, auction_end_time
     FROM auction_sessions
     WHERE status = 'running' AND auction_end_time IS NOT NULL`,
  );
}

async function verifyAdminCredentials(username, password) {
  const normalizedUsername = collapseWhitespace(username);
  const adminRows = await query(
    `SELECT username, password_hash
     FROM admins
     WHERE username = ?
     LIMIT 1`,
    [normalizedUsername],
  );

  if (!adminRows.length) {
    return {
      ok: false,
      error: "Administrator credentials are incorrect.",
    };
  }

  const matches = await bcrypt.compare(String(password ?? ""), adminRows[0].password_hash);

  if (!matches) {
    return {
      ok: false,
      error: "Administrator credentials are incorrect.",
    };
  }

  return {
    ok: true,
    viewer: {
      role: "admin",
      teamId: null,
      displayName: "Administrator",
    },
  };
}

async function getCaptainTeamByCode(sessionKey, captainCode) {
  const session = await getSessionRow(sessionKey);

  if (!session) {
    return null;
  }

  const rows = await query(
    `SELECT
        id,
        team_name AS name,
        captain_display_name AS captain_name,
        captain_code,
        accent
     FROM teams
     WHERE session_id = ? AND captain_code = ?
     LIMIT 1`,
    [session.id, normalizeCaptainCode(captainCode)],
  );

  return rows[0] ?? null;
}

async function joinCaptain(sessionKey, displayName, teamName, captainCodeInput) {
  const session = await getSessionRow(sessionKey);

  if (!session) {
    return {
      ok: false,
      error: "Auction session could not be loaded.",
    };
  }

  const identity = resolveCaptainIdentity(displayName, captainCodeInput);
  const nextTeamName = sanitizeTeamName(teamName);

  if (!identity.captainDisplayName) {
    return {
      ok: false,
      error: "Captain name is required.",
    };
  }

  if (!nextTeamName) {
    return {
      ok: false,
      error: "Team name is required.",
    };
  }

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];
    const [teamRows] = await connection.execute(
      `SELECT id, team_name, accent
       FROM teams
       WHERE session_id = ? AND captain_code = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id, identity.captainCode],
    );

    const [completedCountRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM auction_lots
       WHERE session_id = ? AND status IN ('sold', 'unsold')`,
      [session.id],
    );

    const canRegisterNewTeam =
      !lockedSession.current_lot_id &&
      Number(completedCountRows[0]?.count ?? 0) === 0 &&
      lockedSession.status !== "running" &&
      lockedSession.status !== "paused" &&
      lockedSession.status !== "complete";

    if (!teamRows.length && !canRegisterNewTeam) {
      return {
        ok: false,
        error: `Bidding has already started. Only captains who registered before bidding can rejoin — use the exact same name you used when you first joined.`,
      };
    }

    let teamId;
    let accent;
    let teamChanged = false;

    if (teamRows.length) {
      teamId = teamRows[0].id;
      accent = teamRows[0].accent;
      teamChanged = teamRows[0].team_name !== nextTeamName;

      if (canRegisterNewTeam) {
        await connection.execute(
          `UPDATE teams
           SET team_name = ?, captain_display_name = ?
           WHERE id = ?`,
          [nextTeamName, identity.captainDisplayName, teamId],
        );
      } else {
        await connection.execute(
          `UPDATE teams
           SET captain_display_name = ?
           WHERE id = ?`,
          [identity.captainDisplayName, teamId],
        );
      }
    } else {
      const [orderRows] = await connection.execute(
        `SELECT COALESCE(MAX(created_order), 0) AS max_order
         FROM teams
         WHERE session_id = ?`,
        [session.id],
      );

      const nextOrder = Number(orderRows[0]?.max_order ?? 0) + 1;
      accent = TEAM_ACCENTS[(nextOrder - 1) % TEAM_ACCENTS.length];

      const [insertTeam] = await connection.execute(
        `INSERT INTO teams (
           session_id,
           captain_slot_id,
           captain_code,
           team_name,
           captain_display_name,
           total_budget,
           remaining_budget,
           accent,
           created_order
         )
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
        [
          session.id,
          identity.captainCode,
          nextTeamName,
          identity.captainDisplayName,
          lockedSession.team_budget,
          lockedSession.team_budget,
          accent,
          nextOrder,
        ],
      );

      teamId = insertTeam.insertId;
      teamChanged = true;
    }

    return {
      ok: true,
      viewer: {
        role: "captain",
        teamId,
        displayName: identity.captainDisplayName,
      },
      team: {
        id: teamId,
        name: nextTeamName,
        accent,
        captainName: identity.captainDisplayName,
        captainCode: identity.captainCode,
      },
      teamChanged,
    };
  });
}

async function setPlayerPool(sessionKey, input) {
  const playerNames = sanitizePlayerNames(input);

  if (!playerNames.length) {
    return {
      ok: false,
      error: "Add at least one player before starting the auction.",
    };
  }

  if (playerNames.length > MAX_PLAYERS) {
    return {
      ok: false,
      error: `You can only load up to ${MAX_PLAYERS} players.`,
    };
  }

  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT id, current_lot_id, status
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    const [completedCountRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM auction_lots
       WHERE session_id = ? AND status IN ('sold', 'unsold')`,
      [session.id],
    );

    if (
      lockedSession.current_lot_id ||
      lockedSession.status === "paused" ||
      Number(completedCountRows[0]?.count ?? 0) > 0
    ) {
      return {
        ok: false,
        error: "Players can only be configured before the auction starts.",
      };
    }

    await connection.execute(`DELETE FROM bids WHERE session_id = ?`, [session.id]);
    await connection.execute(`DELETE FROM auction_lots WHERE session_id = ?`, [session.id]);
    await connection.execute(`DELETE FROM players WHERE session_id = ?`, [session.id]);
    await clearSessionMatchups(connection, session.id);

    const playerIds = [];

    for (let index = 0; index < playerNames.length; index += 1) {
      const [playerInsert] = await connection.execute(
        `INSERT INTO players (session_id, player_name, entered_order)
         VALUES (?, ?, ?)`,
        [session.id, playerNames[index], index + 1],
      );

      playerIds.push(playerInsert.insertId);
    }

    for (let index = 0; index < playerIds.length; index += 1) {
      await connection.execute(
        `INSERT INTO auction_lots (session_id, player_id, lot_number, rebid_round, base_price, status)
         VALUES (?, ?, ?, 0, ?, 'queued')`,
        [session.id, playerIds[index], index + 1, AUCTION_SETTINGS.basePrice],
      );
    }

    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'waiting',
           current_lot_id = NULL,
           current_bid = NULL,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = NULL,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [session.id],
    );

    return {
      ok: true,
    };
  });
}

async function startAuction(sessionKey, startedAt = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (lockedSession.status === "running") {
      return {
        ok: false,
        error: "A player is already live for bidding.",
      };
    }

    if (lockedSession.status === "paused") {
      return {
        ok: false,
        error: "Resume the paused bid instead of starting a new one.",
      };
    }

    const [queuedLots] = await connection.execute(
      `SELECT id, base_price
       FROM auction_lots
       WHERE session_id = ? AND status = 'queued'
       ORDER BY lot_number ASC
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    if (!queuedLots.length) {
      const [completedRows] = await connection.execute(
        `SELECT COUNT(*) AS count
         FROM auction_lots
         WHERE session_id = ? AND status IN ('sold', 'unsold')`,
        [session.id],
      );

      await connection.execute(
        `UPDATE auction_sessions
         SET status = ?
         WHERE id = ?`,
        [Number(completedRows[0]?.count ?? 0) > 0 ? "complete" : "setup", session.id],
      );

      return {
        ok: false,
        complete: Number(completedRows[0]?.count ?? 0) > 0,
        error: "No players are queued for auction.",
      };
    }

    const lot = queuedLots[0];

    await connection.execute(`UPDATE auction_lots SET status = 'running' WHERE id = ?`, [lot.id]);
    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'running',
           current_lot_id = ?,
           current_bid = ?,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = ?,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [lot.id, lot.base_price, new Date(startedAt + lockedSession.auction_duration_ms), session.id],
    );

    return {
      ok: true,
      lotId: lot.id,
    };
  });
}

async function pauseAuction(sessionKey, pausedAt = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (lockedSession.status !== "running" || !lockedSession.current_lot_id) {
      return {
        ok: false,
        error: "Only a live bid can be paused.",
      };
    }

    const remainingTimeMs = lockedSession.auction_end_time
      ? Math.max(new Date(lockedSession.auction_end_time).getTime() - pausedAt, 0)
      : 0;

    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'paused',
           auction_end_time = NULL,
           paused_remaining_ms = ?
       WHERE id = ?`,
      [remainingTimeMs, session.id],
    );

    return {
      ok: true,
      remainingTimeMs,
    };
  });
}

async function resumeAuction(sessionKey, resumedAt = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (lockedSession.status !== "paused" || !lockedSession.current_lot_id) {
      return {
        ok: false,
        error: "Only a paused bid can be resumed.",
      };
    }

    const remainingTimeMs = Math.max(Number(lockedSession.paused_remaining_ms ?? 0), 0);

    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'running',
           auction_end_time = ?,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [new Date(resumedAt + remainingTimeMs), session.id],
    );

    return {
      ok: true,
    };
  });
}

async function placeBid(sessionKey, teamId, captainName, amount, now = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (lockedSession.status !== "running" || !lockedSession.current_lot_id) {
      return {
        ok: false,
        error: "No live player is accepting bids right now.",
      };
    }

    if (lockedSession.auction_end_time && new Date(lockedSession.auction_end_time).getTime() <= now) {
      return {
        ok: false,
        error: "The bid timer has already expired.",
      };
    }

    const [teamRows] = await connection.execute(
      `SELECT id, team_name, remaining_budget
       FROM teams
       WHERE id = ? AND session_id = ?
       LIMIT 1
       FOR UPDATE`,
      [teamId, session.id],
    );

    if (!teamRows.length) {
      return {
        ok: false,
        error: "Captain team could not be resolved.",
      };
    }

    const team = teamRows[0];

    if (lockedSession.current_highest_team_id === team.id) {
      return {
        ok: false,
        error: "Your team already has the highest bid.",
      };
    }

    const parsedAmount = Number(amount);

    if (!Number.isFinite(parsedAmount) || !Number.isInteger(parsedAmount)) {
      return {
        ok: false,
        error: "Bid amount must be a whole number.",
      };
    }

    const minimumBid = lockedSession.current_highest_team_id
      ? lockedSession.current_bid + lockedSession.min_increment
      : lockedSession.current_bid;

    if (parsedAmount < minimumBid) {
      return {
        ok: false,
        error: `Minimum valid bid is ${minimumBid}.`,
      };
    }

    if (team.remaining_budget < parsedAmount) {
      return {
        ok: false,
        error: `${team.team_name} only has ${team.remaining_budget} left.`,
      };
    }

    await connection.execute(
      `INSERT INTO bids (session_id, lot_id, team_id, captain_name, bid_amount)
       VALUES (?, ?, ?, ?, ?)`,
      [session.id, lockedSession.current_lot_id, team.id, captainName, parsedAmount],
    );

    await connection.execute(
      `UPDATE auction_sessions
       SET current_bid = ?,
           current_highest_team_id = ?,
           current_highest_captain_name = ?
       WHERE id = ?`,
      [parsedAmount, team.id, sanitizeCaptainName(captainName), session.id],
    );

    return {
      ok: true,
    };
  });
}

async function settleAuction(sessionKey, endedBy = "timer", settledAt = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (!lockedSession.current_lot_id) {
      return {
        ok: false,
        error: "No live player exists to settle.",
      };
    }

    const [lotRows] = await connection.execute(
      `SELECT id
       FROM auction_lots
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [lockedSession.current_lot_id],
    );

    if (!lotRows.length) {
      return {
        ok: false,
        error: "Live lot could not be loaded.",
      };
    }

    if (lockedSession.current_highest_team_id) {
      const [teamRows] = await connection.execute(
        `SELECT id, remaining_budget
         FROM teams
         WHERE id = ?
         LIMIT 1
         FOR UPDATE`,
        [lockedSession.current_highest_team_id],
      );

      const team = teamRows[0];

      await connection.execute(
        `UPDATE teams
         SET remaining_budget = ?
         WHERE id = ?`,
        [team.remaining_budget - lockedSession.current_bid, team.id],
      );

      await connection.execute(
        `UPDATE auction_lots
         SET status = 'sold',
             ended_by = ?,
             winning_team_id = ?,
             winning_captain_name = ?,
             final_price = ?,
             sold_at = ?
         WHERE id = ?`,
        [
          endedBy,
          team.id,
          lockedSession.current_highest_captain_name,
          lockedSession.current_bid,
          new Date(settledAt),
          lockedSession.current_lot_id,
        ],
      );
    } else {
      await connection.execute(
        `UPDATE auction_lots
         SET status = 'unsold',
             ended_by = ?,
             sold_at = ?
         WHERE id = ?`,
        [endedBy, new Date(settledAt), lockedSession.current_lot_id],
      );
    }

    const [queuedRows] = await connection.execute(
      `SELECT COUNT(*) AS count
       FROM auction_lots
       WHERE session_id = ? AND status = 'queued'`,
      [session.id],
    );

    const nextStatus = Number(queuedRows[0]?.count ?? 0) > 0 ? "waiting" : "complete";

    await connection.execute(
      `UPDATE auction_sessions
       SET status = ?,
           current_lot_id = NULL,
           current_bid = NULL,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = NULL,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [nextStatus, session.id],
    );

    if (nextStatus === "complete") {
      await clearSessionMatchups(connection, session.id);
      await createSessionMatchups(connection, session.id);
    }

    return {
      ok: true,
      lotId: lockedSession.current_lot_id,
    };
  });
}

async function restartCurrentAuction(sessionKey, restartedAt = Date.now()) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT *
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    if (lockedSession.status !== "running" || !lockedSession.current_lot_id) {
      return {
        ok: false,
        error: "No active player is available to restart.",
      };
    }

    const [lotRows] = await connection.execute(
      `SELECT base_price
       FROM auction_lots
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [lockedSession.current_lot_id],
    );

    await connection.execute(`DELETE FROM bids WHERE lot_id = ?`, [lockedSession.current_lot_id]);
    await connection.execute(
      `UPDATE auction_sessions
       SET current_bid = ?,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = ?,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [
        lotRows[0].base_price,
        new Date(restartedAt + lockedSession.auction_duration_ms),
        session.id,
      ],
    );

    return {
      ok: true,
    };
  });
}

async function restartWholeAuction(sessionKey) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [playerRows] = await connection.execute(
      `SELECT id
       FROM players
       WHERE session_id = ?
       ORDER BY entered_order ASC`,
      [session.id],
    );

    if (!playerRows.length) {
      return {
        ok: false,
        error: "Load players before restarting the whole auction.",
      };
    }

    await connection.execute(`DELETE FROM bids WHERE session_id = ?`, [session.id]);
    await connection.execute(`DELETE FROM auction_lots WHERE session_id = ?`, [session.id]);
    await connection.execute(
      `UPDATE teams
       SET remaining_budget = total_budget
       WHERE session_id = ?`,
      [session.id],
    );
    await clearSessionMatchups(connection, session.id);

    for (let index = 0; index < playerRows.length; index += 1) {
      await connection.execute(
        `INSERT INTO auction_lots (session_id, player_id, lot_number, rebid_round, base_price, status)
         VALUES (?, ?, ?, 0, ?, 'queued')`,
        [session.id, playerRows[index].id, index + 1, AUCTION_SETTINGS.basePrice],
      );
    }

    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'waiting',
           current_lot_id = NULL,
           current_bid = NULL,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = NULL,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [session.id],
    );

    return {
      ok: true,
    };
  });
}

async function nukeSession(sessionKey) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT id FROM auction_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
      [session.id],
    );

    if (!sessionRows.length) {
      return { ok: false, error: "Session not found." };
    }

    // Wipe everything — bids, lots, players, matchups, teams
    await connection.execute(`DELETE FROM bids WHERE session_id = ?`, [session.id]);
    await connection.execute(`DELETE FROM auction_lots WHERE session_id = ?`, [session.id]);
    await connection.execute(`DELETE FROM players WHERE session_id = ?`, [session.id]);
    await clearSessionMatchups(connection, session.id);
    await connection.execute(`DELETE FROM teams WHERE session_id = ?`, [session.id]);

    await connection.execute(
      `UPDATE auction_sessions
       SET status = 'setup',
           current_lot_id = NULL,
           current_bid = NULL,
           current_highest_team_id = NULL,
           current_highest_captain_name = NULL,
           auction_end_time = NULL,
           paused_remaining_ms = NULL
       WHERE id = ?`,
      [session.id],
    );

    return { ok: true };
  });
}

async function adminReturnPlayerToPool(sessionKey, resultId) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT * FROM auction_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
      [session.id],
    );
    const lockedSession = sessionRows[0];

    // Cannot remove the currently live lot
    if (lockedSession.current_lot_id && String(lockedSession.current_lot_id) === String(resultId)) {
      return { ok: false, error: "End the current bid before returning this player to the pool." };
    }

    const [lotRows] = await connection.execute(
      `SELECT l.id, l.player_id, l.status, l.final_price, l.winning_team_id, l.source_lot_id
       FROM auction_lots l
       WHERE l.id = ? AND l.session_id = ? AND l.status IN ('sold', 'unsold')
       LIMIT 1 FOR UPDATE`,
      [resultId, session.id],
    );

    if (!lotRows.length) {
      return { ok: false, error: "Player result not found or not eligible to return." };
    }

    const lot = lotRows[0];

    // Credit money back to the winning team if sold
    if (lot.status === "sold" && lot.winning_team_id && lot.final_price) {
      await connection.execute(
        `UPDATE teams SET remaining_budget = remaining_budget + ? WHERE id = ?`,
        [lot.final_price, lot.winning_team_id],
      );
    }

    // Get the next lot number
    const [lotNumberRows] = await connection.execute(
      `SELECT COALESCE(MAX(lot_number), 0) AS max_lot FROM auction_lots WHERE session_id = ?`,
      [session.id],
    );
    const nextLotNumber = Number(lotNumberRows[0]?.max_lot ?? 0) + 1;

    // Re-queue the player as a fresh lot
    await connection.execute(
      `INSERT INTO auction_lots (session_id, player_id, source_lot_id, lot_number, rebid_round, base_price, status)
       VALUES (?, ?, ?, ?, 0, ?, 'queued')`,
      [session.id, lot.player_id, lot.id, nextLotNumber, lockedSession.base_price],
    );

    // Mark the old lot as returned (unsold + queued_for_rebid flag)
    await connection.execute(
      `UPDATE auction_lots SET status = 'unsold', queued_for_rebid = 1 WHERE id = ?`,
      [lot.id],
    );

    // If session was complete, reopen it
    if (lockedSession.status === "complete") {
      await connection.execute(
        `UPDATE auction_sessions SET status = 'waiting' WHERE id = ?`,
        [session.id],
      );
      await clearSessionMatchups(connection, session.id);
    }

    return { ok: true };
  });
}

async function queueUnsoldPlayerForRebid(sessionKey, resultId) {
  const session = await getSessionRow(sessionKey);

  return withTransaction(async (connection) => {
    const [sessionRows] = await connection.execute(
      `SELECT id, status, base_price
       FROM auction_sessions
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [session.id],
    );

    const lockedSession = sessionRows[0];

    const [resultRows] = await connection.execute(
      `SELECT id, player_id, lot_number, rebid_round, queued_for_rebid
       FROM auction_lots
       WHERE id = ? AND session_id = ? AND status = 'unsold'
       LIMIT 1
       FOR UPDATE`,
      [resultId, session.id],
    );

    if (!resultRows.length) {
      return {
        ok: false,
        error: "Unsold player could not be found for rebid.",
      };
    }

    const result = resultRows[0];

    if (result.queued_for_rebid) {
      return {
        ok: false,
        error: "That player is already queued for rebid.",
      };
    }

    const [lotNumberRows] = await connection.execute(
      `SELECT COALESCE(MAX(lot_number), 0) AS max_lot_number
       FROM auction_lots
       WHERE session_id = ?`,
      [session.id],
    );

    const nextLotNumber = Number(lotNumberRows[0]?.max_lot_number ?? 0) + 1;

    await connection.execute(
      `INSERT INTO auction_lots (session_id, player_id, source_lot_id, lot_number, rebid_round, base_price, status)
       VALUES (?, ?, ?, ?, ?, ?, 'queued')`,
      [
        session.id,
        result.player_id,
        result.id,
        nextLotNumber,
        result.rebid_round + 1,
        lockedSession.base_price,
      ],
    );

    await connection.execute(
      `UPDATE auction_lots
       SET queued_for_rebid = 1
       WHERE id = ?`,
      [result.id],
    );

    if (lockedSession.status === "complete") {
      await connection.execute(
        `UPDATE auction_sessions
         SET status = 'waiting'
         WHERE id = ?`,
        [session.id],
      );
      await clearSessionMatchups(connection, session.id);
    }

    return {
      ok: true,
    };
  });
}

module.exports = {
  ADMIN_ACCOUNT,
  adminReturnPlayerToPool,
  getCaptainTeamByCode,
  getSessionState,
  joinCaptain,
  listRunningAuctions,
  nukeSession,
  pauseAuction,
  placeBid,
  queueUnsoldPlayerForRebid,
  restartCurrentAuction,
  restartWholeAuction,
  resumeAuction,
  setPlayerPool,
  settleAuction,
  startAuction,
  verifyAdminCredentials,
};
