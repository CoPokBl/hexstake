# Hexstake

**Out-think. Out-bid. Out-hex.** A fast two-player strategy duel on a hex map, played at
**[hexstake.app](https://hexstake.app)**.

Both players secretly spend energy on hexes at the same time, then everything resolves at once.
Claim wells for income, cut off your opponent's supply lines and storm their home. A match takes
about three minutes.

- **Practice** against three bot levels, no account needed.
- **Ranked** matchmaking with an Elo ladder (sign in with [Serble](https://serble.net)).
- **Challenges**: send a link to a friend or open a public lobby, and optionally
  **stake Serble coins**. The winner takes the pot minus a 5% house cut.
- **Serble Chat friends**: see your friends and DM them a challenge.
- Replays of every match, spectating of live ones, installable on phones (PWA).

Rules: https://hexstake.app/rules

## Reporting bugs / ideas

Open an [issue](https://github.com/CoPokBl/hexstake/issues) or use **Send feedback** in the app
footer. This project is maintained by an AI agent (Claude) and issues are triaged regularly.

## Development

Requires Node 22.13+ (uses the built-in `node:sqlite`).

```bash
npm ci
npm test          # engine + economy tests
npm run dev       # builds and serves on http://localhost:8080
```

Bots and guest play work locally without any configuration. Serble sign-in needs
`SERBLE_CLIENT_SECRET` (and coin stakes need `SERBLE_APP_KEY`). See `ops/RUNBOOK.md`.

| Path | What |
|---|---|
| `shared/game.ts` | Rules engine (pure, deterministic, shared by server and client) |
| `shared/bot.ts` | Heuristic bot |
| `server/` | HTTP + WebSocket server, matchmaking, Serble integration, escrow |
| `client/` | Browser app (vanilla TS + canvas) |
| `deploy/` | Komodo deploy scripts and non-secret runtime env |

## How coin stakes work

1. A player creates a challenge with a stake of S coins.
2. When someone accepts, both players approve a Serble transaction proposal of S coins to the
   Hexstake app on serble.net.
3. Once both payments are confirmed, the match starts.
4. The winner is paid `2S - floor(2S × 5%)` by Serble balance transfer. Draws, cancelled lobbies
   and matches that can't be resumed are refunded in full.

Every coin movement is recorded and retried until it succeeds, and the retry checks Serble so it
never pays twice. Coins are only held while a match is being set up or played.

## License

MIT
