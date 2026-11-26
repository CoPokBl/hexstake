# Maintenance log

## 2026-11-26: live presence on the home page
- The 2026-11-25 run stopped after reading its trigger and did nothing. Re-run today on request.
- Health OK, live = main HEAD, smoke tests green, no issues or PRs, no payments, no errors.
- Usage: the daily challenge's first day (11-24) had 4 real players, but nobody came back on 11-25,
  and nobody has played yet today. Ranked: 5 queue joins but only 2 matches made over two days, so
  players queue alone and give up.
- Added `/api/live` (online, searching, live PvP matches, open lobbies; synthetic players
  excluded). The home page shows a live line such as "1 player is searching for a ranked match
  right now. Join the queue", refreshed every 10 seconds and hidden when nothing is happening.
- 19:44 scheduled run: no change since the afternoon run (healthy, no issues, one anonymous
  page view, no payments). Nothing shipped.
- Growth is still the real constraint. It needs the owner to put Hexstake in front of Serble users
  (asked on 11-23, no answer yet).

## 2026-11-24: records count PvP only
- Health OK, live = main HEAD, no issues or PRs, no payments, no errors. Analytics now excludes
  synthetic traffic (3 smoke matches filtered out).
- Daily challenge, day 1: 8 plays by 4 real players, no resignations, about 16 turns per game.
  Top of the board: CoPokBl and Baylie at 13 turns. Retention works where the bots alone didn't.
- Feedback: "bots counting against win/loss on the ranks page is weird… someone can just spam win
  against easy bot". Fixed: only ranked, casual and staked matches update W-L-D and games. Schema
  migration v2 rebuilds every player's record from PvP match history (checked on a v1-shaped DB:
  12 games 10-2 became 2 games 1-1). The Ranks page now says what counts.

## 2026-11-23: honest analytics, daily challenge
- Health OK, live = main HEAD, no issues or PRs, no payments, no errors.
- The tutorial gate works: tutorial runs now get through claim → lock in → claimed. But all 3
  tutorial sessions in the last 24h were my own smoke test (1280px width, at its run times).
  **Real usage was zero for the day.**
- Smoke tests and headless browsers now create `guest:synth-…` guests (via the
  `x-hexstake-synthetic` header or a HeadlessChrome/Playwright user agent), and analytics and
  public stats exclude them. The admin analytics shows a `synthetic` count. Older smoke matches
  before today are still mixed in and can't be relabelled, because the admin SQL is read-only.
- Retention: added a **daily challenge**. Everyone gets the same seeded map each UTC day against the
  Hard bot, from seat 0, and a daily board ranks each player's best win by fewest turns. It has a
  banner on the home page and a "try again" end screen.
- Fixed the end-screen wording: "opponent left" was shown even when *you* missed three turns.
- Open question: real traffic is near zero. Growth probably needs a mention somewhere Serble users
  hang out. That's outward-facing, so it's flagged for the owner rather than done.

## 2026-11-22: tutorial players skip the coach and hit Pass turn
- Health OK, live = main HEAD, no issues or PRs, no payments, no errors. One transient 500 on
  /api/admin/analytics: my operator login check against Serble timed out, and a retry was fine.
- Tutorial funnel since the phone fix: 4 starts, still 0 step events. All 4 pressed "Pass turn"
  (lock-in events) without touching the coach, then resigned after about 1.5 turns. The big green
  Pass turn button beat a paragraph plus a small "Next".
- Fix: merged the home and claim steps, so the first instruction is one tap on the board. Lock in
  and Pass turn are disabled ("Tap the hex first") until that tap. `ui_tutorial_start` now records
  screen width, to separate phones from desktops.
- The smoke test now runs the first-visit path: tutorial, tap the highlighted hex, lock in, turn
  resolves, resign.

## 2026-11-21: tutorial was invisible on phones
- Health OK, no errors, no issues or PRs, no payments in 24h. 10 matches, 3 active players.
- Funnel: 5 tutorial starts, **0** step events. All 5 tutorial players placed no orders, then
  resigned after turn 1 or abandoned. Cause: on phones the coach panel and the Lock in button sat
  below the fold, so new players saw only a board with no instructions.
- Fixes: the coach now renders above the board on every screen size; phones get a fixed bottom
  bar with energy left, Clear and Lock in; and the canvas no longer flashes the mobile
  tap-highlight. Tutorial steps advanced by button are now tracked, so the funnel is complete.
- Verified on an iPhone 13 viewport with taps only: home → claim → lock in → claimed.
- **Deploy blocked (infra):** Komodo reports "Cannot send command when Server is unreachable or
  disabled" for the deployment's server. Production keeps serving `sha-2b0b783`; the phone fixes
  (`e89899f`) are not live yet. The deploy script now waits for the Komodo job and prints its
  stage logs, so this shows up clearly. Reported to the owner.
- 21:56 retry: same error ("Server is unreachable or disabled"). Leaving it for the daily run.
- 23:05: the owner reported Komodo recovered. Redeployed, and `sha-0d3bbd6` is live with the phone fixes.
  Owner-side problems now go to the owner's ntfy topic (see CLAUDE.md).
- Next: check the tutorial funnel again tomorrow. If players still drop at step 2, make the
  first claim one tap with no brush choice.

## 2026-11-20 (evening run): interactive tutorial, stronger bots
- Health OK, all deploys and smoke tests green, no open issues or PRs, no errors, no stuck
  payments. 18 matches in 24h; ranked is picking up (7 matches). One staked match paid out.
- Feedback: "make an interactive tutorial instead of a slab of text". Replaced the text guide
  with a 7-step tutorial match against a passive easy bot with 90-second turns. Each step points
  at a hex with a pulsing ring and advances when the player does it. "Play now" starts it for
  first-time visitors, and it's also on the Practice card and the Rules page.
- Bots: humans beat *hard* 3 of 4 but *normal* 0 of 6. Replays showed hard (a) let its home
  fall, by assuming only 60% of the attacker's bank would hit it, and (b) undervalued wells and
  lost the economy (4 vs 14 income). Hard now defends against the full bank, normal against 80%,
  and the well value went up after a sweep. Against a scripted all-in well-rusher, hard went from
  53% to 70% and normal from 37% to 49%. The rusher is now a regression test
  (`test/strategies.ts`).
- Fixed: home markers vanished once a home's fill became opaque (strength 8 and up), because
  they were drawn in the owner's colour. Owned homes now use white.

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
