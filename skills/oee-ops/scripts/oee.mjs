/**
 * NF E 60-182 (AFNOR, 2002) — TRS / TRG / TRE, and the Nakajima OEE they map to.
 *
 * The arithmetic is trivial. Everything that goes wrong is upstream of it:
 * which denominator, which time bucket, and whether you were allowed to average
 * the thing you just averaged. This module does the bookkeeping so the
 * arithmetic stays clean: `TRS = DO x TP x TQ` holds to floating-point
 * precision (a ULP or two, checked at 1e-9 by `validate`), which is what makes
 * the decomposition auditable instead of approximately true.
 *
 * All times are milliseconds (integers). All rates are fractions, never
 * percentages — round for display, never for maths.
 */
import { clip, subtract, union, measure } from "./intervals.mjs";

/** Stop categories, and which nesting level each one deducts from. */
export const STOP_CATEGORIES = {
    non_engagement: "TT_TO", // outside the shift: weekends, closure, night gaps
    arret_planifie: "TO_TR", // planned: maintenance, breaks, meetings, no load
    arret_propre: "TR_TF",   // own unplanned: breakdown, changeover, setup, micro-stops
    arret_induit: "TR_TF",   // induced unplanned: starvation, blocking, upstream fault
};

/**
 * The six nested time buckets, computed as SETS of time rather than as sums.
 *
 * @param {object} input
 * @param {number} input.from                 window start (epoch ms)
 * @param {number} input.to                   window end (epoch ms)
 * @param {{start:number,end:number,category:string}[]} [input.stops]
 * @param {{goodUnits:number,badUnits?:number,nominalCycleMs:number}[]} [input.production]
 * @returns {{TT:number,TO:number,TR:number,TF:number,TN:number,TU:number,units:{good:number,bad:number,total:number}}}
 */
export function computeTimes({ from, to, stops = [], production = [] }) {
    if (!(to > from)) throw new Error(`Window is empty or inverted: from=${from} to=${to}`);
    for (const s of stops) {
        if (!(s.category in STOP_CATEGORIES)) {
            throw new Error(
                `Unknown stop category ${JSON.stringify(s.category)}. ` +
                    `Expected one of: ${Object.keys(STOP_CATEGORIES).join(", ")}.`
            );
        }
    }

    const of = (cat) => clip(stops.filter((s) => s.category === cat), from, to);

    // Each bucket is the one above it minus the stops that apply at that level,
    // so a stop crossing a boundary or overlapping another cannot deduct twice.
    const total = [{ start: from, end: to }];
    const opening = subtract(total, of("non_engagement"));
    const required = subtract(opening, of("arret_planifie"));
    const functioning = subtract(required, union(of("arret_propre"), of("arret_induit")));

    // TN and TU come from PRODUCTION, never from TF.
    // Deriving TN = TF x TP is circular: TP is defined as TN / TF.
    let good = 0;
    let bad = 0;
    let TN = 0;
    let TU = 0;
    for (const p of production) {
        const g = p.goodUnits ?? 0;
        const b = p.badUnits ?? 0;
        const cycle = p.nominalCycleMs;
        if (!(cycle > 0)) {
            throw new Error(
                "Every production record needs a positive nominalCycleMs. " +
                    "Store it per record, not in a config field — engineering changes the " +
                    "reference cadence and old data stops being comparable."
            );
        }
        good += g;
        bad += b;
        TN += (g + b) * cycle;
        TU += g * cycle;
    }

    return {
        TT: measure(total),
        TO: measure(opening),
        TR: measure(required),
        TF: measure(functioning),
        TN,
        TU,
        units: { good, bad, total: good + bad },
    };
}

/**
 * The three rates and the sub-rates they factor into.
 *
 * A zero denominator yields `null`, not 0. A line that never ran has no
 * availability — reporting 0% averages into a plant KPI and drags it down for a
 * machine that was simply not scheduled.
 */
export function computeRates({ TT, TO, TR, TF, TN, TU }) {
    const r = (num, den) => (den > 0 ? num / den : null);
    return {
        DO: r(TF, TR), // Disponibilité Opérationnelle — ISO 22400 Availability
        TP: r(TN, TF), // Taux de Performance          — Performance
        TQ: r(TU, TN), // Taux de Qualité              — Quality
        TC: r(TR, TO), // Taux de Charge               — Loading
        TRS: r(TU, TR), // = DO x TP x TQ              — OEE
        TRG: r(TU, TO), // = TRS x TC                  — OOE
        TRE: r(TU, TT), //                             — TEEP
    };
}

