#!/usr/bin/env node
/**
 * Compute and explain a TRS from a file of events.
 *
 *   node oee-cli.mjs shift.json [--json]
 *
 * The point of the text output is the waterfall: a bare "78.3%" tells an
 * operator nothing, and the first question in every review is "where did the
 * rest go?".
 *
 * Input shape:
 * {
 *   "from": "2026-01-15T00:00:00Z",
 *   "to":   "2026-01-16T00:00:00Z",
 *   "stops": [{ "start": "...", "end": "...", "category": "arret_propre", "reason": "changeover" }],
 *   "production": [{ "goodUnits": 900, "badUnits": 40, "nominalCycleMs": 50000 }]
 * }
 */
import fs from "node:fs/promises";
import { computeTimes, computeRates, validate, qualify, GLOSSARY } from "./oee.mjs";
import { waterfall, paretoByReason } from "./losses.mjs";

const H = 3_600_000;
const hrs = (ms) => (ms / H).toFixed(2).padStart(8);
const pct = (v) => (v === null ? "     —" : `${(v * 100).toFixed(1).padStart(5)}%`);
const ts = (v) => (typeof v === "number" ? v : Date.parse(v));

export function analyse(input) {
    const from = ts(input.from);
    const to = ts(input.to);
    const stops = (input.stops ?? []).map((s) => ({ ...s, start: ts(s.start), end: ts(s.end) }));
    const production = input.production ?? [];
    const times = computeTimes({ from, to, stops, production });
    const rates = computeRates(times);
    return {
        times,
        rates,
        rating: qualify(rates.TRS),
        issues: validate(times, rates),
        waterfall: waterfall(times),
        pareto: paretoByReason(stops, { from, to }),
    };
}

function render(a) {
    const L = [""];
    const { times: t, rates: r } = a;
    L.push(`TRS ${pct(r.TRS)}   ${a.rating.label}      (NF E 60-182 / OEE)`);
    L.push(`TRG ${pct(r.TRG)}                        (OOE — includes planned stops)`);
    L.push(`TRE ${pct(r.TRE)}                        (TEEP — vs calendar time)`);
    L.push("");
    L.push(`  DO ${pct(r.DO)}  x  TP ${pct(r.TP)}  x  TQ ${pct(r.TQ)}  =  TRS ${pct(r.TRS)}`);
    L.push("");
    L.push("WATERFALL                         HOURS    LOST");
    let prev = t.TT;
    L.push(`  TT  total                    ${hrs(t.TT)}`);
    for (const s of a.waterfall.steps) {
        const to = prev - s.lost;
        L.push(`  ${s.to.padEnd(3)} ${s.cause.slice(0, 24).padEnd(24)} ${hrs(to)} ${hrs(s.lost)}`);
        prev = to;
    }
    if (a.pareto.rows.length) {
        L.push("");
        L.push("UNPLANNED STOPS BY REASON         HOURS   SHARE   CUM.");
        for (const row of a.pareto.rows.slice(0, 10)) {
            L.push(
                `  ${row.reason.slice(0, 28).padEnd(28)} ${hrs(row.lost)} ${pct(row.share)} ${pct(row.cumulative)}` +
                    (row.overlapRemoved > 0 ? `   (${(row.overlapRemoved / H).toFixed(2)}h of overlap removed)` : "")
            );
        }
    }
    if (a.issues.length) {
        L.push("");
        L.push("DATA QUALITY");
        for (const i of a.issues) {
            L.push(`  ! ${i.code}: ${i.message}`);
            L.push(`    ${i.fix}`);
        }
    } else {
        L.push("");
        L.push("Data quality: buckets nest, no rate above 100%, TRS = DO x TP x TQ holds.");
    }
    L.push("");
    return L.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const file = process.argv.slice(2).find((a) => !a.startsWith("--"));
    if (!file) {
        process.stderr.write("usage: node oee-cli.mjs <events.json> [--json]\n");
        process.exit(2);
    }
    const input = JSON.parse(await fs.readFile(file, "utf8"));
    const a = analyse(input);
    process.stdout.write(process.argv.includes("--json") ? JSON.stringify(a, null, 2) + "\n" : render(a));
    process.exitCode = a.issues.length ? 1 : 0;
}
