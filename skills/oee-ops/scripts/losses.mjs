/**
 * Where the time went — the part a Kaizen workshop actually attacks.
 *
 * A TRS is a scalar; nobody can act on a scalar. The waterfall and the Pareto
 * are what turn "78%" into "changeovers cost us 4.2 hours this week".
 */
import { clip, subtract, union, measure } from "./intervals.mjs";
import { computeTimes } from "./oee.mjs";

/** Nakajima's Six Big Losses, mapped onto the NF E 60-182 buckets. */
export const SIX_BIG_LOSSES = {
    breakdowns: { family: 1, bucket: "TR_TF", label: "Breakdowns" },
    setup: { family: 2, bucket: "TR_TF", label: "Setup & adjustment" },
    minor_stops: { family: 3, bucket: "TR_TF", label: "Idling & minor stops" },
    reduced_speed: { family: 4, bucket: "TF_TN", label: "Reduced speed" },
    startup_rejects: { family: 5, bucket: "TN_TU", label: "Start-up rejects" },
    quality_defects: { family: 6, bucket: "TN_TU", label: "Quality defects" },
};

/**
 * The TT → TO → TR → TF → TN → TU waterfall, each step with the time it cost.
 *
 * The steps sum exactly to TT by construction — if a chart's bars do not add
 * up, the numbers behind it were computed independently instead of nested.
 */
export function waterfall(times) {
    const { TT, TO, TR, TF, TN, TU } = times;
    const steps = [
        { from: "TT", to: "TO", lost: TT - TO, cause: "Non-engagement (outside the shift)" },
        { from: "TO", to: "TR", lost: TO - TR, cause: "Planned stops" },
        { from: "TR", to: "TF", lost: TR - TF, cause: "Unplanned stops" },
        { from: "TF", to: "TN", lost: TF - TN, cause: "Speed loss" },
        { from: "TN", to: "TU", lost: TN - TU, cause: "Quality loss" },
    ];
    return { start: TT, end: TU, steps, accounted: steps.reduce((s, x) => s + x.lost, 0) };
}

/**
 * Time lost per stop reason, biggest first — the Pareto that drives the
 * improvement plan.
 *
 * Reasons are measured as SETS, so two systems logging the same breakdown do
 * not make it look twice as expensive as it was. `overlapRemoved` reports how
 * much double-counting a naive sum would have introduced, because that number
 * is itself a finding about the MES.
 */
export function paretoByReason(stops, { from, to, categories = ["arret_propre", "arret_induit"] } = {}) {
    const inScope = stops.filter((s) => categories.includes(s.category));
    const byReason = new Map();
    for (const s of inScope) {
        const key = s.reason ?? s.subcategory ?? "unspecified";
        if (!byReason.has(key)) byReason.set(key, []);
        byReason.get(key).push(s);
    }
    const rows = [...byReason.entries()].map(([reason, list]) => {
        const clipped = clip(list, from, to);
        const merged = measure(clipped);
        const summed = list.reduce(
            (acc, s) => acc + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)),
            0
        );
        return { reason, lost: merged, count: list.length, overlapRemoved: summed - merged };
    });
    rows.sort((a, b) => b.lost - a.lost);
    const total = rows.reduce((s, r) => s + r.lost, 0);
    let running = 0;
    for (const r of rows) {
        running += r.lost;
        r.share = total > 0 ? r.lost / total : 0;
        r.cumulative = total > 0 ? running / total : 0;
    }
    return { total, rows };
}

/**
 * What one reason is worth: the TRS you would have had without it.
 *
 * This is the number that funds the project. "Changeovers cost 4.2 hours" is a
 * fact; "eliminating them takes TRS from 73.5% to 78.4%" is a decision.
 *
 * **It is a model, not a measurement, and the assumption is load-bearing**:
 * that the recovered time would have run at the SAME performance and quality
 * as the rest of the window. Removing the stop alone does not move TRS at all —
 * TU and TR are both unchanged — so any tool that reports a change is
 * projecting extra output, whether or not it admits it. This one admits it:
 *
 *     TU_after = TU + recovered_time x TP x TQ
 *
 * That assumption is optimistic right after a changeover (start-up scrap is
 * real) and pessimistic for a starved line that would have run clean. Quote the
 * range, not the point, when someone is deciding on it.
 */
export function impactOfRemoving(reason, { from, to, stops, production }) {
    const base = computeTimes({ from, to, stops, production });
    const without = computeTimes({
        from,
        to,
        stops: stops.filter((s) => (s.reason ?? s.subcategory) !== reason),
        production,
    });

    const recovered = without.TF - base.TF;
    const TP = base.TF > 0 ? base.TN / base.TF : 0;
    const TQ = base.TN > 0 ? base.TU / base.TN : 0;

    const trsBefore = base.TR > 0 ? base.TU / base.TR : null;
    const projectedTU = base.TU + recovered * TP * TQ;
    const trsAfter = base.TR > 0 ? projectedTU / base.TR : null;

    return {
        reason,
        trsBefore,
        trsAfter,
        timeRecovered: recovered,
        extraGoodUnits:
            production.length && production[0].nominalCycleMs > 0
                ? (projectedTU - base.TU) / production[0].nominalCycleMs
                : null,
        assumption: "Recovered time runs at the window's own TP and TQ.",
    };
}
