# Interpretation evaluation

Run time: 2026-10-31T09:20:57.681Z
Dataset SHA-256: 992fd5976a221e28bf0b62a8f9f0d130aba9bd96ed0d8aea828bb41b56b48517
Dataset: 38 cases; tags: ages, all-unsure, ambiguous-unsure, append-goals, arabic-number, assignment, business, chinese-number, correction, country-role, income, insurance, invalid-country, key, multi-slot, negation, no-children, no-nationality-inference, off-topic, preserve-unmentioned, professional, prompt-injection, relevant-unrecognized, replace-goals, residence-status, rules, school, shared-nationality, short-answer, solo, targeted-unsure, timeline, unsupported-destination, unsure, unsure-forbidden; key cases reviewed: 0/14
Models: rules: deterministic rules
Prompt version: v1 (LLM only; rules: n/a)

| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 38/38 (100.0%) | 44/44 (100.0%) | 44/44 (100.0%) | 38/38 (100.0%) | 38/38 (100.0%) | 0.16 | {} |

Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.

Skipped cases / engines:
- None.
