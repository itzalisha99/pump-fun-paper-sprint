# Breakout Rider — Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/itzalisha99/pump-fun-paper-sprint/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/itzalisha99/pump-fun-paper-sprint/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun. It trades 10 SOL of paper money on a 6-hour replay of pump.fun bonding-curve activity. Highest net PnL wins the whole $2 pot.

## Strategy: pullback, then breakout

Most pump.fun coins spike and die, and chasing every up-move loses (tested: buying each 5% up-move lost −0.63 SOL on the dev window). Buying the dip loses too (coins that retraced 40% mostly kept dying: −0.19 SOL). The edge is in the coins that survive a dump and come back:

1. **Pullback first** — a coin must have retraced at least 25% from its early peak. Coins that never pulled back are untested; coins that pulled back less are still falling.
2. **Breakout second** — buy only when the price prints a new high 7% above the old peak, with recent flow at least half buys. The breakout proves buyers are back, not just that the fall paused.
3. **Ride it** — a 20% trailing stop armed at +15%, a −15% hard stop, a +100% take-profit, and an 1800-slot hold limit. No scaled exits: one position, one exit, decided by the tape.
4. **Small stakes, many coins** — 0.20 SOL per coin (capped at 1% of the coin's real reserves), at most 5 open at once, at least 0.02 SOL per round trip so every trade counts toward the 20-coin guardrail.

The bot is a pure function of the batches it is fed: no clock, no randomness, no I/O — the two graded executions produce byte-identical action logs.

## Backtest (honest numbers)

Offline sim on the kit's 24-hour dev window (full 3-part dataset, 1,222 coins in the sampled universe; 87 peaked at 2x or more, 19 at 10x or more):

- **Chosen params, kit's own sim: +0.781 SOL, 74 trips, 20 wins, 5.0% max drawdown**, 0 rejected orders, 1 failed tx. Still +0.293 SOL at 2x fees.
- **Kit grade-local (the real grader, process driver): +0.309 SOL net PnL**, 73 round trips, 24.7% win rate, 4.3% max drawdown, 0 rejected, 2 failed tx. L1 regrade reproduced byte for byte. The difference from the sim is the harness seed's failed-tx draws — the same strategy, different random failures.
- Honest concentration warning from grade-local: 3 coins made 37% of the gains; without them net PnL is −0.48 SOL. 90% interval −0.74 .. +1.47 SOL. Most of a pump bot's PnL comes from a few coins — the final 6-hour window is unseen, and a different handful of runners will decide it. The bot's job is to be in the coins that run and to cut the ones that don't.
- Neighbours on the full window (all positive, a real plateau, not one lucky coin): trailing stop 0.30 → +0.147; 0.35 → +0.191; 0.40 → +0.188; lift 0.10 + pullback 0.20 → +0.487; lift 0.12 → +0.380; TP 0.75 → +0.781; TP 1.00 → +0.808 (higher drawdown).
- Rejected ideas (all measured on the same full window): dip-buy after a 40% retrace (−0.60 SOL, 114 trips), buying every 5% up-move (−0.63 SOL, 82 trips), buying every new coin at 0.05 SOL and holding (−0.13 SOL), tight 20% trailing stop (−0.30 SOL — it chokes the winners), tight −10% stop (−0.22 SOL — it sells the winners too early).
- Research note: the kit's pilot sim tool only reads the first of 3 dataset parts. An early sweep on that partial window picked different (worse) params; every number above comes from the full 3-part window.

## Stress test

`grade-local --stress` (20 rebuilt copies of the dev window, blocks of trades reshuffled):

- **Mean −0.745 SOL, median −0.765 SOL, only 2 of 20 copies positive** (best +0.62, worst −1.47). The reshuffled copies mostly lose.
- Honest reading: the stress copies scramble the tape sequences the breakout pattern depends on, so they understate how the bot does on real sequential data — the final window is real data, not a reshuffle, and on the real dev window the bot made +0.309 SOL. But the stress result also proves the edge is thin and sequence-dependent: most of the profit comes from a few coins at the right moment. A spray variant (buy every coin early, same exits) was tested as a more robust alternative and was far worse on the real window (−2.00 SOL, 336 trips, 31 wins), so the breakout bot stands as the best entry found. This is a free $2 winner-takes-all bounty; the honest expectation is a small positive edge on real data with a wide spread.

## Files

- `main.ts` — entry point; hands the strategy to the harness shim.
- `strategy.ts` — the strategy (params, tape tracking, entries, exits).
- `vendor/makefun-bot.ts` — the kit's bot shim, copied verbatim as the SDK instructs.
