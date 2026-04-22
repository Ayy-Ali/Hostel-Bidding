const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const test = require("node:test");

const { ADMIN_ACCOUNT } = require("../src/config");
const { ensureSession, initializeDatabase } = require("../src/bootstrap");
const { closePool, query } = require("../src/db");
const {
  getSessionState,
  joinCaptain,
  getCaptainTeamByCode,
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
} = require("../src/sessionStore");

async function cleanupSession(sessionKey) {
  await query(`DELETE FROM auction_sessions WHERE session_key = ?`, [sessionKey]);
}

async function createTestSession() {
  const sessionKey = `test-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  await ensureSession(sessionKey);
  return sessionKey;
}

test.before(async () => {
  await initializeDatabase();
});

test.after(async () => {
  await closePool();
});

test("administrator can load up to 75 manual players before the auction starts", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  const adminJoin = await verifyAdminCredentials(
    ADMIN_ACCOUNT.username,
    ADMIN_ACCOUNT.password,
  );
  assert.equal(adminJoin.ok, true);

  const players = Array.from({ length: 75 }, (_, index) => `Player ${index + 1}`);
  const playerResult = await setPlayerPool(sessionKey, players);
  const state = await getSessionState(sessionKey);

  assert.equal(playerResult.ok, true);
  assert.equal(state.configuredPlayers.length, 75);
  assert.equal(state.upcomingPlayers.length, 75);
});

test("captain name becomes a lowercase code and a capitalized display name", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  const captainJoin = await joinCaptain(sessionKey, "ayaan", "Red Wolves");

  assert.equal(captainJoin.ok, true);
  assert.equal(captainJoin.viewer.displayName, "Ayaan");

  const team = await getCaptainTeamByCode(sessionKey, "AYAA N".replace(" ", ""));
  const serialized = await getSessionState(sessionKey);
  const redWolves = serialized.teams.find((entry) => entry.id === team.id);

  assert.equal(team.captain_code, "ayaan");
  assert.equal(redWolves.name, "Red Wolves");
  assert.equal(redWolves.captainName, "Ayaan");
});

test("pause and resume preserve the current player and remaining timer", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  await joinCaptain(sessionKey, "suresh", "Blue Hawks");
  assert.equal((await setPlayerPool(sessionKey, ["Nikhil"])).ok, true);
  assert.equal((await startAuction(sessionKey, 1000)).ok, true);

  assert.equal((await pauseAuction(sessionKey, 16000)).ok, true);

  let state = await getSessionState(sessionKey);
  assert.equal(state.status, "paused");
  assert.equal(state.currentPlayer.name, "Nikhil");
  assert.equal(state.remainingTimeMs, 45000);
  assert.equal(state.auctionEndTime, null);

  assert.equal((await resumeAuction(sessionKey, 20000)).ok, true);

  state = await getSessionState(sessionKey);
  assert.equal(state.status, "running");
  assert.equal(state.auctionEndTime, 65000);
});

test("restart current auction clears the current player bid and resets the timer", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  const captainJoin = await joinCaptain(sessionKey, "arjun", "Red Wolves");

  assert.equal((await setPlayerPool(sessionKey, ["Nikhil"])).ok, true);
  assert.equal((await startAuction(sessionKey, 1000)).ok, true);
  assert.equal(
    (await placeBid(sessionKey, captainJoin.team.id, captainJoin.viewer.displayName, 200000, 2000)).ok,
    true,
  );

  const restartResult = await restartCurrentAuction(sessionKey, 3000);
  const state = await getSessionState(sessionKey);

  assert.equal(restartResult.ok, true);
  assert.equal(state.currentBid, 200000);
  assert.equal(state.highestBidder, null);
  assert.equal(state.auctionEndTime, 63000);
});

test("restart whole auction resets budgets, results, queue, and generated matchups", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  const captainOne = await joinCaptain(sessionKey, "arjun", "Red Wolves");
  await joinCaptain(sessionKey, "suresh", "Blue Hawks");

  assert.equal((await setPlayerPool(sessionKey, ["Nikhil"])).ok, true);
  assert.equal((await startAuction(sessionKey, 1000)).ok, true);
  assert.equal(
    (await placeBid(sessionKey, captainOne.team.id, captainOne.viewer.displayName, 200000, 2000)).ok,
    true,
  );
  assert.equal((await settleAuction(sessionKey, "admin", 3000)).ok, true);

  let serialized = await getSessionState(sessionKey);
  assert.equal(serialized.status, "complete");
  assert.equal(serialized.matchups.length, 1);

  const restartResult = await restartWholeAuction(sessionKey);
  serialized = await getSessionState(sessionKey);
  const redWolves = serialized.teams.find((team) => team.id === captainOne.team.id);

  assert.equal(restartResult.ok, true);
  assert.equal(serialized.upcomingPlayers.length, 1);
  assert.equal(serialized.recentResults.length, 0);
  assert.equal(serialized.matchups.length, 0);
  assert.equal(redWolves.remainingBudget, 20000000);
  assert.equal(redWolves.playersPurchased, 0);
});

test("unsold players can be queued again for rebid and clear generated fixtures", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  await joinCaptain(sessionKey, "ayaan", "Red Wolves");
  await joinCaptain(sessionKey, "suresh", "Blue Hawks");

  assert.equal((await setPlayerPool(sessionKey, ["Yash"])).ok, true);
  assert.equal((await startAuction(sessionKey, 1000)).ok, true);

  const settlement = await settleAuction(sessionKey, "timer", 61000);
  assert.equal(settlement.ok, true);

  let serialized = await getSessionState(sessionKey);
  assert.equal(serialized.status, "complete");
  assert.equal(serialized.matchups.length, 1);

  const unsoldPlayer = serialized.unsoldPlayers[0];
  const rebid = await queueUnsoldPlayerForRebid(sessionKey, unsoldPlayer.id);
  assert.equal(rebid.ok, true);

  serialized = await getSessionState(sessionKey);
  assert.equal(serialized.status, "waiting");
  assert.equal(serialized.matchups.length, 0);
  assert.equal(serialized.upcomingPlayers.length, 1);
  assert.equal(serialized.upcomingPlayers[0].name, "Yash");
  assert.equal(serialized.upcomingPlayers[0].rebidRound, 1);
});

test("complete auction generates random team matchups", async (t) => {
  const sessionKey = await createTestSession();
  t.after(() => cleanupSession(sessionKey));

  await joinCaptain(sessionKey, "ayaan", "Red Wolves");
  await joinCaptain(sessionKey, "suresh", "Blue Hawks");
  await joinCaptain(sessionKey, "ravi", "Golden Boots");
  await joinCaptain(sessionKey, "naman", "Night Riders");

  assert.equal((await setPlayerPool(sessionKey, ["Player One"])).ok, true);
  assert.equal((await startAuction(sessionKey, 1000)).ok, true);
  assert.equal((await settleAuction(sessionKey, "timer", 61000)).ok, true);

  const state = await getSessionState(sessionKey);
  assert.equal(state.status, "complete");
  assert.equal(state.matchups.length, 2);

  const labels = state.matchups.map((matchup) => matchup.matchLabel).join(" | ");
  assert.match(labels, /vs/);
});
