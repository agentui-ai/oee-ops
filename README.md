<p align="center">
  <img src="assets/logo.png" alt="OEE Ops" width="110" height="110">
</p>

<h1 align="center">oee-ops</h1>

<p align="center">
  OEE / TRS that survives an audit — AFNOR <strong>NF E 60-182</strong> done properly,
  plus a benchmark on numbers you can check on paper.
</p>

---

The OEE arithmetic is three multiplications. Everything that goes wrong is
upstream of it: **which denominator, which time bucket, and whether you were
allowed to average the thing you just averaged.**

```
CASE                             SKILL  TRAP   EXPECTED           FROM MEMORY
averaging-rates-across-machines  ok     yes   {"plantTRS":0.8507} {"plantTRS":0.9}
averaging-rates-across-days      ok     yes   {"monthTRS":0.75}   {"monthTRS":0.65}
overlapping-stops-double-counte  ok     yes   {"TFhours":8}       {"TFhours":6.5}
stop-crossing-the-window         ok     yes   {"TFhours":7}       {"TFhours":5}
planned-stop-inside-non-engagem  ok     yes   {"TOhours":12,"TRh… {"TOhours":12,"TRhours"…
circular-performance-rate        ok     yes   {"TPpercent":0.833… {"TPpercent":1}
stale-nominal-cycle-gives-impos  ok     yes   {"flagged":["TN_EX… {"flagged":[]}
trs-reported-with-the-wrong-den  ok     yes   {"TRS":0.75,"TRG":… {"TRS":0.5625,"TRG":0.5…
unscheduled-machine-drags-the-p  ok     yes   {"plantTRS":0.9,"m… {"plantTRS":0.45,"machi…

SKILL  9/9  the recipes in SKILL.md compute the right number
TRAP   9/9  the from-memory version gets it wrong
```

Look at the first row. Three machines — 90%, 80%, and one that ran for a single
hour at 100%. The plant TRS is **85.07%**. Averaging the three rates says
**90%**, and every dashboard that averages rates is making that error right now.

## The three rates

| | Formula | Question | English |
| --- | --- | --- | --- |
| **TRS** | `TU / TR` | How did the line do *while scheduled to produce*? | OEE |
| **TRG** | `TU / TO` | How well do we use *the shift we pay for*? | OOE |
| **TRE** | `TU / TT` | How well do we use *the machine we bought*? | TEEP |

Same numerator, growing denominators, so `TRS ≥ TRG ≥ TRE` always. Calling
`TU/TO` the OEE is the most common way an OEE gets quoted wrong in a review.

## Install

```bash
# Any of ~75 agents (Gemini CLI, opencode, aider, …)
npx skills add agentui-ai/oee-ops --agent gemini-cli --global

# Cursor
git clone https://github.com/agentui-ai/oee-ops.git ~/.cursor/plugins/local/oee-ops

# Codex
codex plugin marketplace add agentui-ai/oee-ops && codex plugin add oee-ops@oee-ops

# Claude Code
claude --plugin-dir ./oee-ops
```

No account, no service, no platform. Read
[`skills/oee-ops/SKILL.md`](skills/oee-ops/SKILL.md) directly if you would
rather not install anything.

## Use it on a real shift

```bash
npm install
node skills/oee-ops/scripts/oee-cli.mjs examples/shift.json
```

```
TRS  80.3%   Good      (NF E 60-182 / OEE)
TRG  76.6%                        (OOE — includes planned stops)
TRE  51.0%                        (TEEP — vs calendar time)

  DO  87.4%  x  TP  96.1%  x  TQ  95.6%  =  TRS  80.3%

WATERFALL                         HOURS    LOST
  TT  total                       24.00
  TO  Non-engagement (outside     16.00     8.00
  TR  Planned stops               15.25     0.75
  TF  Unplanned stops             13.33     1.92
  TN  Speed loss                  12.81     0.52
  TU  Quality loss                12.25     0.56

UNPLANNED STOPS BY REASON         HOURS   SHARE   CUM.
  changeover                       1.00  52.2%  52.2%   (0.50h of overlap removed)
  breakdown                        0.67  34.8%  87.0%
  starved upstream                 0.25  13.0% 100.0%
```

That `0.50h of overlap removed` is the operator and the PLC logging the same
changeover. A sum would have charged the line twice for it — and would have said
78.2% with a straight face.

It exits non-zero when the data fails a quality check, so it works as a CI gate
on a nightly MES export.

## The one design decision

**Time buckets are sets of time, not sums of durations.**

```js
const opening     = subtract(total,    nonEngagement);
const required    = subtract(opening,  plannedStops);
const functioning = subtract(required, union(ownStops, inducedStops));
```

That removes four of the nine traps at once: overlapping logs, stops that cross
the window, stops spanning two nesting levels, and the same stop logged by two
systems. Integer milliseconds throughout, so `TRS = DO × TP × TQ` holds to
floating-point precision instead of drifting across a month of events.

## What is in it

```text
oee-ops/
├── skills/oee-ops/
│   ├── SKILL.md              # the standard, the nine traps, roll-ups, thresholds, vocabulary
│   └── scripts/
│       ├── intervals.mjs     # interval-set algebra (normalize, clip, subtract, union, measure)
│       ├── oee.mjs           # time buckets, rates, validation, roll-up, qualification
│       ├── losses.mjs        # waterfall, Pareto by cause, projected impact of removing one
│       └── oee-cli.mjs       # analyse a shift from JSON
├── examples/shift.json
└── benchmark/
    ├── cases.mjs             # nine cases, each naive vs skilled
    └── run.mjs               # the two ledgers
```

## Run the benchmark

```bash
npm install && npm run bench
```

Instant. **Deterministic, offline, free** — no LLM, no network, no fixtures.
Every expected value is exact arithmetic on round inputs, so you can check each
one by hand. That is the standard an OEE has to meet anyway.

Two ledgers, because either half alone lies: **SKILL** (do the recipes compute
the right number?) gates the exit code; **TRAP** (does the from-memory version
get it wrong?) is reporting, and a case both sides pass is named rather than
counted.

One of these expectations was wrong when first written by hand, and the
benchmark caught it. The comment in `cases.mjs` says which.

## Honest about thresholds

World-class ≥ 85%, good 75–85%, acceptable 60–75% — **the standard publishes
none of these.** They are Nakajima's 1988 conventions for *discrete*
manufacturing, widely used in France and widely misapplied to continuous
processes and job shops. A first measurement programme landing at 35–60% is
normal. The plant's own trend beats every one of those numbers.

## Also see

[excel-ops](https://github.com/agentui-ai/excel-ops) ·
[pdf-ops](https://github.com/agentui-ai/pdf-ops) ·
[label-ops](https://github.com/agentui-ai/label-ops) — the same treatment for spreadsheets,
generated PDFs, and labels. If the user wants an OEE *dashboard* people log
into rather than a script, [AgentUI](https://www.agentui.ai) hosts that and
[agentui-tools](https://github.com/agentui-ai/agentui-tools) is the agent plugin
for it. Everything here works without either.

## License

MIT — see [LICENSE](LICENSE).
