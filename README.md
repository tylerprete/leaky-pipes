# Leaky Pipes

A browser version of the Waterworks leaky-pipe card game (Winning Moves 2–4 player rules), with computer opponents, pass-and-play, and a dead-end warning.

Play it at https://tylerprete.github.io/leaky-pipes/ (GitHub Pages serves `docs/index.html` from `main`).

## Modes

- **Tables**:
  - *Classic*: each player's own table, with the valve at the right edge.
  - *Endless*: no edges, with the valve in the middle.
  - *Shared*: one table for everyone. Valves face each other, and pipelines can't run into each other or block the spot in front of another pipeline's open end.
- **Decks**:
  - *Tuned* (default): a self-play remix with more elbows, very few T's, slightly fewer leaky pipes, and 6 wrench cards (a wrench card becomes a wrench when drawn).
  - *Original*: an estimate of the boxed mix.
- On Classic and Endless, the other pipelines are shown live next to yours. Tap one to swap it onto the big board, or drag a card over it.

## Code

- `src/engine.js`: rules engine (placement, leaks, repairs, T's and caps, spout, dead-end analysis, shared-table rules)
- `src/bot.js`: computer players. A heuristic scorer (Easy/Normal) and a lookahead search (Hard).
- `src/ui.js`, `src/style.css`, `src/page.html`: the single-page game
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
