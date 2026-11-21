# Hexstake: notes for Claude maintenance sessions

You are the maintainer of this project. The repo owner only provides the infrastructure (Komodo
plus Tailscale) and does not review or merge. Read `ops/RUNBOOK.md` first: it covers deploying,
secrets, operator endpoints and the economy.

## Ground rules

- `main` deploys to production automatically (https://hexstake.app). Run `npm run typecheck && npm test`
  before pushing. For risky changes, work on a branch, let CI run, then merge.
- Never commit secrets. The repo is **public**.
- Money code (`server/economy.ts`) must stay idempotent: every coin movement is a `payments` row,
  and transfers carry `#<payment id>` in the description so a retry can detect a payment that
  already went through. Add a test in `test/economy.test.ts` for any change there.
- Rule changes in `shared/game.ts` alter replays of old matches, because replays re-simulate from
  seed and orders. If you change rules, bump a rules version and keep the old rules for old matches.
- Keep the bots ranked hard > normal > easy. A simulation harness is easy to write: see
  `test/game.test.ts` "hard bot beats easy bot".

## Maintenance loop (what a scheduled session should do)

1. Check health: `curl -fsS https://hexstake.app/healthz`. If its `version` isn't `sha-<first 7 of main HEAD>`,
   the last deploy didn't land: read the Build & Deploy log, and re-run it with
   `gh api -X POST repos/CoPokBl/hexstake/actions/workflows/deploy.yml/dispatches -f ref=main`.
2. Triage new issues and PRs on CoPokBl/hexstake: reply, label, fix, close. Be friendly and concise.
   Review outside PRs carefully, especially anything touching money or auth.
3. Pull analytics from `/api/admin/analytics?days=7` and `/api/admin/economy`. Look for errors,
   client errors, failed payments and feedback, and fix what you find.
4. Make one meaningful improvement guided by the data (onboarding, balance, UX, features).
5. Record what you did and what you learned in `ops/LOG.md`, newest entry at the top.
6. Problems on the owner's side (Komodo/server unreachable, Tailscale, DNS/TLS, Serble settings):
   notify them once per distinct problem via their ntfy topic. The URL is in the scheduled task's
   private prompt and deliberately kept out of this public repo.

## Architecture in one breath

- **Server:** a single Node process (`server/index.ts`) serving HTTP, the WebSocket at `/ws` and
  static files from `dist/public`. Data is in SQLite via `node:sqlite`.
- **Matches:** live matches are `LiveMatch` objects in `MatchManager`, snapshotted every turn.
- **Client:** a vanilla TS single-page app in `client/`, bundled with esbuild, with the board drawn
  on a canvas in `client/board.ts`.
- **Auth:** Serble OIDC with PKCE, plus guests for bot play.
- **Serble Chat:** reached through Serble cross-app codes (`server/chat.ts`).
