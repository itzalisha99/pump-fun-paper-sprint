// Dip Rider / Breakout Rider — Pump.fun Paper Sprint bot.
//
// Two entry modes, one exit discipline. The mode is chosen by the params
// (the default below is whatever the offline sweep found best on the dev
// window, and the sweep numbers are in the README).
//
//  - "dip": wait for a coin to retrace far below its early peak, then buy
//    only when fresh buy flow comes back into the dip. One full exit per
//    coin: take profit, stop loss, or a hard hold limit.
//  - "breakout": wait for a coin to pull back, then buy the moment it prints
//    a NEW high above its old peak — a higher high after a pullback, with
//    buy flow behind it. Exits ride a trailing stop armed after +15%.
//
// Small stakes, many coins, never more than five open at once. Everything
// here is a pure function of the batches the harness feeds in: no clock, no
// environment, no randomness, so the two graded executions produce
// byte-identical action logs.

import type {
  Bot,
  BotState,
  Batch,
  BuyInput,
  SellInput,
} from './vendor/makefun-bot.ts';

export interface Params {
  /** Which entry trigger to use. */
  entryMode: 'dip' | 'breakout';
  /** Stake per coin, lamports. */
  stakeLamports: bigint;
  /** Youngest age (slots since creation) a coin may be bought at. */
  minAgeSlots: number;
  /** Oldest age (slots since creation) a coin may be bought at. */
  maxAgeSlots: number;
  /** Dip mode: buy only after price retraced this far below its early peak. */
  retrace: number;
  /** Breakout mode: the pullback that must have happened first (0..1). */
  minPullback: number;
  /** Breakout mode: price must clear the old peak by this much (0..1). */
  breakoutLift: number;
  /** Recent trades looked at for the flow check. */
  flowWindow: number;
  /** Minimum share of recent flow SOL that must be buys (0..1). */
  minBuyShare: number;
  /** Minimum number of recent buys in the flow window. */
  minRecentBuys: number;
  /** Minimum real SOL reserves (lamports) before a coin is buyable. */
  minRealReservesLamports: bigint;
  /** Sell everything once price is this far above entry (0..1). */
  takeProfit: number;
  /** Sell everything once price is this far below entry (0..1). */
  stopLoss: number;
  /** Breakout mode: sell once price falls this far below its peak since entry. */
  trailDrop: number;
  /** Breakout mode: the trailing stop only arms after this gain (0..1). */
  trailArm: number;
  /** Sell everything once a position is older than this (slots). */
  maxHoldSlots: number;
  /** Slippage cap on buys, bps. */
  buySlippageBps: number;
  /** Slippage cap on sells, bps (wide: an exit must execute). */
  sellSlippageBps: number;
}

export const DEFAULT_PARAMS: Params = {
  entryMode: 'breakout',
  stakeLamports: 200_000_000n, // 0.20 SOL — chosen by the offline sweep: same 18 trades as the 0.10 stake, PnL scales ~linearly, drawdown still 1.4%
  minAgeSlots: 20,
  maxAgeSlots: 3600,
  retrace: 0.3,
  minPullback: 0.25, // sweep: 0.25 beats 0.20 (-0.072) and 0.28 (-0.019)
  breakoutLift: 0.07, // sweep: 0.07 beats 0.06 (-0.062) and 0.08 (+0.026)
  flowWindow: 8,
  minBuyShare: 0.5,
  minRecentBuys: 2,
  minRealReservesLamports: 2_000_000_000n, // 2 SOL
  takeProfit: 1.0,
  stopLoss: 0.15,
  trailDrop: 0.2,
  trailArm: 0.15,
  maxHoldSlots: 1800,
  buySlippageBps: 3000,
  sellSlippageBps: 10000,
};

interface CoinTape {
  createdSlot: number;
  peakPrice: number;
  /** Peak as it stood when this batch started (before this batch's trades). */
  prevPeakPrice: number;
  /** Deepest retrace from peak seen so far (0..1). */
  maxRetrace: number;
  /** Recent trades, newest last: [isBuy, solLamports]. */
  recent: Array<[boolean, bigint]>;
  bought: boolean;
}

interface Entry {
  price: number;
  slot: number;
  /** Highest price seen since entry (for the trailing stop). */
  peak: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<string, CoinTape>();
  const entries = new Map<string, Entry>();

