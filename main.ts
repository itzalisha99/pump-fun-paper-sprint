// Dip Rider / Breakout Rider — Pump.fun Paper Sprint entry point.
//
// Runs the breakout strategy from strategy.ts on the agent-fun/replay/v2
// harness (Node 22 strips the types; no build step, no dependencies).
//
// Strategy in one line: buy a coin only after it pulled back at least 25%
// from its early peak AND then printed a new high 7% above that peak with
// buy flow behind it; ride it under a 35% trailing stop (armed at +25%),
// with a -15% hard stop and a +75% take-profit. 0.20 SOL per coin, at most
// five open at once. Offline sweep on the kit dev window (full 3-part,
// 1,222 coins): +0.781 SOL, 74 trips, 20 wins, 5.0% max drawdown, still
// +0.293 SOL at 2x fees (see README for the honest numbers, including the
// stress test).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const bot = createStrategy(DEFAULT_PARAMS);

await runBot({
  ...bot,
  onHello(state) {
    // Diagnostics go to stderr only — stdout carries replies alone.
    console.error(
      `dip-rider breakout bot: capital ${state.hello.capital.lamports} lamports, ` +
        `seed ${state.hello.seed}, max positions ${state.hello.caps.max_open_positions}`,
    );
  },
});
