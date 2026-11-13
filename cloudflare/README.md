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

Open it in two windows and use Play online. `node test/online.js` with `ONLINE_URL=http://localhost:8787/` plays a full game against it, and `node test/cf-restart.js` checks that a room survives a restart.

## Deploy

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

## Settings (`wrangler.jsonc` > `vars`)

- `MAX_LEVEL` (default `normal`): the strongest computer level a room may use. Hard runs a look-ahead that takes hundreds of milliseconds of CPU per move, far over the free plan's per-request CPU limit. Set it to `hard` only on the paid plan.
- `BOT_MS` (900): pause before a computer moves.
- `AWAY_MS` (30000): how long an absent player has on their turn before a computer plays it.

## Not yet verified on Cloudflare itself

Everything above was tested in Wrangler's local emulator, which does not enforce plan limits. Two things to watch on the first real deploy:

- **CPU limit on the free plan.** A normal move measured well under a millisecond of engine time in Node, but the limit also covers loading and saving the room. If moves fail with "exceeded CPU" errors, `npx wrangler tail` will show them.
- **Daily request limit on the free plan.** Each WebSocket message and each alarm counts toward it.
