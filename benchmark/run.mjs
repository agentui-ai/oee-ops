#!/usr/bin/env node
/**
 *   npm run bench            table + exit 1 if the skill misses anything
 *   npm run bench -- --json  machine-readable
 *
 * Two ledgers, because either half alone lies:
 *
 *   SKILL   does the recipe this skill teaches compute the right number?
 *           Anything under 100% is a broken promise in SKILL.md.
 *   TRAP    does the from-memory version get it WRONG?
 *           A case both sides pass is not a trap, and the report says so
 *           rather than inflating the score.
 */
import { CASES } from "./cases.mjs";

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function attempt(fn) {
    try {
        return { ok: true, value: await fn() };
    } catch (err) {
        return { ok: false, value: `threw: ${String(err.message).split("\n")[0].slice(0, 50)}` };
    }
}

export async function runBenchmark() {
    const results = [];
    for (const c of CASES) {
        const naive = await attempt(() => c.naive());
        const skilled = await attempt(() => c.skilled());
        results.push({
            name: c.name,
            trap: c.trap,
            expect: c.expect,
            naive,
            skilled,
            skillPass: skilled.ok && eq(skilled.value, c.expect),
            trapReal: !(naive.ok && eq(naive.value, c.expect)),
        });
    }
    return {
        results,
        skillScore: results.filter((r) => r.skillPass).length,
        trapScore: results.filter((r) => r.trapReal).length,
        total: results.length,
    };
}

const short = (v, n = 24) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s === undefined ? "undefined" : s.length > n ? s.slice(0, n - 1) + "…" : s;
};

export function formatReport({ results, skillScore, trapScore, total }) {
    const L = ["", "oee-ops benchmark — deterministic, offline, no LLM", ""];
    L.push("CASE                             SKILL  TRAP   EXPECTED           FROM MEMORY");
    for (const r of results) {
        L.push(
            [
                r.name.slice(0, 31).padEnd(31),
                (r.skillPass ? " ok  " : " FAIL").padEnd(6),
                (r.trapReal ? " yes " : " no  ").padEnd(6),
                short(r.expect, 19).padEnd(19),
                short(r.naive.value),
            ].join(" ")
        );
    }
    L.push("");
    L.push(`SKILL  ${skillScore}/${total}  the recipes in SKILL.md compute the right number`);
    L.push(`TRAP   ${trapScore}/${total}  the from-memory version gets it wrong`);
    if (trapScore < total) {
        const soft = results.filter((r) => !r.trapReal).map((r) => r.name);
        L.push("");
        L.push(`Not traps here (both approaches agree): ${soft.join(", ")}`);
        L.push("That is information, not a failure.");
    }
    for (const f of results.filter((r) => !r.skillPass)) {
        L.push("");
        L.push(`FAIL ${f.name}`);
        L.push(`  expected: ${JSON.stringify(f.expect)}`);
        L.push(`  skilled:  ${JSON.stringify(f.skilled.value)}`);
    }
    L.push("");
    return L.join("\n");
}

const result = await runBenchmark();
process.stdout.write(
    process.argv.includes("--json") ? JSON.stringify(result, null, 2) + "\n" : formatReport(result)
);
process.exitCode = result.skillScore === result.total ? 0 : 1;