/**
 * Data-quality checks. Run them before you show anyone a number.
 *
 * Every one of these is a real defect that produces a plausible rate. A TRS of
 * 112% is obvious; a TRS of 78% built on a stale nominal cycle is not, and it
 * is the same bug.
 */
export function validate(times, rates = computeRates(times)) {
    const { TT, TO, TR, TF, TN, TU } = times;
    const issues = [];
    const nest = [
        ["TU", TU, "TN", TN],
        ["TN", TN, "TF", TF],
        ["TF", TF, "TR", TR],
        ["TR", TR, "TO", TO],
        ["TO", TO, "TT", TT],
    ];
    for (const [an, a, bn, b] of nest) {
        if (a > b + 1) {
            issues.push({
                code: `${an}_EXCEEDS_${bn}`,
                message: `${an} (${a}ms) is larger than ${bn} (${b}ms); the buckets must nest.`,
                fix:
                    an === "TN"
                        ? "The nominal cycle time is too slow, or units were counted that the machine did not make in this window. Check nominalCycleMs against engineering's current reference."
                        : "Stops are being deducted from the wrong level, or production overlaps a period the machine was not running.",
            });
        }
    }
    for (const [k, v] of Object.entries(rates)) {
        if (v !== null && v > 1.0000001) {
            issues.push({
                code: `${k}_ABOVE_100`,
                message: `${k} is ${(v * 100).toFixed(1)}%, which is not physically possible.`,
                fix: "Almost always a stale nominal cycle time or double-counted good units.",
            });
        }
    }
    if (rates.TRS !== null && rates.DO !== null && rates.TP !== null && rates.TQ !== null) {
        const drift = Math.abs(rates.TRS - rates.DO * rates.TP * rates.TQ);
        if (drift > 1e-9) {
            issues.push({
                code: "IDENTITY_BROKEN",
                message: `TRS does not equal DO x TP x TQ (drift ${drift.toExponential(2)}).`,
                fix: "The factorisation is exact by construction — a drift means the buckets were not computed from the same data.",
            });
        }
    }
    return issues;
}

/**
 * Combine machines, shifts or days into one rate.
 *
 * **Never average rates.** Each entry has its own denominator, so the mean of
 * per-machine TRS is not the plant TRS — it weights a machine that ran twenty
 * minutes the same as one that ran three shifts. Sum the numerators, sum the
 * denominators, divide once.
 */
export function rollup(entries) {
    const acc = { TT: 0, TO: 0, TR: 0, TF: 0, TN: 0, TU: 0, units: { good: 0, bad: 0, total: 0 } };
    for (const e of entries) {
        for (const k of ["TT", "TO", "TR", "TF", "TN", "TU"]) acc[k] += e[k] ?? 0;
        if (e.units) {
            acc.units.good += e.units.good ?? 0;
            acc.units.bad += e.units.bad ?? 0;
            acc.units.total += e.units.total ?? 0;
        }
    }
    return { times: acc, rates: computeRates(acc) };
}

/**
 * Nakajima's bands. The NORM ITSELF PUBLISHES NO THRESHOLDS — these are the
 * 1988 industry conventions, and they assume discrete manufacturing. A
 * continuous process or a job shop has a different ceiling, and a plant's own
 * history beats any of this.
 */
export function qualify(trs) {
    if (trs === null || trs === undefined) return { band: "no_data", label: "No scheduled time" };
    if (trs >= 0.85) return { band: "world_class", label: "World class" };
    if (trs >= 0.75) return { band: "good", label: "Good" };
    if (trs >= 0.6) return { band: "acceptable", label: "Acceptable" };
    if (trs >= 0.4) return { band: "poor", label: "Poor" };
    return { band: "critical", label: "Critical" };
}

/** French / English / ISO 22400 names for the same quantity. */
export const GLOSSARY = {
    TRS: { fr: "Taux de Rendement Synthétique", en: "OEE", iso: "OEE", denominator: "TR" },
    TRG: { fr: "Taux de Rendement Global", en: "OOE", iso: "NEE", denominator: "TO" },
    TRE: { fr: "Taux de Rendement Économique", en: "TEEP", iso: "TEEP", denominator: "TT" },
    DO: { fr: "Disponibilité Opérationnelle", en: "Availability", iso: "A" },
    TP: { fr: "Taux de Performance", en: "Performance", iso: "E" },
    TQ: { fr: "Taux de Qualité", en: "Quality", iso: "Q" },
    TC: { fr: "Taux de Charge", en: "Loading", iso: "—" },
};
