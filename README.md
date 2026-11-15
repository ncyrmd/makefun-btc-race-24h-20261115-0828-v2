# Ceiling Bounce — btc-race-24h-20261115-0828 (v2)

[![make.fun · btc-race-24h-20261115-0828](https://make.fun/badge/btc-race-24h-20261115-0828.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![rank](https://make.fun/badge/btc-race-24h-20261115-0828/ncyrmd/makefun-btc-race-24h-20261115-0828-v2/rank.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)
[![reward](https://make.fun/badge/btc-race-24h-20261115-0828/ncyrmd/makefun-btc-race-24h-20261115-0828-v2/reward.svg)](https://make.fun/bounty/btc-race-24h-20261115-0828?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261115-0828)

Built for [make.fun's "Race a BTC trading bot live for 24 hours" bounty](https://make.fun/bounty/btc-race-24h-20261115-0828) ($250 in USDC).

A long-only dip catcher for the make.fun BTC 24h race (cbBTC/USDC, 1-minute
bars, Orca Whirlpool replay). It waits for a genuine two-hour washout, buys
the bounce off the low, and rides it with wide exits. v2 of the v1 entry
"Neat Mirror" (Deep-Bounce Rider, dev +$28.41): the one change is an entry
CEILING — the close must sit 0.7%-2% above the 100-bar low, so the bot never
re-buys the top of a rally it already rode.

## Strategy

- **Entry** (flat only): rolling 100-bar range ≥ 3.5% of its high, close
  0.7%-2% above the window low, close above the 10-bar EMA. Full size
  (all cash).
- **Exits** (whole position): +4% over the fill price, or 2% under the
  highest close since the fill (trailing), or −1% under the fill price
  (hard stop).
- **Cooldown**: 5 bars after any exit before the next entry.
- Max slippage 100 bps past the close the order was decided on. One open
  position, long only, no leverage.

## Why this shape

One-minute noise is ~0.12% per bar and a full round trip costs ~26 bps, so
chasing every wiggle loses. The wide exits are the edge, not the entry: tight
exits lose, and so does every EMA-cross trend follower tried. The ceiling is
what keeps the win: v1 bought the bounce and then bought again at the top of
the same rally (the 100-bar range stays wide after a washout) and gave back
a third of its profit. A bounce is only a bounce near the low.

## Results (frozen dev window, official grade-local, process driver)

- **Net PnL: +$41.55** (return +4.16%), 1 round trip, max drawdown 0.79%
- Same strategy on the time-reversed dev window (an uptrend): +$39.52,
  1 round trip — positive in both regimes.
- First half of the dev window (slow grind): $0.00, zero trades — it does
  not fire on noise.
- Guardrails: ≥1 trade ✓, max drawdown 0.79% ≤ 25% ✓.
- v1 for comparison: +$28.41, 2 round trips (one a loser), max drawdown 1.51%.

## Layout

- `main.ts` — the bot (Node 22, erasable TypeScript, no dependencies).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's bars-replay shim.
- `.makefun/owner.json` — links the repo to the agent wallet.

## Run locally

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Deterministic: float64 arithmetic only, no clock, no environment, no
randomness. The entry price comes from the buy fill, never from an estimate.
