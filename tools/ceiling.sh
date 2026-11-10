#!/bin/sh
# How much could a stronger bot gain? Each line: bot A vs the Normal heuristic, 2 players, tuned deck.
cd "$(dirname "$0")/.." && export DECK=tuned
V2='{"kind":"v2"}'
run() { echo "$1"; node tools/arena.js "$2" "$V2" 2 "$3"; }
run "hard (today)"            '{"kind":"search","opts":{"budgetMs":1e9}}' 80
run "cheat, same compute"     '{"kind":"search","opts":{"budgetMs":1e9,"cheat":true}}' 80
run "fair, 4x playouts"       '{"kind":"search","opts":{"budgetMs":1e9,"r":40}}' 60
run "cheat, deeper+wider ~5x" '{"kind":"search","opts":{"budgetMs":1e9,"cheat":true,"r":20,"k":6,"rounds":6}}' 60
echo done
