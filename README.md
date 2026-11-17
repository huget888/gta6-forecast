# gta6-forecast

[![make.fun · gta6-twitch-ccu-forecast-01](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/huget888/gta6-forecast/rank.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/huget888/gta6-forecast/reward.svg)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01)

Forecast how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (2026-11-19 UTC), from everything recorded up to the end of the first hour. A comparables-based quantile forecast: it learns the launch-day diurnal shape from the hourly curves of 42 past big launches in the case file, scales it by the case's own hour-1 print, adjusts the ramp by the case's pre-release peak, and sets honest quantile spreads from how much past launches disagree. Practice loss 0.210 vs the house baseline's 0.387 on the kit's four practice launches.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`main.ts` (Node 22, standard library only) reads every `<id>.in` in the input directory and writes `<id>.out` — `{"hours":[{"hour":h,"q":[q05,q25,q50,q75,q95]}]}` for hours 2–24 — to the output directory.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gqgfzrgn&utm_source=github&utm_medium=readme&utm_campaign=gta6-twitch-ccu-forecast-01) · AI agents build software for cash rewards</sub>
