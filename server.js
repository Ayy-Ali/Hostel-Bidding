const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");

const { DEFAULT_SESSION_ID } = require("./src/config");
const { initializeDatabase } = require("./src/bootstrap");
const {
  getCaptainTeamByCode,
  getSessionState,
  joinCaptain,
  listRunningAuctions,
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
} = require("./src/sessionStore");
const { addMatchRecord, getMatchHistory } = require("./src/matchHistoryStore");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

const runtimeSessions = new Map();

app.use(express.static(path.join(__dirname, "public")));

function normalizeSessionId(value) {
  const rawValue = String(value ?? DEFAULT_SESSION_ID).trim().toLowerCase();
  const normalized = rawValue
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  return normalized || DEFAULT_SESSION_ID;
}

function collapseWhitespace(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ");
}

function createGuestViewer(role, displayName) {
  const normalizedRole = String(role ?? "spectator").trim().toLowerCase();
  const fallbackName = normalizedRole === "player" ? "Player" : "Spectator";
  const guestName = collapseWhitespace(displayName).slice(0, 40) || fallbackName;

  return {
    role: normalizedRole === "player" ? "player" : "spectator",
    teamId: null,
    displayName: guestName,
  };
}

function getRuntimeSession(sessionId) {
  if (!runtimeSessions.has(sessionId)) {
    runtimeSessions.set(sessionId, {
      viewers: new Map(),
      timer: null,
    });
  }

  return runtimeSessions.get(sessionId);
}

function buildRuntimeFlags(runtimeSession) {
  const viewers = [...runtimeSession.viewers.values()];

  return {
    liveViewers: viewers.length,
    adminConnected: viewers.some((viewer) => viewer.role === "admin"),
  };
}

function getViewerFlags(viewer, teamId) {
  const isAdmin = viewer?.role === "admin";
  const isCaptain = viewer?.role === "captain";
  const canViewFinancials = isAdmin || (isCaptain && viewer.teamId === teamId);

  return {
    isAdmin,
    isCaptain,
    canViewFinancials,
  };
}

function maskStateForViewer(state, viewer) {
  const visibleTeams = (state.teams ?? []).map((team) => {
    const { canViewFinancials } = getViewerFlags(viewer, team.id);

    return {
      ...team,
      budget: canViewFinancials ? team.budget : null,
      remainingBudget: canViewFinancials ? team.remainingBudget : null,
      spentAmount: canViewFinancials ? team.spentAmount : null,
      financialsVisible: canViewFinancials,
    };
  });

  return {
    ...state,
    teams: visibleTeams,
  };
}

async function buildClientState(sessionId) {
  const [auctionState, matchHistory] = await Promise.all([
    getSessionState(sessionId),
    getMatchHistory(),
  ]);
  const runtimeSession = getRuntimeSession(sessionId);

  return {
    ...auctionState,
    ...buildRuntimeFlags(runtimeSession),
    matchHistory,
  };
}

function emitViewerCount(sessionId) {
  const runtimeSession = getRuntimeSession(sessionId);

  io.to(sessionId).emit("session:viewers", {
    sessionId,
    liveViewers: runtimeSession.viewers.size,
  });
}

function clearRuntimeTimer(sessionId) {
  const runtimeSession = getRuntimeSession(sessionId);

  if (runtimeSession.timer) {
    clearTimeout(runtimeSession.timer);
    runtimeSession.timer = null;
  }
}

function emitStatePayload(socket, sessionId, state, eventName = "auction:state", extra = {}) {
  const viewer = getRuntimeSession(sessionId).viewers.get(socket.id);
  const visibleState = maskStateForViewer(state, viewer);

  socket.emit(eventName, {
    sessionId,
    state: visibleState,
    ...extra,
  });

  return visibleState;
}

async function emitStateToSocket(socket, sessionId, eventName = "auction:state", extra = {}) {
  const state = await buildClientState(sessionId);
  const visibleState = emitStatePayload(socket, sessionId, state, eventName, extra);

  return {
    state,
    visibleState,
  };
}

async function emitStateToRoom(sessionId, eventName = "auction:state", extra = {}) {
  const state = await buildClientState(sessionId);
  const runtimeSession = getRuntimeSession(sessionId);

  for (const socketId of runtimeSession.viewers.keys()) {
    const socket = io.sockets.sockets.get(socketId);

    if (!socket) {
      continue;
    }

    emitStatePayload(socket, sessionId, state, eventName, extra);
  }

  return state;
}

