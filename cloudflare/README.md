# Leaky Pipes on Cloudflare Workers

The online game server as one Worker and one Durable Object class. Nothing to keep running: a room exists only while a game does.

## How it maps

| Piece | What it does |
|---|---|
| Worker (`worker.js`, default export) | Serves the game page from `docs/`, and passes each WebSocket to the room it belongs to. |
| `GameRoom` Durable Object | One per game, named by the 4-letter code. Holds the seats and the game, checks moves, plays computer seats. |
| WebSocket Hibernation | Sockets are owned by the platform, so an idle room can leave memory without dropping players. Each socket is tagged with a connection id. |
| Storage | The room is saved (one write) after every message that changes it, and reloaded when the object wakes. Deploys and evictions don't end games. |
| Alarm | One per room: the next computer move (or covering for an absent player), otherwise a clean-up two hours after the last activity. |

The room rules themselves are in `server/room.js`, shared with the Node server.

## Run it locally

```
npm install
npm run build          # writes docs/index.html, which the Worker serves
npm run cf:dev         # http://localhost:8787
```

Open it in two windows and use Play online. `node test/online.js` with `ONLINE_URL=http://localhost:8787/` plays a full game against it, and `node test/cf-restart.js` checks that a room survives a restart, and `node test/cf-abuse.js` checks the guards against abuse.

## Deploy from GitHub (recommended)

Cloudflare builds and deploys on every push to `main`.

1. In the Cloudflare dashboard, go to Workers & Pages, choose Create, then import a repository.
2. Authorize the Cloudflare GitHub app for `tylerprete/leaky-pipes` and select it.
3. Keep the project name `leaky-pipes` (it must match `name` in `wrangler.jsonc`), the root directory empty, and the deploy command `npx wrangler deploy`.
4. Set the build command to `npm test && npm run build`. If a test fails, the build stops there and the version that is already live stays live.
5. If asked, pick your `workers.dev` subdomain. It becomes part of the public address.

## Deploy from your machine

```
npx wrangler login     # once, opens a browser
npm run build
npm run cf:deploy
```

Wrangler prints the address, like `https://leaky-pipes.<your-subdomain>.workers.dev`. That address is the game: open it and use Play online.

To make the GitHub Pages copy use it too:

```
LEAKY_SERVER=wss://leaky-pipes.<your-subdomain>.workers.dev npm run build
git commit -am "Point the page at the game server" && git push
```

## Settings (`wrangler.jsonc` at the repository root, under `vars`)

- `MAX_LEVEL` (`hard`): the strongest computer level a room may use.
- `HARD_SLICE` (2): how much of a Hard computer's search runs per event. See below.
- `THINK_MS` (2600): extra time a Hard computer may take, beyond its usual pause, before it moves with what it has.
- `BOT_MS` (900): pause before a computer moves.
- `AWAY_MS` (30000): how long an absent player has on their turn before a computer plays it.

## Hard computers, a piece at a time

A Hard computer looks ahead by playing out a few hundred futures, hundreds of milliseconds of CPU per move. The free plan allows about 10 ms per event, so the search can't run in one go.

Instead the room cuts it into pieces (`start()` and `step()` in `src/bot.js`, `think()` in `server/room.js`):

1. When a Hard computer's turn starts, the room starts a search and asks one player's page for a number of "tick" messages.
2. The page sends that many ticks in a burst. A tick carries no information; it is only a reason for the Durable Object to run again, with a fresh CPU allowance.
3. Each tick runs `HARD_SLICE` units of the search (twice that on Classic and Endless, where a unit is cheaper). A unit is one move played on a copy of the game. Most ticks change nothing, so nothing is saved.
4. When the computer's pause is up, it plays the search's answer. If the search is still going it gets `THINK_MS` longer; if no ticks came at all (an old cached page), it plays a Normal move at once.

The result is the same move Hard would pick thinking straight through (`test/room.test.js` checks that). Cost: about 90 to 330 ticks per computer move depending on table and players; incoming WebSocket messages are billed at 20 to 1.

`node test/cf-hard.js [players]` plays against Hard computers on the local emulator. The emulator does not enforce the CPU limit, so the size of a slice is a guess until measured on the live Worker: look at CPU time per `hibernatableWebSocket` event in the Worker's logs, and lower `HARD_SLICE` to 1 if ticks run over.

## Storage writes

Each event that changes the room saves it with one write. The alarm is only set when the room needs a timer (a computer's move, cover for an absent player) or when no alarm is pending. The two-hour idle clean-up is not pushed back on every move: when it fires and the room has been used since, it re-arms itself for two hours after the last activity. Ticks and reactions write nothing.

## Guards against abuse

The page is public, so anyone can open sockets to it. What stops a script from running up usage:

| Guard | Where | Limit |
| --- | --- | --- |
| New connections per network address | Worker (`CONNECT_LIMIT`) | 120 a minute, then HTTP 429. A player who is reconnecting just tries again. |
| New games per network address | Worker (`CREATE_LIMIT`) | 10 a minute, then a "try again in a minute" message |
| Sockets per room | room | 12 (four seats, plus reconnects that overlap the socket they replace) |
| Messages per socket | room | 40 in 10 seconds, then the socket is closed. The seat is kept; the player can come back. |
| Unknown game code | room | told so and closed at once; no socket is kept |
| Room opened but never created | room | closed after 60 seconds |

The two per-address limits are [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), set under `ratelimits` in `wrangler.jsonc`. Cloudflare counts them approximately and separately in each of its locations, and many people can share one address (a school, a phone network), so they are set well above what a household needs. `node test/cf-abuse.js` checks all six against the local emulator, and `node test/cf-idle.js` checks the idle clean-up.

## What has and hasn't been checked on the live Worker

- Checked live on the free plan: ordinary games on every table, with CPU per event at 1 to 6 ms.
- Checked only in the local emulator, which does not enforce plan limits: the abuse guards, Hard computers thinking in slices, and the one-write save.
- The free plan's daily limits apply: each alarm and each new connection counts as a request, and incoming WebSocket messages count at 20 to 1.
