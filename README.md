# Hostel Football Auction

This project now includes:

- login first, then auction dashboard
- administrator-only player setup
- up to `75` manually entered players before bidding starts
- captain codes `Captain1` to `Captain4`
- captain-chosen team names
- `2L` base price for every player
- `2Cr` budget for every team
- `1L` bid increment
- `60` second timer with admin early-close control
- admin restart options for the current player or the whole auction
- separate `Match History` section with saved records
- MySQL-backed storage for auction state, bids, players, teams, and match history

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Change credentials and auction settings

Edit `.env` for your local values. The app now reads its runtime settings from environment variables.

Useful keys:

- `APP_ADMIN_USERNAME`
- `APP_ADMIN_PASSWORD`
- `CAPTAIN1_CODE` to `CAPTAIN4_CODE`
- `BASE_PRICE`
- `TEAM_BUDGET`
- `MIN_INCREMENT`
- `MAX_PLAYERS`
- `AUCTION_DURATION_MS`
- `DEFAULT_SESSION_ID`
- `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`

## Match history storage

Match records are stored in MySQL in the `match_history` table.

## Notes

- The default room id is `hostel-football-auction`.
- The backend automatically creates the database and required tables on startup if the MySQL user has permission.
- Captains only see their own detailed team card and budget in the UI, while everyone can still see all team names and captains.