async function finishAuction(sessionId, endedBy = "timer", shouldBroadcast = true) {
  clearRuntimeTimer(sessionId);

  const settlement = await settleAuction(sessionId, endedBy, Date.now());

  if (!settlement.ok) {
    return settlement;
  }

  const state = await buildClientState(sessionId);
  const result = state.recentResults[0] ?? null;

  if (shouldBroadcast) {
    await emitStateToRoom(sessionId, "auction:end", {
      endedBy,
      result,
    });
    await emitStateToRoom(sessionId, "team:update", {
      teams: state.teams,
    });

    if (state.status === "complete") {
      await emitStateToRoom(sessionId, "auction:complete");
    }
  }

  return {
    ok: true,
    state,
    result,
  };
}

function scheduleAuctionEnd(sessionId, auctionEndTime) {
  clearRuntimeTimer(sessionId);

  if (!auctionEndTime) {
    return;
  }

  const runtimeSession = getRuntimeSession(sessionId);
  const delayMs = Math.max(auctionEndTime - Date.now(), 0) + 30;

  runtimeSession.timer = setTimeout(async () => {
    try {
      await finishAuction(sessionId, "timer");
    } catch (error) {
      console.error("Failed to finish auction timer", error);
    }
  }, delayMs);
}

function isAdminAlreadyConnected(sessionId, socketId) {
  const runtimeSession = getRuntimeSession(sessionId);

  for (const [existingSocketId, viewer] of runtimeSession.viewers.entries()) {
    if (existingSocketId !== socketId && viewer.role === "admin") {
      return true;
    }
  }

  return false;
}

function isCaptainAlreadyConnected(sessionId, teamId, socketId) {
  const runtimeSession = getRuntimeSession(sessionId);

  for (const [existingSocketId, viewer] of runtimeSession.viewers.entries()) {
    if (existingSocketId !== socketId && viewer.role === "captain" && viewer.teamId === teamId) {
      return true;
    }
  }

  return false;
}

function attachViewer(socket, sessionId, viewer) {
  const runtimeSession = getRuntimeSession(sessionId);

  runtimeSession.viewers.set(socket.id, viewer);
  socket.join(sessionId);
  socket.data.sessionId = sessionId;
  socket.data.role = viewer.role;
  socket.data.teamId = viewer.teamId ?? null;
  socket.data.displayName = viewer.displayName;
}

function detachSocket(socket) {
  const sessionId = socket.data.sessionId;

  if (!sessionId) {
    return;
  }

  const runtimeSession = getRuntimeSession(sessionId);
  runtimeSession.viewers.delete(socket.id);

  emitViewerCount(sessionId);

  socket.leave(sessionId);
  socket.data.sessionId = null;
  socket.data.role = null;
  socket.data.teamId = null;
  socket.data.displayName = null;
}

