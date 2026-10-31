# Interpretation evaluation

Run time: 2026-10-31T09:05:00.563Z
Dataset SHA-256: 992fd5976a221e28bf0b62a8f9f0d130aba9bd96ed0d8aea828bb41b56b48517
Dataset: 38 cases; tags: ages, all-unsure, ambiguous-unsure, append-goals, arabic-number, assignment, business, chinese-number, correction, country-role, income, insurance, invalid-country, key, multi-slot, negation, no-children, no-nationality-inference, off-topic, preserve-unmentioned, professional, prompt-injection, relevant-unrecognized, replace-goals, residence-status, rules, school, shared-nationality, short-answer, solo, targeted-unsure, timeline, unsupported-destination, unsure, unsure-forbidden; key cases reviewed: 0/14
Models: rules: deterministic rules
Prompt version: v1 (LLM only; rules: n/a)

| Engine | Intent accuracy | Update precision | Update recall | Unsure accuracy | Semantic accuracy | Average ms | Failures |
| --- | --- | --- | --- | --- | --- | --- | --- |
| rules | 38/38 (100.0%) | 44/44 (100.0%) | 44/44 (100.0%) | 38/38 (100.0%) | 38/38 (100.0%) | 0.17 | {} |

Update matches compare (slot, normalized value, operation); absent operations mean add for goals and set otherwise. Goal values are compared as sets. Semantic accuracy compares the resulting reconciled profiles. Failed cases remain in accuracy/recall denominators.

Skipped cases / engines:
- remote: not_configured; skipped 38 cases (G001, G002, G003, G004, G005, G006, G007, G008, G009, G010, G011, G012, G013, G014, G015, G016, G017, G018, G019, G020, G021, G022, G023, G024, G025, G026, G027, G028, G029, G030, G031, G032, G033, G034, G035, G036, G037, G038)
- local: not_configured; skipped 38 cases (G001, G002, G003, G004, G005, G006, G007, G008, G009, G010, G011, G012, G013, G014, G015, G016, G017, G018, G019, G020, G021, G022, G023, G024, G025, G026, G027, G028, G029, G030, G031, G032, G033, G034, G035, G036, G037, G038)
