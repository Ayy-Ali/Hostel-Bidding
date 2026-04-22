const FALLBACK_SESSION_ID = "hostel-football-auction";
const socket = io();

const state = {
  auction: {
    sessionId: FALLBACK_SESSION_ID,
    status: "setup",
    serverNow: Date.now(),
    currentPlayer: null,
    currentBid: null,
    highestBidder: null,
    auctionEndTime: null,
    remainingTimeMs: 0,
    teams: [],
    recentResults: [],
    unsoldPlayers: [],
    configuredPlayers: [],
    upcomingPlayers: [],
    matchups: [],
    matchHistory: [],
    liveViewers: 0,
    minIncrement: 100000,
    auctionDurationMs: 60000,
    basePrice: 200000,
    teamBudget: 20000000,
    maxPlayers: 75,
    canConfigurePlayers: true,
    adminConnected: false,
  },
  participant: {
    role: null,
    displayName: "",
    team: null,
  },
  ui: {
    activeSection: "auction",
  },
  lastJoinPayload: null,
  clockOffsetMs: 0,
  defaultSessionId: FALLBACK_SESSION_ID,
  configReady: false,
  joined: false,
};

const elements = {
  loginScreen: document.getElementById("loginScreen"),
  dashboardScreen: document.getElementById("dashboardScreen"),
  loginForm: document.getElementById("loginForm"),
  roleSelect: document.getElementById("roleSelect"),
  displayNameLabel: document.getElementById("displayNameLabel"),
  displayName: document.getElementById("displayName"),
  captainFields: document.getElementById("captainFields"),
  captainCode: document.getElementById("captainCode"),
  captainCodeHint: document.getElementById("captainCodeHint"),
  teamName: document.getElementById("teamName"),
  adminFields: document.getElementById("adminFields"),
  adminUsername: document.getElementById("adminUsername"),
  adminPassword: document.getElementById("adminPassword"),
  loginFlash: document.getElementById("loginFlash"),
  appFlash: document.getElementById("appFlash"),
  heroNote: document.getElementById("heroNote"),
  livePill: document.getElementById("livePill"),
  viewerCount: document.getElementById("viewerCount"),
  participantBadge: document.getElementById("participantBadge"),
  leaveButton: document.getElementById("leaveButton"),
  auctionTabButton: document.getElementById("auctionTabButton"),
  historyTabButton: document.getElementById("historyTabButton"),
  auctionSection: document.getElementById("auctionSection"),
  historySection: document.getElementById("historySection"),
  currentPlayerName: document.getElementById("currentPlayerName"),
  currentPlayerMeta: document.getElementById("currentPlayerMeta"),
  basePrice: document.getElementById("basePrice"),
  currentBid: document.getElementById("currentBid"),
  highestBidder: document.getElementById("highestBidder"),
  countdown: document.getElementById("countdown"),
  adminPanel: document.getElementById("adminPanel"),
  matchAdminPanel: document.getElementById("matchAdminPanel"),
  playerTextarea: document.getElementById("playerTextarea"),
  playerCountNote: document.getElementById("playerCountNote"),
  savePlayersButton: document.getElementById("savePlayersButton"),
  startAuctionButton: document.getElementById("startAuctionButton"),
  pauseAuctionButton: document.getElementById("pauseAuctionButton"),
  resumeAuctionButton: document.getElementById("resumeAuctionButton"),
  endAuctionButton: document.getElementById("endAuctionButton"),
  restartCurrentButton: document.getElementById("restartCurrentButton"),
  restartWholeButton: document.getElementById("restartWholeButton"),
  unsoldList: document.getElementById("unsoldList"),
  bidPanel: document.getElementById("bidPanel"),
  bidContext: document.getElementById("bidContext"),
  bidForm: document.getElementById("bidForm"),
  bidAmount: document.getElementById("bidAmount"),
  placeBidButton: document.getElementById("placeBidButton"),
  quickBids: [...document.querySelectorAll(".quick-bid")],
  teamPanelHeading: document.getElementById("teamPanelHeading"),
  teamStrip: document.getElementById("teamStrip"),
  teamGrid: document.getElementById("teamGrid"),
  recentFeed: document.getElementById("recentFeed"),
  upcomingPlayers: document.getElementById("upcomingPlayers"),
  fixturesList: document.getElementById("fixturesList"),
  matchHistoryList: document.getElementById("matchHistoryList"),
  matchForm: document.getElementById("matchForm"),
  matchTitle: document.getElementById("matchTitle"),
  matchDate: document.getElementById("matchDate"),
  matchVenue: document.getElementById("matchVenue"),
  matchResult: document.getElementById("matchResult"),
  matchScore: document.getElementById("matchScore"),
  matchNotes: document.getElementById("matchNotes"),
};

