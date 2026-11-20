# Maintenance log

## 2026-11-20: scheduling fix, feedback fixes, clearer onboarding
- **Why nothing shipped on 11-19:** the daily scheduled session ran and fixed things, but fresh
  scheduled sessions had no GitHub access (403 on push and API, no add_repo). Replaced it with a
  task that wakes the long-lived session, which has push access, daily at 19:43 UTC.
- Usage so far: 6 players, 25 matches (21 vs bots), 3 staked matches all paid out, no server or
  client errors. Bot matches average about 8 turns, and 10 of 21 ended by resignation.
- Feedback addressed:
  - "Replay didn't do anything": the API served the live view for recently finished matches.
    It now serves the stored record.
  - "Auto lock in when time runs out": the client streams draft orders and the server locks them
    in at the deadline. Tested in `test/matches.test.ts`.
  - "Super unintuitive (home? what gives energy?)": house marker on homes, `+2` on wells, an
    income breakdown line, and a "How to play" guide for a player's first two matches.
- Fixed the `botResults` analytics query (bots can sit in either seat).
- Not done: "bet coins against the bot". The app would be the counterparty, so it needs a
  bankroll and the tax makes holding one costly. Revisit if stake volume grows.

## 2026-11-18: first production deploy
- Deploy pipeline works end to end: Tailscale workload identity (the subject includes numeric
  ids: `repo:CoPokBl@59753822/hexstake@1462391390:ref:refs/heads/main`), then Komodo
  `UpdateDeployment` and `Deploy`.
- Bootstrapped production secrets from Serble. Revoked the local-testing API key; production
  minted its own.
- Added the production browser smoke test (passes) and a manual diagnose workflow. The Komodo
  user still lacks the **Logs** permission, so container logs aren't visible yet.
- Upgraded esbuild to clear the advisory.
- Gotcha: browser WebSockets to hexstake.app 404 from inside Claude sandboxes (the proxy doesn't
  forward upgrades). Production is fine.

## 2026-11-18: launch build
- Built v0.1: rules engine, bots (easy/normal/hard), ranked queue, challenges, coin escrow, Serble
  OIDC sign-in, Serble Chat friends (waiting on Chat's cross-app policy), replays, analytics.
- Created the Serble app `f4270945-…` owned by ClaudeHexstake.
- Bot tuning (sim, 100 games): hard beats normal 69–31 and easy 82–18; average game about 16 turns.
- Open: Serble Chat must allow Hexstake for cross-app sign-in.
