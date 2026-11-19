# Leaky Pipes

A browser version of the Waterworks leaky-pipe card game: computer opponents, pass-and-play, and
online multiplayer. Plain JavaScript with no framework and no bundler. README.md covers the modes,
online play, house rules and experiment tools in more detail.

## Layout

- `src/engine.js`: the rules engine. One file is shared by the page, the Node server and the
  Cloudflare Worker, so it must keep running in both the browser and Node (`window.LP` /
  `module.exports`).
- `src/bot.js`: the computer players (Easy/Normal heuristic, Hard lookahead). `bots/v1.js` is the
  old baseline.
- `src/ui.js`, `src/style.css`, `src/page.html`, `src/sw.js`: the single-page game and its service
  worker.
- `server/room.js`: the online room (seats, hidden hands, computer seats, reconnects, colors). Two
  hosts share it: `server/server.js` (Node, for local testing) and `cloudflare/worker.js` (one
  Durable Object per room). The worker passes messages straight to the room, so a new message
  type needs only room.js and ui.js.
- `tools/`: self-play arena, tuning and experiments. Results go to `tools/results/`.
- `docs/`: build output. Never edit `docs/index.html` or `docs/sw.js` by hand.

## Build and ship

- `npm run build` inlines `src/` into `docs/index.html` and fingerprints `docs/sw.js`. Run it
  before every commit that touches `src/`, and commit both files.
- Work on `main` unless told otherwise. A push to `main` does two things:
  - GitHub Pages serves `docs/` at https://tylerprete.github.io/leaky-pipes/
  - Cloudflare's Git build runs `npm test && npm run build`, then `npx wrangler deploy`, which
    serves the Worker and the page at https://leaky-pipes.psyonic.workers.dev/. A failing test
    stops the build, and the live version stays live. Setup details: `cloudflare/README.md`.
- After a change people will see, republish `docs/index.html` to the Leaky Pipes artifact (slug
  `5e41fdeb-821c-4eca-a8a8-9730c16d1a16`).
- End commit messages with the Co-Authored-By / session lines the session gives you.

## Compatibility

The page and the server update separately, and the service worker can keep an older page cached
for a while. So:

- New fields in messages and room info must be optional both ways. An old page must work with a
  new server, and a new page with an old server (detect the feature and hide it if it's missing).
- Rooms persist in Durable Object storage across deploys. `Room.load` must accept rooms saved by
  older code; fill in defaults there.
- Games saved in localStorage (`leaky-pipes-v1`) must still load after a change.
- The static page must keep working without any server, for games against computers.

## Tests

- `npm test`: engine and room tests. Fast; run it after every change.
- Browser tests use Playwright with Chromium (`require('playwright')`). Claude's cloud environment
  has it preinstalled. Elsewhere, run `npm i -D playwright && npx playwright install chromium`.
  Each test is run with `node test/<name>.js`; most open `docs/index.html`, so build first.
  - `online.js`: full online games against the Node server.
  - `colors.js`: color picking, locally and online.
  - `pnp.js`, `smoke.js`: pass-and-play, and a full game against a computer.
  - `events.js`: the messages shown around computer moves.
  - `drag.js`, `drag2.js`, `wrenchcard.js`: drag-and-drop on mouse and touch.
  - `offline.js`: the game opens and plays with no connection after one visit.
  - `hard-thread.js`: the Hard computer thinking without freezing the page.
- `cf-*.js` run against `wrangler dev` (they start it themselves): restarts, abuse limits, idle
  clean-up, Hard on the Worker. Run them after changing `cloudflare/worker.js` or how rooms are
  saved.
- Screenshots go to `shots/` (gitignored). Look at them after UI changes, at phone width (390px)
  and desktop width.
- Add tests for new behavior: room rules in `test/room.test.js`, UI flows as a Playwright script.

## Constraints

- The Hard computer on the Worker runs in slices (`HARD_SLICE` in `wrangler.jsonc`) to stay
  under the free plan's CPU limit per event. Don't make room handlers do heavy work in one event.
- Player colors live in `LP.COLORS`. The first four are the defaults and are chosen to stay
  apart for color-blind players. Run `node tools/palette.js` after changing the palette.

## Product direction

- A fun game matters more than matching the physical game exactly. Long stretches where everyone
  is blocked are bad.
- Big experimental changes go in as alternate modes or options, not replacements.
- Computer opponents play fair: they never see other players' hands.
- Back balance and rules changes with self-play numbers (`tools/arena.js`, `tools/fun.js`), not
  intuition. Report the numbers.
- Mobile first: everything has to work by touch on a phone, including iPad Safari.