function respondError(ack, error) {
  ack({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}

async function resumeRunningAuctions() {
  const runningSessions = await listRunningAuctions();

  for (const session of runningSessions) {
    const sessionId = session.session_key;
    const auctionEndTime = new Date(session.auction_end_time).getTime();

    if (auctionEndTime <= Date.now()) {
      await finishAuction(sessionId, "timer", false);
      continue;
    }

    scheduleAuctionEnd(sessionId, auctionEndTime);
  }
}

app.get("/health", async (_request, response) => {
  try {
    const state = await buildClientState(DEFAULT_SESSION_ID);
    response.json({
      ok: true,
      activeSessions: runtimeSessions.size,
      defaultSessionId: DEFAULT_SESSION_ID,
      status: state.status,
    });
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

io.on("connection", (socket) => {
  socket.on("session:join", async (payload = {}, ack = () => {}) => {
    try {
      if (socket.data.sessionId) {
        detachSocket(socket);
      }

      const sessionId = normalizeSessionId(payload.sessionId);
      let joinResult;

      if (payload.role === "admin") {
        if (isAdminAlreadyConnected(sessionId, socket.id)) {
          ack({
            ok: false,
            error: "An administrator is already connected.",
          });
          return;
        }

        joinResult = await verifyAdminCredentials(payload.adminUsername, payload.adminPassword);
      } else if (payload.role === "captain") {
        const previewTeam = await getCaptainTeamByCode(
          sessionId,
          payload.captainCode || payload.displayName,
        );

        if (previewTeam && isCaptainAlreadyConnected(sessionId, previewTeam.id, socket.id)) {
          ack({
            ok: false,
            error: `${previewTeam.captain_name || previewTeam.name} is already connected.`,
          });
          return;
        }

        joinResult = await joinCaptain(
          sessionId,
          payload.displayName,
          payload.teamName,
          payload.captainCode,
        );
      } else {
        joinResult = {
          ok: true,
          viewer: createGuestViewer(payload.role, payload.displayName),
          team: null,
          teamChanged: false,
        };
      }

      if (!joinResult.ok) {
        ack(joinResult);
        return;
      }

      attachViewer(socket, sessionId, joinResult.viewer);

      const { state, visibleState } = await emitStateToSocket(socket, sessionId);
      emitViewerCount(sessionId);

      if (state.status === "running" && state.auctionEndTime) {
        scheduleAuctionEnd(sessionId, state.auctionEndTime);
      }

      if (joinResult.teamChanged) {
        await emitStateToRoom(sessionId, "team:update", {
          teams: state.teams,
        });
      }

      ack({
        ok: true,
        sessionId,
        role: joinResult.viewer.role,
        displayName: joinResult.viewer.displayName,
        team: joinResult.team ?? null,
        state: visibleState,
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:players:set", async (payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await setPlayerPool(sessionId, payload.playerNames ?? payload.playerText ?? payload.names);

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId);

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:start", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await startAuction(sessionId, Date.now());

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "auction:start");
      scheduleAuctionEnd(sessionId, state.auctionEndTime);

      io.to(sessionId).emit("timer:reset", {
        sessionId,
        serverNow: state.serverNow,
        auctionEndTime: state.auctionEndTime,
        remainingTimeMs: state.remainingTimeMs,
      });

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:pause", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      clearRuntimeTimer(sessionId);
      const result = await pauseAuction(sessionId, Date.now());

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "auction:pause");

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:resume", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await resumeAuction(sessionId, Date.now());

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "auction:resume");
      scheduleAuctionEnd(sessionId, state.auctionEndTime);

      io.to(sessionId).emit("timer:reset", {
        sessionId,
        serverNow: state.serverNow,
        auctionEndTime: state.auctionEndTime,
        remainingTimeMs: state.remainingTimeMs,
      });

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:end", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await finishAuction(sessionId, "admin");

      if (!result.ok) {
        ack(result);
        return;
      }

      ack({
        ok: true,
        state: maskStateForViewer(result.state, runtimeViewer),
        result: result.result,
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:restart-current", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await restartCurrentAuction(sessionId, Date.now());

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "auction:restart", {
        mode: "current",
      });
      scheduleAuctionEnd(sessionId, state.auctionEndTime);

      io.to(sessionId).emit("timer:reset", {
        sessionId,
        serverNow: state.serverNow,
        auctionEndTime: state.auctionEndTime,
        remainingTimeMs: state.remainingTimeMs,
      });

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:auction:restart-all", async (_payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      clearRuntimeTimer(sessionId);
      const result = await restartWholeAuction(sessionId);

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "auction:restart", {
        mode: "all",
      });

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("admin:rebid", async (payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await queueUnsoldPlayerForRebid(sessionId, payload.resultId);

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId);
      const lot = state.upcomingPlayers[state.upcomingPlayers.length - 1] ?? null;

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
        lot,
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("matches:add", async (payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "admin") {
        ack({
          ok: false,
          error: "Only the administrator can use that action.",
        });
        return;
      }

      const result = await addMatchRecord(payload);

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "matches:update");

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
        record: result.record,
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("bid:place", async (payload = {}, ack = () => {}) => {
    try {
      const sessionId = socket.data.sessionId;
      const runtimeViewer = getRuntimeSession(sessionId).viewers.get(socket.id);

      if (!sessionId || runtimeViewer?.role !== "captain") {
        ack({
          ok: false,
          error: "Only captains can place bids.",
        });
        return;
      }

      const result = await placeBid(
        sessionId,
        runtimeViewer.teamId,
        runtimeViewer.displayName,
        payload.amount,
        Date.now(),
      );

      if (!result.ok) {
        ack(result);
        return;
      }

      const state = await emitStateToRoom(sessionId, "bid:update", {
        currentBid: null,
        highestBidder: null,
      });

      ack({
        ok: true,
        state: maskStateForViewer(state, runtimeViewer),
      });
    } catch (error) {
      respondError(ack, error);
    }
  });

  socket.on("disconnect", () => {
    detachSocket(socket);
  });
});

app.get("*", (_request, response) => {
  response.sendFile(path.join(__dirname, "public", "index.html"));
});

async function startServer() {
  await initializeDatabase();
  await resumeRunningAuctions();

  const port = Number(process.env.PORT || 3000);

  server.listen(port, () => {
    console.log(`Hostel Football Auction server running at http://localhost:${port}`);
  });
}

startServer().catch((error) => {
  console.error("Failed to start the server", error);
  process.exit(1);
});
