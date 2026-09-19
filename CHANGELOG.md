# Changelog

## 0.1.0

First release. The `oee-ops` skill: the NF E 60-182 time hierarchy and the three
rates, nine documented ways an OEE comes out wrong while looking reasonable,
interval-set arithmetic for the time buckets, loss waterfall and Pareto by cause,
a shift analyser CLI, and a deterministic benchmark on round numbers.

`impactOfRemoving` is labelled a model rather than a measurement: removing a stop
alone moves TRS by nothing, so the projected gain rests on the assumption that
recovered time runs at the window's own performance and quality. Any tool that
reports a gain is making that assumption whether or not it says so.
