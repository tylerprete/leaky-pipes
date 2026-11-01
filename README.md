# Leaky Pipes

A browser version of the Waterworks leaky-pipe card game (Winning Moves 2–4 player rules), with computer opponents, pass-and-play, and a dead-end warning.

- `src/engine.js`: rules engine (placement, leaks, repairs, T's and caps, spout, dead-end analysis)
- `src/bot.js`: computer players. A heuristic scorer (Easy/Normal) and a lookahead search (Hard)
- `src/ui.js`, `src/style.css`, `src/page.html`: the single-page game
- `bots/v1.js`: the first bot, kept as a baseline
- `tools/arena.js`: self-play arena (seat-rotated matches with confidence intervals)
- `tools/tune.js`: weight tuner (self-play evolution)
- `tools/ablate.js`, `tools/analyze.js`: the experiments behind the strategy guide; outputs in `tools/results/`

```
npm run build   # writes dist/index.html
npm test        # rules tests
node tools/arena.js '{"kind":"search"}' '{"kind":"v2"}' 2 60
```

House rules where the rulebook is silent: a leak can't leave an opponent's pipeline with no way to finish; you get a warning before doing that to yourself; pipes can't run into a cap card already on the table. The 110-card deck mix is an estimate (see `DECK_SPEC` in `src/engine.js`).
