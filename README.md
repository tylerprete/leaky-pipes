# Leaky Pipes

A browser version of the Waterworks leaky-pipe card game (Winning Moves 2–4 player rules), with computer opponents, pass-and-play, and a dead-end warning.

Play it at https://tylerprete.github.io/leaky-pipes/ (GitHub Pages serves `docs/index.html` from `main`).

## Modes

- **Tables**:
  - *Classic*: each player's own table, with the valve at the right edge.
  - *Endless*: no edges, with the valve in the middle.
  - *Shared*: one endless table for everyone. Valves face each other, and pipelines can't run into each other or block the spot in front of another pipeline's open end.
- **Decks**:
  - *Tuned* (default): a self-play remix with more elbows, very few T's, slightly fewer leaky pipes, and 6 wrench cards (hold one and play it to fix a leak; the card is the discard).
  - *Original*: an estimate of the boxed mix.
- On Classic and Endless, the other pipelines are shown live next to yours. Tap one to swap it onto the big board, or drag a card over it.
- **Player colors**: tap a player's dot on the setup screen (or your own in an online lobby) to pick from 8 colors. No two players at a table share one. Your pick is remembered and asked for whenever you join. Online, you can change it in the lobby or after a game ends, and the host can recolor computers. The four defaults (blue, orange, green, pink) stay distinguishable with the common kinds of color blindness; `node tools/palette.js` checks that.

## Online play

Games against computers and pass-and-play need nothing but the static page. Playing across browsers needs a game server. There are two hosts for the same room logic (`server/room.js`):

- **Cloudflare Workers** (`cloudflare/`): a Worker plus a Durable Object per room. No machine to run, and rooms survive restarts. See `cloudflare/README.md`.
- **Node** (`server/server.js`): one process, for running it yourself.

The Node server, locally:

```
npm install
npm run build
npm run server        # http://localhost:8787 serves the page and the game socket
```

- The server runs the same rules engine, checks every move, plays computer seats, and sends each player only their own hand.
- One person creates a game and shares the 4-letter code or invite link. Up to 4 seats, any mix of people and computers.
- A dropped player keeps their seat: reopening the page resumes it. After 30 seconds away on their turn, a computer plays for them until they return.
- On the Node server, games live in memory, so a restart ends them and it must run as a single instance. The Cloudflare version saves each room and has neither limit.
- Players can send each other quick reactions during a game.
- To make the GitHub Pages copy offer online play, bake the address in: `LEAKY_SERVER=wss://your-host npm run build`. A `?server=wss://your-host` link also works without rebuilding.
- Settings: `PORT`, `MAX_ROOMS` (500), `AWAY_MS` (30000), `BOT_MS` (900).

Test: `node test/colors.js` picks colors locally and online and checks the shared table's tints. Test: `node test/online.js` plays a full game with two browsers and a computer, including a reaction, a disconnect and a resume.

## Offline

After one visit the game opens with no connection, for games against the computer and pass-and-play. A small service worker (`src/sw.js`, built to `docs/sw.js`) keeps a copy of the page and its icons. With a connection the page is always fetched fresh, so a new version shows up on the next load; the saved copy is only used when the network doesn't answer within 2.5 seconds. `node test/offline.js` checks it on a static site in a sub-folder, the Node server and (with `CF=1`) the Cloudflare Worker.

## Code

- `src/engine.js`: rules engine (placement, leaks, repairs, T's and caps, spout, dead-end analysis, shared-table rules)
- `src/bot.js`: computer players. A heuristic scorer (Easy/Normal) and a lookahead search (Hard). In the page, Hard runs in a Web Worker built from the engine and bot code already inlined there, so the page stays responsive while it thinks; if the worker can't run, the move is worked out on the page as before.
- `src/ui.js`, `src/style.css`, `src/page.html`: the single-page game
- `server/room.js`: the online room logic (seats, hidden hands, computer seats, reconnects)
- `server/server.js`, `cloudflare/worker.js`: the two hosts for it
- `bots/v1.js`: the first bot, kept as a baseline
- `tools/arena.js`: self-play arena (seat-rotated matches with confidence intervals). Env: `TABLE`, `DECK`, `LAYOUT`.
- `tools/tune.js`: weight tuner (self-play evolution)
- `tools/ablate.js`, `tools/analyze.js`: the experiments behind the strategy guide
- `tools/fun.js`: "fun" metrics from self-play (time stuck, droughts where nobody can play, game length, sabotage rate, lead changes, seat fairness)
- `tools/deck-search.js`, `tools/rules-exp.js`, `tools/why-stuck.js`, `tools/shared-exp.js`: the deck and shared-table experiments
- Experiment outputs are in `tools/results/`.

```
npm run build   # writes docs/index.html (the GitHub Pages site)
npm test        # rules tests and online-room tests (Cloudflare runs these before every deploy)
node test/hard-thread.js   # Hard thinks in a background worker: checks the page stays responsive
node tools/arena.js '{"kind":"search"}' '{"kind":"v2"}' 2 60
node tools/why-stuck.js 300 2
TABLE=shared DECK=tuned node tools/arena.js '{"kind":"v2"}' '{"kind":"v1"}' 3 100
```

House rules where the rulebook is silent:

- A leak can't leave an opponent's pipeline with no way to finish.
- You get a warning before doing that to your own pipeline.
- Pipes can't run into a cap card that's already on the table.

The Original deck mix is an estimate (see `DECK_SPEC` in `src/engine.js`).
