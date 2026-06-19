# Translation quality eval (EN↔VI)

TranslateGemma is a strong *expected* upgrade over Argos for English↔Vietnamese,
but the research behind adopting it found **no published EN↔VI head-to-head** vs
Argos/NLLB, and **no published VI→EN number at all** (the TranslateGemma report's
WMT24++ numbers are English→XX only). So treat "better than Argos for Vietnamese"
as a hypothesis to verify on our own content **before** we surface it as a claim.

## Run it

Start the engine(s) you want to compare, then:

```bash
pnpm build                       # once, so @videodubber/shared resolves

# Argos (the bundled translation worker on :5102) is always compared.
# Add TranslateGemma via Ollama:
EVAL_OLLAMA=1 OLLAMA_MODEL=translategemma:4b pnpm eval:translation

# …or via a running llama-server (the managed pack, or your own):
EVAL_LLAMACPP_URL=http://127.0.0.1:8080 pnpm eval:translation

# Your own parallel set (JSONL of {"dir":"en-vi"|"vi-en","src":"…","ref":"…"}):
pnpm eval:translation -- --testset path/to/flores-en-vi.jsonl
```

It drives the **real** provider classes (same prompts, same Gemma-turn handling),
prints a chrF table per direction, and writes a side-by-side dump to
`eval-translation-output.md` for human A/B.

## Caveats

- The built-in sample is **8 sentences** — indicative only. For a decision-grade
  number use **FLORES+ devtest** and/or **PhoMT**, and a **learned metric**
  (COMET / MetricX), not just chrF.
- Evaluate **both directions** and on **dub-style lines** (short, spoken,
  timing-constrained) — that's the workload, and VI→EN is entirely unmeasured
  upstream.
- Compare the 4B and 12B: the research suggests a large 4B→12B jump but small
  12B→27B, so confirm the 4B (the CPU default) is already a clear win over Argos.

See [`PROVIDERS.md`](PROVIDERS.md) for the providers/packs and the Gemma license
note, and [`../NOTICE.md`](../NOTICE.md) for the redistribution obligations.
