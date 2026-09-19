/**
 * Nine ways an OEE number comes out wrong while looking completely reasonable.
 *
 * Every expected value here is exact arithmetic on round inputs — you can check
 * each one on paper, which is the point: an OEE that cannot be recomputed by
 * hand cannot be defended in an audit.
 *
 * Deterministic, offline, free: no LLM, no network, no fixtures on disk.
 */
import { computeTimes, computeRates, rollup, validate } from "../skills/oee-ops/scripts/oee.mjs";

const H = 3_600_000;
const r4 = (x) => (x === null ? null : Math.round(x * 10000) / 10000);

/** Three machines with deliberately different scheduled times. */
const MACHINES = [
    { id: "A", TR: 100 * H, TU: 90 * H }, // 90%  — ran all week
    { id: "B", TR: 100 * H, TU: 80 * H }, // 80%  — ran all week
    { id: "C", TR: 1 * H, TU: 1 * H },    // 100% — ran for one hour
];

export const CASES = [
    {
        name: "averaging-rates-across-machines",
        trap: "The mean of per-machine TRS weights a machine that ran one hour the same as one that ran all week.",
        // (90 + 80 + 1) / (100 + 100 + 1) = 171/201
        expect: { plantTRS: r4(171 / 201) },
        naive() {
            const each = MACHINES.map((m) => m.TU / m.TR);
            return { plantTRS: r4(each.reduce((a, b) => a + b, 0) / each.length) };
        },
        skilled() {
            const { rates } = rollup(MACHINES.map((m) => ({ TR: m.TR, TU: m.TU })));
            return { plantTRS: r4(rates.TRS) };
        },
    },

    {
        name: "averaging-rates-across-days",
        trap: "A monthly TRS is not the average of the daily ones — the short days count as much as the full ones.",
        // (16 + 2) / (20 + 4) = 18/24 = 0.75
        expect: { monthTRS: 0.75 },
        naive() {
            const days = [
                { TR: 20 * H, TU: 16 * H }, // 80%
                { TR: 4 * H, TU: 2 * H },   // 50%
            ];
            const each = days.map((d) => d.TU / d.TR);
            return { monthTRS: r4(each.reduce((a, b) => a + b, 0) / each.length) };
        },
        skilled() {
            const days = [
                { TR: 20 * H, TU: 16 * H },
                { TR: 4 * H, TU: 2 * H },
            ];
            return { monthTRS: r4(rollup(days).rates.TRS) };
        },
    },

    {
        name: "overlapping-stops-double-counted",
        trap: "The operator logs a breakdown and the PLC logs the same breakdown. Summing durations deducts it twice.",
        // 10h required, one real 2h stop logged twice → TF must be 8h, not 6h.
        expect: { TFhours: 8 },
        setup() {
            return {
                from: 0,
                to: 10 * H,
                stops: [
                    { start: 3 * H, end: 5 * H, category: "arret_propre", reason: "breakdown" },
                    { start: 3.5 * H, end: 5 * H, category: "arret_propre", reason: "breakdown" },
                ],
            };
        },
        naive() {
            const { from, to, stops } = this.setup();
            const summed = stops.reduce((a, s) => a + (s.end - s.start), 0);
            return { TFhours: ((to - from - summed) / H) };
        },
        skilled() {
            const { from, to, stops } = this.setup();
            return { TFhours: computeTimes({ from, to, stops }).TF / H };
        },
    },

    {
        name: "stop-crossing-the-window",
        trap: "A stop that began before the shift is counted in full, deducting time the window never contained.",
        // Window 08:00-16:00. Stop 06:00-09:00 → only 1h is inside.
        expect: { TFhours: 7 },
        setup() {
            return {
                from: 8 * H,
                to: 16 * H,
                stops: [{ start: 6 * H, end: 9 * H, category: "arret_propre", reason: "breakdown" }],
            };
        },
        naive() {
            const { from, to, stops } = this.setup();
            const summed = stops.reduce((a, s) => a + (s.end - s.start), 0);
            return { TFhours: (to - from - summed) / H };
        },
        skilled() {
            const { from, to, stops } = this.setup();
            return { TFhours: computeTimes({ from, to, stops }).TF / H };
        },
    },

    {
        name: "planned-stop-inside-non-engagement",
        trap: "A maintenance window logged across a weekend deducts once from TO and again from TR, shrinking required time twice.",
        // 24h day, 12h non-engagement (00-12), a 4h planned stop 10:00-14:00.
        // Only the 12:00-14:00 half is inside the opening time → TR = 12 - 2 = 10h.
        expect: { TOhours: 12, TRhours: 10 },
        setup() {
            return {
                from: 0,
                to: 24 * H,
                stops: [
                    { start: 0, end: 12 * H, category: "non_engagement" },
                    { start: 10 * H, end: 14 * H, category: "arret_planifie", reason: "maintenance" },
                ],
            };
        },
        naive() {
            const { from, to, stops } = this.setup();
            const sum = (c) => stops.filter((s) => s.category === c).reduce((a, s) => a + (s.end - s.start), 0);
            const TO = to - from - sum("non_engagement");
            const TR = TO - sum("arret_planifie");
            return { TOhours: TO / H, TRhours: TR / H };
        },
        skilled() {
            const { from, to, stops } = this.setup();
            const t = computeTimes({ from, to, stops });
            return { TOhours: t.TO / H, TRhours: t.TR / H };
        },
    },

    {
        name: "circular-performance-rate",
        trap: "Deriving TN from TF x TP is circular — TP is defined as TN / TF, so it always returns 100% and hides every speed loss.",
        // 10h running, 600 units at a 50s nominal cycle → TN = 8.333h, TP = 83.3%.
        expect: { TPpercent: r4((600 * 50000) / (10 * H)) },
        naive() {
            // "TP is 100% unless someone tells me otherwise", then TN = TF x TP.
            const TF = 10 * H;
            const TP = 1;
            const TN = TF * TP;
            return { TPpercent: r4(TN / TF) };
        },
        skilled() {
            const t = computeTimes({
                from: 0,
                to: 10 * H,
                production: [{ goodUnits: 600, badUnits: 0, nominalCycleMs: 50000 }],
            });
            return { TPpercent: r4(computeRates(t).TP) };
        },
    },

    {
        name: "stale-nominal-cycle-gives-impossible-rate",
        trap: "Engineering speeds the line up and nobody updates the reference cadence. The rate goes over 100% and the dashboard shows it proudly.",
        // 8h required, 800 units at a 45s nominal cycle → TN = 10h > TF = 8h.
        // TN = 800 x 45s = 10h against a TF of 8h, so TP, TRS, TRG and TRE all
        // exceed 1 — but TQ is exactly 1 (every unit was good) and is correctly
        // NOT flagged. This expectation was wrong when first written by hand;
        // the benchmark caught it, which is the argument for having one.
        expect: {
            flagged: ["TN_EXCEEDS_TF", "TP_ABOVE_100", "TRS_ABOVE_100", "TRG_ABOVE_100", "TRE_ABOVE_100"],
        },
        setup() {
            return computeTimes({
                from: 0,
                to: 8 * H,
                production: [{ goodUnits: 800, badUnits: 0, nominalCycleMs: 45000 }],
            });
        },
        naive() {
            const t = this.setup();
            const rates = computeRates(t);
            // Report it and move on.
            return { flagged: rates.TRS > 1 ? [] : [] };
        },
        skilled() {
            const t = this.setup();
            return { flagged: validate(t).map((i) => i.code) };
        },
    },

    {
        name: "trs-reported-with-the-wrong-denominator",
        trap: "TRG divided by opening time is a smaller, friendlier number than TRS. Calling it OEE is the most common way an OEE gets inflated in the other direction — or deflated in a review.",
        // TO = 16h, TR = 12h, TU = 9h → TRS = 75%, TRG = 56.25%.
        expect: { TRS: 0.75, TRG: 0.5625 },
        setup() {
            return {
                from: 0,
                to: 24 * H,
                stops: [
                    { start: 0, end: 8 * H, category: "non_engagement" },
                    { start: 8 * H, end: 12 * H, category: "arret_planifie" },
                ],
                production: [{ goodUnits: 720, badUnits: 0, nominalCycleMs: 45000 }], // TU = 9h
            };
        },
        naive() {
            const s = this.setup();
            const t = computeTimes(s);
            // "OEE = good time / opening time" — a plausible sentence, the wrong rate.
            return { TRS: r4(t.TU / t.TO), TRG: r4(t.TU / t.TO) };
        },
        skilled() {
            const rates = computeRates(computeTimes(this.setup()));
            return { TRS: r4(rates.TRS), TRG: r4(rates.TRG) };
        },
    },

    {
        name: "unscheduled-machine-drags-the-plant",
        trap: "A machine that was never scheduled has no TRS. Scoring it 0% and averaging it in punishes the plant for a machine nobody planned to run.",
        // A: 90/100. B: not scheduled at all. Plant TRS must be 90%.
        expect: { plantTRS: 0.9, machineB: null },
        naive() {
            const machines = [
                { TR: 100 * H, TU: 90 * H },
                { TR: 0, TU: 0 },
            ];
            const each = machines.map((m) => (m.TR > 0 ? m.TU / m.TR : 0)); // 0, not null
            return {
                plantTRS: r4(each.reduce((a, b) => a + b, 0) / each.length),
                machineB: each[1],
            };
        },
        skilled() {
            const machines = [
                { TR: 100 * H, TU: 90 * H },
                { TR: 0, TU: 0 },
            ];
            return {
                plantTRS: r4(rollup(machines).rates.TRS),
                machineB: computeRates({ TT: 0, TO: 0, TR: 0, TF: 0, TN: 0, TU: 0 }).TRS,
            };
        },
    },
];
