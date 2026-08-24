# Prompt-injection defense

Ghost treats fetched web-page text and on-screen text as untrusted. Its defense is layered:

1. `fenceUntrusted` wraps each untrusted payload in tags containing a fresh, per-call nonce. It also neutralizes a matching close tag inside the payload, preventing page text from trivially escaping its boundary.
2. `HeuristicInjectionDetector` applies deterministic, local checks for imperative instructions directed at an AI, spoofed system/assistant/developer turns, tool-call-shaped text, invisible or bidirectional Unicode controls, and unusually large base64 or hexadecimal blobs.
3. `ClassifierInjectionDetector` can add an opt-in local text-classification signal. `CompositeInjectionDetector` combines the heuristic and classifier additively: either detector can flag content, the higher score wins, and their reasons are merged.

Detection is a defense-in-depth signal rather than proof that content is safe. The nonce fence limits how untrusted content is presented, while the detectors identify known suspicious shapes.

## Optional local classifier

Install the optional runtime:

```sh
pnpm add @huggingface/transformers
```

Set `GHOST_INJECTION_MODEL` to a Transformers.js-compatible Meta Prompt Guard 2 model or to `protectai/deberta-v3-base-prompt-injection-v2`. For example:

```sh
GHOST_INJECTION_MODEL=protectai/deberta-v3-base-prompt-injection-v2 ghost
```

`GHOST_INJECTION_THRESHOLD` optionally sets the classifier flag threshold from 0 to 1; it defaults to `0.5`. If no model is configured, the classifier remains disabled and does not download a model.

### Measured classifier results (2026-08-24)

`protectai/deberta-v3-base-prompt-injection-v2` loaded and ran through `@huggingface/transformers`. On the 34-injection/28-benign corpus at the default `0.5` threshold, `ClassifierInjectionDetector` achieved **32/34 = 0.941 recall** and **8/28 = 0.286 FPR**; the additive `CompositeInjectionDetector` achieved **34/34 = 1.000 recall** and **8/28 = 0.286 FPR**. The model-backed test used Vitest's `--testTimeout=60000` CLI option because the default five-second timeout expired during inference. The heuristic already caught every injection in this corpus, so the classifier added no catches here and instead added eight false positives.

## Detection evaluation

Run the deterministic heuristic evaluation from the repository root:

```sh
pnpm --filter @ghost/extensions test injection-eval
```

To also measure a local classifier and its additive composite result, set the model for the same command:

```sh
GHOST_INJECTION_MODEL=protectai/deberta-v3-base-prompt-injection-v2 pnpm --filter @ghost/extensions test injection-eval
```

The evaluation prints recall, false-positive rate (FPR), per-category catch counts, misses, and false positives. The model-backed block skips cleanly when `GHOST_INJECTION_MODEL` is unset.

The heuristic corpus measured on 2026-08-24 contains 34 injection samples and 28 benign samples. Its category distribution and observed catches are:

| Primary category | Caught / corpus |
| --- | ---: |
| `imperative-ai-instruction` | 13 / 13 |
| `role-marker-spoofing` | 5 / 5 |
| `tool-call-shaped-text` | 6 / 6 |
| `invisible-or-bidi-unicode` | 4 / 4 |
| `large-encoded-blob` | 6 / 6 |

Observed heuristic recall is **34/34 = 1.000** and observed FPR is **0/28 = 0.000**. The regression test requires recall of at least **0.97** and FPR of at most **0.04**, allowing a small measurement margin while still detecting meaningful regressions.