function formatAmount(value) {
  if (value == null) {
    return "--";
  }

  if (value % 10000000 === 0) {
    return `${value / 10000000}Cr`;
  }

  if (value % 100000 === 0) {
    return `${value / 100000}L`;
  }

  return `Rs ${value}`;
}

function amountToLakhs(value) {
  if (value == null) {
    return null;
  }

  return Math.round(value / 100000);
}

function formatTime(ms) {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0);
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function normalizeCaptainCode(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function setFlash(message, tone = "info", scope = "app") {
  const target = scope === "login" ? elements.loginFlash : elements.appFlash;

  if (!target) {
    return;
  }

  target.textContent = message;
  target.className = `flash-message ${tone}`;
}

function syncClock(payload) {
  if (payload && typeof payload.serverNow === "number") {
    state.clockOffsetMs = payload.serverNow - Date.now();
  }
}

function getClientNow() {
  return Date.now() + state.clockOffsetMs;
}

function isAdmin() {
  return state.participant.role === "admin";
}

function isCaptain() {
  return state.participant.role === "captain";
}

function getOwnTeam() {
  if (!isCaptain()) {
    return null;
  }

  return state.auction.teams.find((team) => team.id === state.participant.team?.id) ?? null;
}

function showDashboard() {
  state.joined = true;
  elements.loginScreen.classList.add("hidden");
  elements.dashboardScreen.classList.remove("hidden");
}

function setActiveSection(sectionName) {
  state.ui.activeSection = sectionName;
  elements.auctionSection.classList.toggle("hidden", sectionName !== "auction");
  elements.historySection.classList.toggle("hidden", sectionName !== "history");
  elements.auctionTabButton.classList.toggle("active", sectionName === "auction");
  elements.historyTabButton.classList.toggle("active", sectionName === "history");
}

function applyAuctionState(nextState) {
  if (!nextState) {
    return;
  }

  syncClock(nextState);
  state.auction = {
    ...state.auction,
    ...nextState,
  };

  syncAdminTextarea();
  render();
}

function getMinimumBid() {
  if (!state.auction.currentPlayer || state.auction.currentBid == null) {
    return null;
  }

  if (state.auction.highestBidder) {
    return state.auction.currentBid + state.auction.minIncrement;
  }

  return state.auction.currentBid;
}

function getParticipantBadgeText() {
  if (!state.participant.role) {
    return "Role not connected";
  }

  if (isAdmin()) {
    return "Administrator";
  }

  if (isCaptain()) {
    return `${state.participant.displayName} | ${state.participant.team?.name || "Captain team"}`;
  }

  if (state.participant.role === "player") {
    return `${state.participant.displayName || "Player"} watching`;
  }

  return `${state.participant.displayName || "Spectator"} watching`;
}

function getHeroNote() {
  if (isAdmin()) {
    return "Load players, pause or resume a live bid, end it early, restart bids, and view every team's spending live.";
  }

  if (isCaptain()) {
    return "You can bid here, see every team's purchased players, and only your own budget and spending.";
  }

  if (state.participant.role === "player") {
    return "Players can watch the auction live, see team rosters, and check the generated fixtures after bidding ends.";
  }

  return "Watch the auction live, see team rosters, and check the fixtures and match records when the session is complete.";
}

function syncAdminTextarea() {
  if (!isAdmin() || !state.auction.canConfigurePlayers) {
    return;
  }

  if (document.activeElement === elements.playerTextarea) {
    return;
  }

  elements.playerTextarea.value = state.auction.configuredPlayers.join("\n");
}

function renderHeader() {
  elements.viewerCount.textContent = `${state.auction.liveViewers || 0} live viewers`;
  elements.participantBadge.textContent = getParticipantBadgeText();
  elements.heroNote.textContent = getHeroNote();

  if (state.auction.status === "running") {
    elements.livePill.textContent = "LIVE";
  } else if (state.auction.status === "paused") {
    elements.livePill.textContent = "PAUSED";
  } else if (state.auction.status === "complete") {
    elements.livePill.textContent = "DONE";
  } else {
    elements.livePill.textContent = "READY";
  }
}

function renderCurrentLot() {
  const currentPlayer = state.auction.currentPlayer;

  if (currentPlayer) {
    const listingLabel =
      currentPlayer.rebidRound > 0 ? `Rebid round ${currentPlayer.rebidRound}` : "Fresh listing";

    elements.currentPlayerName.textContent = `Lot ${currentPlayer.lotNumber}: ${currentPlayer.name}`;
    elements.currentPlayerMeta.textContent =
      state.auction.status === "paused" ? `${listingLabel} | Session paused` : listingLabel;
    elements.basePrice.textContent = formatAmount(currentPlayer.basePrice);
    elements.currentBid.textContent = formatAmount(state.auction.currentBid);
    elements.highestBidder.textContent = state.auction.highestBidder
      ? `${state.auction.highestBidder.teamName} - ${state.auction.highestBidder.displayName}`
      : "No bids yet";
    return;
  }

  if (state.auction.status === "setup") {
    elements.currentPlayerName.textContent = "Waiting for administrator setup";
    elements.currentPlayerMeta.textContent = "Add the player list before starting the auction";
  } else if (state.auction.status === "waiting") {
    elements.currentPlayerName.textContent = "Ready for the next player";
    elements.currentPlayerMeta.textContent = "Administrator can start the next bid now";
  } else if (state.auction.status === "complete") {
    elements.currentPlayerName.textContent = "Auction queue complete";
    elements.currentPlayerMeta.textContent = "Fixtures are ready and unsold players can still be rebid";
  } else {
    elements.currentPlayerName.textContent = "No live player";
    elements.currentPlayerMeta.textContent = "Waiting for the next action";
  }

  elements.basePrice.textContent = formatAmount(state.auction.basePrice);
  elements.currentBid.textContent = "--";
  elements.highestBidder.textContent = "No active bidder";
}

function renderCountdown() {
  if (state.auction.status === "paused") {
    elements.countdown.textContent = `Paused ${formatTime(state.auction.remainingTimeMs)}`;
    return;
  }

  if (state.auction.status !== "running" || !state.auction.auctionEndTime) {
    elements.countdown.textContent = state.auction.status === "complete" ? "Done" : "00:00";
    return;
  }

  const remainingMs = Math.max(state.auction.auctionEndTime - getClientNow(), 0);
  elements.countdown.textContent = formatTime(remainingMs);
}

function renderTeamStrip() {
  const teams = state.auction.teams ?? [];

  if (!teams.length) {
    elements.teamStrip.innerHTML = "";
    return;
  }

  elements.teamStrip.innerHTML = teams
    .map((team) => {
      const captainLabel = team.captainName ? `Captain: ${team.captainName}` : "Captain not connected";
      return `
        <div class="team-chip">
          <strong>${team.name}</strong>
          <span>${captainLabel}</span>
        </div>
      `;
    })
    .join("");
}

function renderSpendingSummary(teams) {
  // Admin sees all teams' spending; captain sees only their own
  if (isAdmin()) {
    const rows = teams
      .map(
        (team) => `
          <div class="spending-row">
            <span class="spending-team" style="border-left:3px solid ${team.accent}">${team.name}</span>
            <span class="spending-captain">${team.captainName || "—"}</span>
            <span class="spending-spent">${formatAmount(team.spentAmount)}</span>
            <span class="spending-remaining">${formatAmount(team.remainingBudget)} left</span>
          </div>
        `,
      )
      .join("");

    return `
      <div class="spending-summary">
        <p class="panel-label" style="margin-bottom:10px">Spending Summary</p>
        <div class="spending-header">
          <span>Team</span><span>Captain</span><span>Spent</span><span>Remaining</span>
        </div>
        ${rows}
      </div>
    `;
  }

  if (isCaptain()) {
    const ownTeam = getOwnTeam();
    if (!ownTeam || !ownTeam.financialsVisible) return "";
    return `
      <div class="spending-summary own-spending">
        <p class="panel-label" style="margin-bottom:10px">Your Spending</p>
        <div class="spending-row">
          <span class="spending-team" style="border-left:3px solid ${ownTeam.accent}">${ownTeam.name}</span>
          <span class="spending-spent">${formatAmount(ownTeam.spentAmount)} spent</span>
          <span class="spending-remaining">${formatAmount(ownTeam.remainingBudget)} remaining</span>
        </div>
      </div>
    `;
  }

  return "";
}

function renderTeams() {
  const teams = state.auction.teams ?? [];

  if (!teams.length) {
    elements.teamGrid.innerHTML = '<p class="empty-state">Captains who join will create the teams for this session.</p>';
    return;
  }

  renderTeamStrip();

  if (isAdmin()) {
    elements.teamPanelHeading.textContent = "All teams, budgets, and spending";
  } else if (isCaptain()) {
    elements.teamPanelHeading.textContent = "All teams — only your budget and spending are visible to you";
  } else {
    elements.teamPanelHeading.textContent = "Teams and purchased players";
  }

  const spendingSummaryMarkup = renderSpendingSummary(teams);

  const teamCardsMarkup = teams
    .map((team) => {
      const rosterMarkup = team.roster.length
        ? team.roster
            .map(
              (player) => `
                <div class="roster-player">
                  <strong>${player.name}</strong>
                  <span class="team-meta">${formatAmount(player.soldPrice)}</span>
                </div>
              `,
            )
            .join("")
        : '<p class="empty-state">No players purchased yet.</p>';

      const financialMarkup = team.financialsVisible
        ? `
            <div class="team-financials">
              <strong class="team-budget">${formatAmount(team.remainingBudget)}</strong>
              <p class="team-meta">Spent: ${formatAmount(team.spentAmount)}</p>
            </div>
          `
        : `
            <div class="team-financials">
              <strong class="team-budget hidden-financial">Budget hidden</strong>
              <p class="team-meta">Spending hidden</p>
            </div>
          `;

      const headerNote = team.captainName
        ? `Captain: ${team.captainName}`
        : "Captain not connected";

      return `
        <article class="team-card" style="--team-accent:${team.accent}">
          <div class="team-head">
            <div>
              <h3>${team.name}</h3>
              <p class="team-meta">${headerNote}</p>
            </div>
            ${financialMarkup}
          </div>
          <div class="team-roster">${rosterMarkup}</div>
        </article>
      `;
    })
    .join("");

  elements.teamGrid.innerHTML = spendingSummaryMarkup + teamCardsMarkup;
}

function renderFeed() {
  const results = state.auction.recentResults ?? [];

  if (!results.length) {
    elements.recentFeed.innerHTML =
      '<p class="empty-state">Sold and unsold players will appear here as the auction runs.</p>';
    return;
  }

  elements.recentFeed.innerHTML = results
    .map((result) => {
      const summary =
        result.status === "sold"
          ? `${result.soldTo.teamName} bought this player for ${formatAmount(result.soldPrice)}.`
          : result.queuedForRebid
            ? "Unsold earlier and now queued for rebid."
            : "Unsold and waiting for an administrator rebid decision.";

      const endedBy = result.endedBy === "admin" ? "Closed by administrator" : "Timer ended";
      const listingLabel = result.rebidRound > 0 ? `Rebid ${result.rebidRound}` : "First listing";

      return `
        <article class="result-card ${result.status}">
          <div class="result-head">
            <div>
              <h3>${result.name}</h3>
              <p class="result-meta">${listingLabel} - ${endedBy}</p>
            </div>
            <span class="result-status ${result.status}">${result.status}</span>
          </div>
          <p>${summary}</p>
        </article>
      `;
    })
    .join("");
}

function renderQueue() {
  const queue = state.auction.upcomingPlayers ?? [];

  if (!queue.length) {
    elements.upcomingPlayers.innerHTML =
      '<p class="empty-state">No players are waiting in the queue right now.</p>';
    return;
  }

  elements.upcomingPlayers.innerHTML = queue
    .map((player) => {
      const listingLabel = player.rebidRound > 0 ? `Rebid ${player.rebidRound}` : "Fresh listing";

      return `
        <article class="queue-card">
          <h3>${player.name}</h3>
          <strong>${formatAmount(player.basePrice)}</strong>
          <p class="queue-meta">${listingLabel}</p>
        </article>
      `;
    })
    .join("");
}

function renderUnsoldList() {
  if (!isAdmin()) {
    elements.unsoldList.innerHTML = "";
    return;
  }

  const unsoldPlayers = state.auction.unsoldPlayers ?? [];

  if (!unsoldPlayers.length) {
    elements.unsoldList.innerHTML =
      '<p class="empty-state">No unsold players are waiting for rebid.</p>';
    return;
  }

  elements.unsoldList.innerHTML = unsoldPlayers
    .map((player) => {
      const label = player.rebidRound > 0 ? `Rebid ${player.rebidRound}` : "First listing";

      return `
        <div class="unsold-item">
          <div class="unsold-head">
            <div>
              <h3>${player.name}</h3>
              <p class="team-meta">${label}</p>
            </div>
            <button
              type="button"
              class="secondary-button rebid-button"
              data-result-id="${player.id}"
              ${player.queuedForRebid ? "disabled" : ""}
            >
              ${player.queuedForRebid ? "Queued" : "Queue Rebid"}
            </button>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderPlayerCount() {
  const players = state.auction.configuredPlayers ?? [];
  elements.playerCountNote.textContent = `${players.length} / ${state.auction.maxPlayers} players loaded`;
}

function renderBidPanel() {
  elements.bidPanel.classList.toggle("hidden", !isCaptain());

  if (!isCaptain()) {
    return;
  }

  const minimumBid = getMinimumBid();
  const canBid =
    state.auction.status === "running" && Boolean(state.auction.currentPlayer);
  const ownTeam = getOwnTeam();

  elements.bidPanel.classList.toggle("inactive", !canBid);
  elements.bidAmount.disabled = !canBid;
  elements.placeBidButton.disabled = !canBid;
  elements.bidAmount.step = "1";

  const minimumLakhs = minimumBid == null ? null : amountToLakhs(minimumBid);

  if (minimumLakhs != null) {
    elements.bidAmount.min = String(minimumLakhs);
    if (!elements.bidAmount.value || Number(elements.bidAmount.value) < minimumLakhs) {
      elements.bidAmount.value = String(minimumLakhs);
    }
  } else {
    elements.bidAmount.value = "";
  }

  if (!canBid && state.auction.status === "paused") {
    elements.bidContext.textContent = "The administrator has paused this bid. Wait for the session to resume.";
  } else if (!canBid) {
    elements.bidContext.textContent =
      "Wait for the administrator to start a player before placing a bid.";
  } else {
    const budgetNote = ownTeam?.financialsVisible
      ? ` Your remaining budget: ${formatAmount(ownTeam.remainingBudget)} | Spent so far: ${formatAmount(ownTeam.spentAmount)}.`
      : "";
    elements.bidContext.textContent = `Enter the lakh number only. Example: 8 means 8L. Minimum valid bid is ${minimumLakhs}.${budgetNote}`;
  }

  elements.quickBids.forEach((button) => {
    const offset = Number(button.dataset.offset || "0");
    const nextLakhs = minimumLakhs == null ? null : minimumLakhs + offset;

    button.disabled = !canBid || nextLakhs == null;
    button.textContent = nextLakhs == null ? "-" : String(nextLakhs);
  });
}

function renderAdminPanel() {
  elements.adminPanel.classList.toggle("hidden", !isAdmin());
  elements.matchAdminPanel.classList.toggle("hidden", !isAdmin());

  if (!isAdmin()) {
    return;
  }

  const canStartNext = state.auction.status !== "running" && state.auction.status !== "paused" && state.auction.upcomingPlayers.length > 0;
  const canEndCurrent = state.auction.status === "running" || state.auction.status === "paused";
  const canPause = state.auction.status === "running";
  const canResume = state.auction.status === "paused";

  elements.playerTextarea.disabled = !state.auction.canConfigurePlayers;
  elements.savePlayersButton.disabled = !state.auction.canConfigurePlayers;
  elements.startAuctionButton.disabled = !canStartNext;
  elements.pauseAuctionButton.disabled = !canPause;
  elements.resumeAuctionButton.disabled = !canResume;
  elements.endAuctionButton.disabled = !canEndCurrent;
  elements.restartCurrentButton.disabled = state.auction.status !== "running";
  elements.restartWholeButton.disabled = state.auction.configuredPlayers.length === 0;

  renderPlayerCount();
  renderUnsoldList();
}

function renderFixtures() {
  const fixtures = state.auction.matchups ?? [];

  if (!fixtures.length) {
    elements.fixturesList.innerHTML =
      '<p class="empty-state">Fixtures will be generated automatically after the full auction finishes.</p>';
    return;
  }

  elements.fixturesList.innerHTML = fixtures
    .map(
      (fixture) => `
        <article class="match-card">
          <div class="result-head">
            <div>
              <h3>${fixture.matchLabel}</h3>
              <p class="result-meta">Round ${fixture.roundNumber}</p>
            </div>
            <span class="result-status ${fixture.status === "bye" ? "unsold" : "sold"}">${fixture.status}</span>
          </div>
        </article>
      `,
    )
    .join("");
}

function renderMatchHistory() {
  const records = state.auction.matchHistory ?? [];

  if (!records.length) {
    elements.matchHistoryList.innerHTML =
      '<p class="empty-state">No match records have been saved yet.</p>';
    return;
  }

  elements.matchHistoryList.innerHTML = records
    .map(
      (record) => `
        <article class="match-card">
          <div class="result-head">
            <div>
              <h3>${record.title}</h3>
              <p class="result-meta">${record.date} ${record.venue ? `- ${record.venue}` : ""}</p>
            </div>
            <span class="result-status ${record.result ? "sold" : "unsold"}">${record.result || "Scheduled"}</span>
          </div>
          <p>${record.score ? `Score: ${record.score}` : "Score not added yet."}</p>
          <p>${record.notes || "No notes added."}</p>
        </article>
      `,
    )
    .join("");
}

function render() {
  renderHeader();
  renderCurrentLot();
  renderCountdown();
  renderBidPanel();
  renderAdminPanel();
  renderTeams();
  renderFeed();
  renderQueue();
  renderFixtures();
  renderMatchHistory();
}

async function loadAppConfig() {
  try {
    const response = await fetch("/health");
    const payload = await response.json();

    if (payload?.ok && payload.defaultSessionId) {
      state.defaultSessionId = payload.defaultSessionId;
      state.auction.sessionId = payload.defaultSessionId;
    }
  } catch (_error) {
    setFlash(
      "Using the default session id because live config could not be loaded yet.",
      "info",
      "login",
    );
  } finally {
    state.configReady = true;
  }
}

function syncCaptainCodeFromName() {
  if (elements.roleSelect.value !== "captain") {
    elements.captainCode.value = "";
    return;
  }

  const code = normalizeCaptainCode(elements.displayName.value);
  elements.captainCode.value = code;
  const rawName = elements.displayName.value.trim();
  const displayedName = rawName
    ? rawName.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase())
    : "";
  if (code) {
    elements.captainCodeHint.innerHTML = `Displayed as: <strong style="color:var(--text)">${displayedName}</strong> &nbsp;|&nbsp; Your login code: <strong style="color:var(--accent)">${code}</strong><br><small style="color:var(--muted)">Use this exact name every time you rejoin.</small>`;
  } else {
    elements.captainCodeHint.textContent = "Your name will be shown with a capital first letter. The code is your name in lowercase.";
  }
}

function updateRoleFields() {
  const role = elements.roleSelect.value;
  const isCaptainRole = role === "captain";
  const isAdminRole = role === "admin";

  elements.captainFields.classList.toggle("hidden", !isCaptainRole);
  elements.adminFields.classList.toggle("hidden", !isAdminRole);
  elements.teamName.required = isCaptainRole;
  elements.adminUsername.required = isAdminRole;
  elements.adminPassword.required = isAdminRole;
  elements.displayName.required = isCaptainRole;

  if (isCaptainRole) {
    elements.displayNameLabel.textContent = "Captain name";
    elements.displayName.placeholder = "Enter captain name";
  } else if (isAdminRole) {
    elements.displayNameLabel.textContent = "Display name";
    elements.displayName.placeholder = "Optional";
  } else {
    elements.displayNameLabel.textContent = "Display name";
    elements.displayName.placeholder = "Optional for spectators and players";
  }

  syncCaptainCodeFromName();
}

function joinSession(payload, announce = true) {
  socket.emit("session:join", payload, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Login failed.", "error", "login");
      return;
    }

    state.participant = {
      role: response.role,
      displayName: response.displayName,
      team: response.team,
    };
    state.lastJoinPayload = payload;

    showDashboard();
    applyAuctionState(response.state);

    if (announce) {
      const descriptor = response.team ? `${response.displayName} | ${response.team.name}` : response.role;
      setFlash(`Connected to the auction room as ${descriptor}.`, "success", "app");
    }
  });
}

elements.roleSelect.addEventListener("change", updateRoleFields);
elements.displayName.addEventListener("input", syncCaptainCodeFromName);

[elements.auctionTabButton, elements.historyTabButton].forEach((button) => {
  button.addEventListener("click", () => {
    setActiveSection(button.dataset.section);
  });
});

elements.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!state.configReady) {
    setFlash("Loading app settings. Try again in a moment.", "info", "login");
    return;
  }

  const role = elements.roleSelect.value;
  const payload = {
    sessionId: state.defaultSessionId,
    role,
    displayName: elements.displayName.value.trim(),
    captainCode: elements.captainCode.value.trim(),
    teamName: elements.teamName.value.trim(),
    adminUsername: elements.adminUsername.value.trim(),
    adminPassword: elements.adminPassword.value,
  };

  setFlash("Checking your login...", "info", "login");
  joinSession(payload);
});

elements.leaveButton.addEventListener("click", () => {
  window.location.reload();
});

elements.bidForm.addEventListener("submit", (event) => {
  event.preventDefault();

  const lakhValue = Number(elements.bidAmount.value);
  const amount = lakhValue * 100000;

  socket.emit("bid:place", { amount }, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Bid was rejected.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash(`Bid accepted at ${formatAmount(response.state.currentBid)}.`, "success", "app");
  });
});

elements.quickBids.forEach((button) => {
  button.addEventListener("click", () => {
    const minimumBid = getMinimumBid();

    if (minimumBid == null) {
      return;
    }

    const offset = Number(button.dataset.offset || "0");
    elements.bidAmount.value = String(amountToLakhs(minimumBid) + offset);
  });
});

elements.savePlayersButton.addEventListener("click", () => {
  socket.emit("admin:players:set", { playerText: elements.playerTextarea.value }, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not save the player list.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash("Player list saved. You can start the first bid when ready.", "success", "app");
  });
});

elements.startAuctionButton.addEventListener("click", () => {
  socket.emit("admin:auction:start", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not start the next player.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash(
      `Bidding started for ${response.state.currentPlayer?.name || "the next player"}.`,
      "info",
      "app",
    );
  });
});

elements.pauseAuctionButton.addEventListener("click", () => {
  socket.emit("admin:auction:pause", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not pause the session.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash("The live bid is paused.", "info", "app");
  });
});

elements.resumeAuctionButton.addEventListener("click", () => {
  socket.emit("admin:auction:resume", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not resume the session.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash("The live bid resumed.", "success", "app");
  });
});

elements.endAuctionButton.addEventListener("click", () => {
  socket.emit("admin:auction:end", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not end the current bid.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
  });
});

elements.restartCurrentButton.addEventListener("click", () => {
  socket.emit("admin:auction:restart-current", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not restart the current player.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
  });
});

elements.restartWholeButton.addEventListener("click", () => {
  socket.emit("admin:auction:restart-all", {}, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not restart the whole auction.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
  });
});

elements.unsoldList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-result-id]");

  if (!button) {
    return;
  }

  socket.emit("admin:rebid", { resultId: button.dataset.resultId }, (response) => {
    if (!response?.ok) {
      setFlash(response?.error || "Could not queue the rebid.", "error", "app");
      return;
    }

    applyAuctionState(response.state);
    setFlash(`Rebid queued for ${response.lot?.name || "that player"}.`, "success", "app");
  });
});

elements.matchForm.addEventListener("submit", (event) => {
  event.preventDefault();

  socket.emit(
    "matches:add",
    {
      title: elements.matchTitle.value.trim(),
      date: elements.matchDate.value,
      venue: elements.matchVenue.value.trim(),
      result: elements.matchResult.value.trim(),
      score: elements.matchScore.value.trim(),
      notes: elements.matchNotes.value.trim(),
    },
    (response) => {
      if (!response?.ok) {
        setFlash(response?.error || "Could not save the match record.", "error", "app");
        return;
      }

      applyAuctionState(response.state);
      elements.matchForm.reset();
      setActiveSection("history");
      setFlash("Match record saved.", "success", "app");
    },
  );
});

socket.on("connect", () => {
  if (state.lastJoinPayload) {
    joinSession(state.lastJoinPayload, false);
    return;
  }

  setFlash("Connected. Login to enter the auction room.", "info", "login");
});

socket.on("disconnect", () => {
  const scope = state.joined ? "app" : "login";
  setFlash("Connection lost. Reconnecting automatically...", "error", scope);
});

socket.on("auction:state", (payload) => {
  applyAuctionState(payload.state);
});

socket.on("auction:start", (payload) => {
  applyAuctionState(payload.state);
  setFlash(`Bidding started for ${payload.state.currentPlayer?.name || "the next player"}.`, "info", "app");
});

socket.on("auction:pause", (payload) => {
  applyAuctionState(payload.state);
  setFlash("The administrator paused the live bid.", "info", "app");
});

socket.on("auction:resume", (payload) => {
  applyAuctionState(payload.state);
  setFlash("The administrator resumed the live bid.", "success", "app");
});

socket.on("auction:restart", (payload) => {
  applyAuctionState(payload.state);

  if (payload.mode === "current") {
    setFlash("The administrator restarted the current player bid.", "info", "app");
  } else {
    setFlash("The administrator restarted the whole auction.", "info", "app");
  }
});

socket.on("bid:update", (payload) => {
  applyAuctionState(payload.state);
});

socket.on("timer:reset", (payload) => {
  syncClock(payload);
  state.auction.auctionEndTime = payload.auctionEndTime;
  state.auction.remainingTimeMs = payload.remainingTimeMs;
  renderCountdown();
});

socket.on("auction:end", (payload) => {
  applyAuctionState(payload.state);

  const summary =
    payload.result?.status === "sold"
      ? `${payload.result.name} sold to ${payload.result.soldTo.teamName} for ${formatAmount(payload.result.soldPrice)}.`
      : `${payload.result?.name || "This player"} went unsold.`;

  const reason =
    payload.endedBy === "admin" ? " The administrator ended this bid early." : " Timer reached zero.";

  setFlash(`${summary}${reason}`, payload.result?.status === "sold" ? "success" : "info", "app");
});

socket.on("team:update", (payload) => {
  applyAuctionState(payload.state);
});

socket.on("matches:update", (payload) => {
  applyAuctionState(payload.state);
});

socket.on("auction:complete", (payload) => {
  applyAuctionState(payload.state);
  setFlash(
    "The queue is finished. Fixtures have been generated, and the administrator can still rebid unsold players or restart the auction.",
    "info",
    "app",
  );
});

socket.on("session:viewers", (payload) => {
  state.auction.liveViewers = payload.liveViewers;
  renderHeader();
});

updateRoleFields();
setActiveSection("auction");
render();
loadAppConfig();
window.setInterval(renderCountdown, 250);
