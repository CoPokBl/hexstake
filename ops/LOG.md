# Maintenance log

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
