# Leaky Pipes on Cloudflare Workers

The online game server as one Worker and one Durable Object class. Nothing to keep running: a room exists only while a game does.

## How it maps

| Piece | What it does |
|---|---|
| Worker (`worker.js`, default export) | Serves the game page from `docs/`, and passes each WebSocket to the room it belongs to. |
| `GameRoom` Durable Object | One per game, named by the 4-letter code. Holds the seats and the game, checks moves, plays computer seats. |
| WebSocket Hibernation | Sockets are owned by the platform, so an idle room can leave memory without dropping players. Each socket is tagged with a connection id. |
| Storage | The room is saved after every message and reloaded when the object wakes. Deploys and evictions don't end games. |
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

- `MAX_LEVEL` (default `normal`): the strongest computer level a room may use. Hard runs a look-ahead that takes hundreds of milliseconds of CPU per move, far over the free plan's per-request CPU limit. Set it to `hard` only on the paid plan.
- `BOT_MS` (900): pause before a computer moves.
- `AWAY_MS` (30000): how long an absent player has on their turn before a computer plays it.

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

The two per-address limits are [Rate Limiting bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), set under `ratelimits` in `wrangler.jsonc`. Cloudflare counts them approximately and separately in each of its locations, and many people can share one address (a school, a phone network), so they are set well above what a household needs. `node test/cf-abuse.js` checks all six against the local emulator.

## Not yet verified on Cloudflare itself

Everything above was tested in Wrangler's local emulator, which does not enforce plan limits. Two things to watch on the first real deploy:

- **CPU limit on the free plan.** A normal move measured well under a millisecond of engine time in Node, but the limit also covers loading and saving the room. If moves fail with "exceeded CPU" errors, `npx wrangler tail` will show them.
- **Daily request limit on the free plan.** Each WebSocket message and each alarm counts toward it.