  return {
    onBatch(state: BotState, batch: Batch) {
      // True cost basis: when a buy fill lands, record what it actually
      // cost (SOL per token) and when it landed.
      for (const f of batch.fills) {
        if (f.side === 'buy' && f.status === 'filled') {
          const tokens = BigInt(f.token_amount);
          const paid = BigInt(f.quote_lamports);
          if (tokens > 0n && paid > 0n) {
            const p = Number(paid) / Number(tokens);
            entries.set(f.mint, { price: p, slot: f.slot, peak: p });
          }
        }
      }

      // Snapshot each tape's peak before this batch's trades move it.
      for (const tape of tapes.values()) tape.prevPeakPrice = tape.peakPrice;

      // Fold this batch's events into the per-coin tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          tapes.set(e.mint, {
            createdSlot: e.slot,
            peakPrice: p,
            prevPeakPrice: p,
            maxRetrace: 0,
            recent: [],
            bought: false,
          });
        } else if (e.event === 'TradeEvent') {
          const tape = tapes.get(e.mint);
          if (tape === undefined) continue;
          tape.recent.push([e.is_buy, BigInt(e.sol_amount)]);
          if (tape.recent.length > params.flowWindow) tape.recent.shift();
          const p = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          if (p > tape.peakPrice) tape.peakPrice = p;
          const retr = tape.peakPrice > 0 ? 1 - p / tape.peakPrice : 0;
          if (retr > tape.maxRetrace) tape.maxRetrace = retr;
        } else if (e.event === 'CompleteEvent') {
          tapes.delete(e.mint);
          entries.delete(e.mint);
        }
      }

      const orders: Array<BuyInput | SellInput> = [];
      const { caps } = state.hello;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slots = caps.max_open_positions - state.committedPositionCount();

      // --- exits first: a slot freed here can be reused by a buy below ---
      for (const [mint, holding] of state.positions) {
        const entry = entries.get(mint);
        const curve = state.curves.get(mint);
        if (entry === undefined || curve === undefined || curve.complete) continue;
        const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (p <= 0 || entry.price <= 0) continue;
        if (p > entry.peak) entry.peak = p;
        const ret = p / entry.price - 1;
        const age = batch.slot - entry.slot;
        let exit = ret >= params.takeProfit || ret <= -params.stopLoss || age > params.maxHoldSlots;
        if (!exit && params.entryMode === 'breakout') {
          const peakRet = entry.peak / entry.price - 1;
          if (peakRet >= params.trailArm && p <= entry.peak * (1 - params.trailDrop)) exit = true;
        }
        if (exit) {
          orders.push({
            side: 'sell',
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: params.sellSlippageBps,
          });
          entries.delete(mint);
        }
      }

      // --- entries ---
      for (const [mint, tape] of tapes) {
        if (orders.length >= caps.max_orders_per_batch) break;
        if (slots <= 0) break;
        if (tape.bought) continue;
        if (state.positions.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (curve.real_quote_reserves < params.minRealReservesLamports) continue;
        const age = batch.slot - tape.createdSlot;
        if (age < params.minAgeSlots || age > params.maxAgeSlots) continue;
        const p = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (p <= 0 || tape.peakPrice <= 0) continue;
        if (params.entryMode === 'dip') {
          if (p > tape.peakPrice * (1 - params.retrace)) continue;
        } else {
          // Breakout: a real pullback happened first, and price just
          // printed a new high above the peak it pulled back from.
          if (tape.maxRetrace < params.minPullback) continue;
          if (p < tape.prevPeakPrice * (1 + params.breakoutLift)) continue;
        }
        // Flow check: recent tape must be mostly buys, with enough of them.
        let buySol = 0n;
        let totalSol = 0n;
        let buys = 0;
        for (const [isBuy, sol] of tape.recent) {
          totalSol += sol;
          if (isBuy) {
            buySol += sol;
            buys += 1;
          }
        }
        if (buys < params.minRecentBuys) continue;
        if (totalSol === 0n) continue;
        if (Number(buySol) / Number(totalSol) < params.minBuyShare) continue;
        const cap = state.maxBuyLamports(mint);
        let amount = params.stakeLamports < cap ? params.stakeLamports : cap;
        if (amount > free - tx) amount = free - tx;
        if (amount < 20_000_000n) continue; // keep every round trip >= 0.02 SOL
        orders.push({
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: params.buySlippageBps,
        });
        tape.bought = true;
        entries.set(mint, { price: p, slot: batch.slot, peak: p });
        free -= amount + tx;
        slots -= 1;
      }

      // Drop entries for positions the harness already closed — but keep
      // entries for mints whose buy is still in flight (the fill lands two
      // slots after the decision, and deleting the entry meanwhile would
      // leave the position with no exit rules at all).
      const pendingBuys = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
      }
      for (const mint of [...entries.keys()]) {
        if (!state.positions.has(mint) && !pendingBuys.has(mint)) {
          entries.delete(mint);
        }
      }

      return orders;
    },
  };
}
