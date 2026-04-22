const path = require("path");
const dotenv = require("dotenv");

dotenv.config({
  path: path.join(__dirname, "..", ".env"),
});

const DEFAULT_SESSION_ID = process.env.DEFAULT_SESSION_ID || "hostel-football-auction";
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 75);

const AUCTION_SETTINGS = Object.freeze({
  auctionDurationMs: Number(process.env.AUCTION_DURATION_MS || 60000),
  minIncrement: Number(process.env.MIN_INCREMENT || 100000),
  basePrice: Number(process.env.BASE_PRICE || 200000),
  teamBudget: Number(process.env.TEAM_BUDGET || 20000000),
});

const ADMIN_ACCOUNT = Object.freeze({
  username: process.env.APP_ADMIN_USERNAME || "admin",
  password: process.env.APP_ADMIN_PASSWORD || "Ayy.Ali0506",
});

const DB_CONFIG = Object.freeze({
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || "ayaan",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  ssl: String(process.env.DB_SSL || "false").toLowerCase() === "true",
});

const TEAM_ACCENTS = Object.freeze([
  "#ff7a18",
  "#06b6d4",
  "#f59e0b",
  "#34d399",
  "#f472b6",
  "#38bdf8",
  "#f97316",
  "#a3e635",
  "#fb7185",
  "#818cf8",
]);

module.exports = {
  ADMIN_ACCOUNT,
  AUCTION_SETTINGS,
  DB_CONFIG,
  DEFAULT_SESSION_ID,
  MAX_PLAYERS,
  TEAM_ACCENTS,
};
