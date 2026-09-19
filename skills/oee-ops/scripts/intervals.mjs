/**
 * Interval-set algebra, because time buckets are sets of time — not sums.
 *
 * Every OEE implementation that adds up `durationSeconds` is wrong the first
 * time two stops overlap, and MES data overlaps constantly: a breakdown logged
 * by the operator and the same breakdown logged by the PLC, a changeover that
 * begins before the previous stop was closed, a stop that started yesterday.
 * Summing those over-deducts, and the error is invisible — it just makes the
 * line look worse, or pushes a bucket negative and the rate above 100%.
 *
 * Work in integers (milliseconds). Floating-point seconds accumulate error
 * across a month of events and make `TRS = DO x TP x TQ` stop holding exactly.
 */

/** @typedef {{start:number, end:number}} Interval */

/** Sort, drop empties, and merge anything that overlaps or touches. */
export function normalize(intervals) {
    const clean = intervals
        .map((i) => ({ start: Math.round(i.start), end: Math.round(i.end) }))
        .filter((i) => i.end > i.start)
        .sort((a, b) => a.start - b.start);
    const out = [];
    for (const i of clean) {
        const last = out[out.length - 1];
        if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
        else out.push({ ...i });
    }
    return out;
}

/** Keep only the part of each interval inside [from, to]. */
export function clip(intervals, from, to) {
    return normalize(
        intervals.map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    );
}

/** a minus b, as sets. */
export function subtract(a, b) {
    const A = normalize(a);
    const B = normalize(b);
    const out = [];
    for (const seg of A) {
        let cursor = seg.start;
        for (const hole of B) {
            if (hole.end <= cursor) continue;
            if (hole.start >= seg.end) break;
            if (hole.start > cursor) out.push({ start: cursor, end: Math.min(hole.start, seg.end) });
            cursor = Math.max(cursor, hole.end);
            if (cursor >= seg.end) break;
        }
        if (cursor < seg.end) out.push({ start: cursor, end: seg.end });
    }
    return normalize(out);
}

export function union(a, b) {
    return normalize([...a, ...b]);
}

export function intersect(a, b) {
    // a ∩ b = a − (a − b)
    return subtract(a, subtract(a, b));
}

/** Total length, in the unit the interval endpoints use. */
export function measure(intervals) {
    return normalize(intervals).reduce((sum, i) => sum + (i.end - i.start), 0);
}
