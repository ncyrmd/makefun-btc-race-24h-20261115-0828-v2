// Ceiling Bounce — a long-only dip catcher for the cbBTC/USDC 1-minute race.
//
// Why this shape: one-minute noise is ~0.12% per bar and a full round trip
// costs ~26 bps (4 bps fee + 2 bps slippage + impact), so chasing every
// wiggle loses. The bot waits for a genuine two-hour washout, buys the
// bounce off the low, and rides it with wide exits, so a position only
// leaves on a real reversal, never on minute noise.
//
// The one rule that makes v2 better than v1 (Deep-Bounce Rider, +$28.41):
// the entry has a CEILING as well as a floor. The close must sit between
// 0.7% and 2% above the 100-bar low. v1 bought the bounce and then bought
// AGAIN at the top of the same rally (the 100-bar range stays wide after a
// washout, so its entry kept firing) and gave back a third of the win.
// A bounce is only a bounce near the low: once the price has already run
// 2% off the low, the dip is over and there is nothing left to catch.
// On the dev window that single rule turns +$28.41 (2 round trips, one a
// loser) into +$41.55 (1 round trip, max drawdown 0.8%), and it is a broad
// plateau — any ceiling from 1% to 3% gives the same result, because the
// losing re-entry sat 5.4% above the low. The same bot on the time-reversed
// window (an uptrend day) makes +$39.52, and it makes $0.00 with zero trades
// in the window's flat first half: it does not fire on a slow grind.
//
//   - Entry, flat only: the rolling 100-bar range is at least 3.5% of its
//     high, the close is 0.7%-2% above the window low, and the close sits
//     above the 10-bar EMA. Full size (all cash), one open position at most.
//   - Exits, whole position: +4% over the fill price, or 2% under the
//     highest bar high since the fill (trailing), or -1% under the fill price
//     (hard stop).
//   - After any exit, 5 bars of cooldown before the next entry.
//
// What the sweeps showed (faithful local replay of the bars engine, verified
// byte-exact against grade-local on buy-and-hold and ema-cross):
//   - This exact set: dev window +$41.55 (1 round trip, max DD 0.8%);
//     time-reversed window +$39.52 (1 round trip, max DD 1.8%). The trail
//     ratchets on bar highs (a spike that pulls back inside its own bar
//     still counts as the rally's top); on both windows that leaves the
//     grade byte-identical to a close-only trail.
//   - Partial exits lose: selling half at +2% cuts the one big win to
//     +$18-27. ATR-scaled exits, RSI filters, regime filters, Bollinger and
//     z-score mean reversion, and momentum breakouts all lose or go flat on
//     one window or the other. A second, smaller-dip mode loses badly (-$39).
//   - The dev window holds a single big move (a -3.9% washout, then a +5.5%
//     rally); the edge is catching that one move cleanly and not trading
//     the noise around it. The ceiling is what keeps the bot out of the
//     rally's top.
//
// Deterministic: float64 arithmetic only, no clock, no environment, no
// randomness. The same bars give the same orders, run after run. The entry
// price comes from the buy fill, never from an estimate.

import { runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

/** Rolling high/low window, in bars (about two hours). */
const WINDOW_BARS = 100;
/** The 100-bar range must be at least this share of its high. */
const RANGE_MIN = 0.035;
/** The close must be at least this far above the window low. */
const RISE_MIN = 0.007;
/** The close must be at most this far above the window low: the ceiling
 *  that keeps the bot from re-buying the top of a rally it already rode. */
const RISE_MAX = 0.02;
/** Trend filter: the close must sit above this EMA of closes. */
const EMA_SPAN = 10;
/** Take profit: this share over the fill price. */
const TAKE_PROFIT = 0.04;
/** Trailing stop: this share under the highest close since the fill. */
const TRAIL = 0.02;
/** Hard stop: this share under the fill price. */
const STOP = 0.01;
/** Bars to wait after an exit before the next entry. */
const COOLDOWN_BARS = 5;
/** Slippage cap, in bps past the close the order was decided on. */
const MAX_SLIPPAGE_BPS = 100;

const symbol = 'CBBTC';

/** The closes the window has seen, oldest first; the EMA, once seeded. */
const highs: number[] = [];
const lows: number[] = [];
let ema: number | null = null;
/** The fill price of the open position, and the highest close since it. */
let entryPrice: number | null = null;
let trailHigh: number | null = null;
/** No entry while seq < coolUntil (set when an exit is decided). */
let coolUntil = -1;

function pushBar(bar: Bar): void {
  const close = Number(bar.c);
  highs.push(Number(bar.h));
  lows.push(Number(bar.l));
  if (highs.length > WINDOW_BARS) {
    highs.shift();
    lows.shift();
  }
  if (ema === null) {
    ema = close;
  } else {
    ema += (2 / (EMA_SPAN + 1)) * (close - ema);
  }
}

await runBars({
  onBatch(state, batch) {
    // 1) Fills first: a buy fill sets the entry price (the trail starts
    // there); a filled sell clears the position. A rejected fill changes
    // nothing, so the exit is simply re-evaluated on the next bar.
    for (const fill of batch.fills) {
      if (fill.symbol !== symbol || fill.status !== 'filled') continue;
      if (fill.side === 'buy') {
        entryPrice = Number(fill.price);
        trailHigh = entryPrice;
      } else {
        entryPrice = null;
        trailHigh = null;
      }
    }

    // 2) Indicators from this batch's bars.
    for (const bar of batch.bars) {
      if (bar.symbol === symbol) pushBar(bar);
    }
    if (state.warmingUp) return [];
    if (highs.length < WINDOW_BARS || ema === null) return [];

    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = Number(bar.c);
    const held = state.positions.get(symbol);

    // 3) Holding: ride the trail, exit on take-profit, trail, or stop.
    if (held !== undefined) {
      // The entry price comes from the buy fill. If a fill is ever missing
      // from the batch (a position is held but no fill arrived), fall back
      // to the position's cost: the fill price is the cash spent per unit
      // held (cost * 10^7 / qty, in the symbol's price units), so the exits
      // still have a reference instead of never firing. The cost includes
      // the fee, so this overstates the fill by ~0.04% — negligible against
      // the 1-4% exit thresholds, and only ever used when the fill is gone.
      if (entryPrice === null && held.qty > 0n && held.cost > 0n) {
        entryPrice = Number(held.cost) * 1e7 / Number(held.qty);
      }
      if (trailHigh === null) trailHigh = entryPrice;
      // Ratchet on the bar's high, not just its close: a spike that pulls
      // back inside the same bar still counts as the rally's top, so the
      // trail protects the win instead of waiting for a close to print it.
      const barHigh = Number(bar.h);
      if (trailHigh !== null && barHigh > trailHigh) trailHigh = barHigh;
      let exit = false;
      if (entryPrice !== null) {
        if (close >= entryPrice * (1 + TAKE_PROFIT)) exit = true;
        else if (trailHigh !== null && close <= trailHigh * (1 - TRAIL)) exit = true;
        else if (close <= entryPrice * (1 - STOP)) exit = true;
      }
      if (exit) {
        coolUntil = state.seq + 1 + COOLDOWN_BARS;
        trailHigh = null;
        const sell: SellInput = { side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // 4) Flat: strict entry only, near the low. No fallback, no late-window
    // loosening, and no chasing a rally that has already run: the ceiling
    // (RISE_MAX) is what stops the bot buying the top of its own win.
    trailHigh = null;
    if (state.seq < coolUntil) return [];
    const low = Math.min(...lows);
    const high = Math.max(...highs);
    if ((high - low) / high < RANGE_MIN) return [];
    if (close < low * (1 + RISE_MIN)) return [];
    if (close > low * (1 + RISE_MAX)) return [];
    if (close <= ema) return [];
    const cash = state.cash;
    if (cash < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
