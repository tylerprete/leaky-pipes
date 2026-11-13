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

## Online play

Games against computers and pass-and-play need nothing but the static page. Playing across browsers needs the small game server in `server/`:

```
npm install
npm run build
npm run server        # http://localhost:8787 serves the page and the game socket
```

- The server runs the same rules engine, checks every move, plays computer seats, and sends each player only their own hand.
- One person creates a game and shares the 4-letter code or invite link. Up to 4 seats, any mix of people and computers.
- A dropped player keeps their seat: reopening the page resumes it. After 30 seconds away on their turn, a computer plays for them until they return.
- Games live in memory, so restarting the server ends them. Run a single instance.
- Deploy anywhere that runs a container and allows WebSockets. `deploy/` has a ready setup (Docker Compose with Caddy for HTTPS) and step-by-step notes for a free Oracle Cloud instance.
- To make the GitHub Pages copy offer online play, bake the address in: `LEAKY_SERVER=wss://your-host npm run build`. A `?server=wss://your-host` link also works without rebuilding.
- Settings: `PORT`, `MAX_ROOMS` (500), `AWAY_MS` (30000), `BOT_MS` (900).

Test: `node test/online.js` plays a full game with two browsers and a computer, including a disconnect and resume.

## Code

- `src/engine.js`: rules engine (placement, leaks, repairs, T's and caps, spout, dead-end analysis, shared-table rules)
- `src/bot.js`: computer players. A heuristic scorer (Easy/Normal) and a lookahead search (Hard).
- `src/ui.js`, `src/style.css`, `src/page.html`: the single-page game
- `server/server.js`: the online game server (rooms, hidden hands, reconnects)
- `bots/v1.js`: the first bot, kept as a baseline
- `tools/arena.js`: self-play arena (seat-rotated matches with confidence intervals). Env: `TABLE`, `DECK`, `LAYOUT`.
- `tools/tune.js`: weight tuner (self-play evolution)
- `tools/ablate.js`, `tools/analyze.js`: the experiments behind the strategy guide
- `tools/fun.js`: "fun" metrics from self-play (time stuck, droughts where nobody can play, game length, sabotage rate, lead changes, seat fairness)
- `tools/deck-search.js`, `tools/rules-exp.js`, `tools/why-stuck.js`, `tools/shared-exp.js`: the deck and shared-table experiments
- Experiment outputs are in `tools/results/`.

```
npm run build   # writes docs/index.html (the GitHub Pages site)
npm test        # rules tests
node tools/arena.js '{"kind":"search"}' '{"kind":"v2"}' 2 60
node tools/why-stuck.js 300 2
TABLE=shared DECK=tuned node tools/arena.js '{"kind":"v2"}' '{"kind":"v1"}' 3 100
```

House rules where the rulebook is silent:

- A leak can't leave an opponent's pipeline with no way to finish.
- You get a warning before doing that to your own pipeline.
- Pipes can't run into a cap card that's already on the table.

The Original deck mix is an estimate (see `DECK_SPEC` in `src/engine.js`).
