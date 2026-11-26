# Local models

Findings on running a model on the owner's own machine. Every Ghost turn runs
on one; its contract is
[CONTRACTS.md "Local model"](../CONTRACTS.md#local-model). This page records
what was measured.

## Status

- **In use (2026-11-24):** Inkling 2 Mini. See
  [Inkling 2 Mini](#inkling-2-mini-2026-11-24).
- **Before it (2026-11-17):** Gemma 4 26B A4B. See
  [Gemma 4 26B A4B](#gemma-4-26b-a4b-2026-11-17).
- **Not pursued:** Gemma 4 E4B, Qwen3.5-0.8B, and running a model through
  Crush. See [Tried before](#tried-before).

## Test machine

MacBook Pro 16-inch (M1 Max, 2021), 64 GB, running Omarchy on Asahi Linux.
There is no Metal or MLX on Linux; the GPU is reached through the Asahi Vulkan
driver (Honeykrisp, `vulkan-asahi` 26.2.6). The runtime is llama.cpp at
`61dbf49`, built from source with `-DGGML_VULKAN=ON`.

## Inkling 2 Mini (2026-11-24)

Model: `ggml-org/Inkling-2-Mini-GGUF`, `Inkling-2-Mini-IQ4_NL.gguf` (17.6 GB),
revision `e8a2cecf0e78`, served by llama.cpp's own release build `b12669`
(`llama-b12669-bin-ubuntu-vulkan-arm64.tar.gz`, unpacked under `~/.local/lib`;
it needs `libssl.so.3`). The machine is the one above, now on official Omarchy
4.5 (`linux-aurora` 7.2.11, `vulkan-asahi` 26.2.5), where the driver offers
32,081 MiB to Vulkan. Omarchy's own model engine (`omarchy-local-ai`,
`omarchy models`) is not packaged for this machine and its llama.cpp runtime
lists Intel GPUs only, so Ghost starts the server itself.

- llama.cpp supports the looped architecture and the model's chat template:
  tool calls come back as OpenAI `tool_calls` with `--jinja`, and reasoning as
  `reasoning_content`. Nothing in the loop needed changing for it.
- The server's defaults are temperature 1.0, top-p 1.0, top-k 50, and
  reasoning effort `high`. The template accepts `reasoning_effort` per request
  (`none`, `minimal`, `low`, `medium`, `high`, `max`); the model card says the
  lowest still reasons. Ghost sends only the effort, `low` unless
  `local.reasoningEffort` says otherwise.
- The load takes 11 s. On a 3,220-token prompt with every layer on Vulkan it
  read 80 tokens/s and wrote 7.7; on the CPU alone (8 threads) 39 and 5.8.
- Real turns in a scratch daemon, each a new conversation, effort `high`:
  a total and a date read from a file, 64 s with the load; three files
  written and their sizes summed, 364 s over three commands; a command that
  fails (it reported the message and exit status 2), 62 s; `seq 1 60000` (it
  sent the output to a file and counted it), 113 s; a ten-second loop, 59 s,
  its lines shown as they were printed; a turn stopped mid-command, which
  ended the command. All answers were right.

- With reasoning effort `low`, which Ghost now sends, the file question took
  44 s on a loaded model.
- Asked to use the coding agent, it ran Claude's command with a `tail` in
  place of the `jq` filter until the section said "by this command exactly
  but for the task"; then twice of twice it ran it as written, in 56 and
  88 s, and Claude's tool use and answer showed as they were printed.

- 2026-11-26, the conversation replayed as real messages and nothing in the
  prompt changing between turns (the idea is pi's; a stripped-down pi on the
  same model took 26 s and 4 s for these two turns). A file question and a
  follow-up, each after a warm-up turn: 39 s and 30 s before; 28 s and 10 s,
  then 33 s and 8 s, after. The server log shows why: the follow-up reads
  only the new message. One run each.
- The handoff, tried the same day with `contextSize` 6000. Written in the
  background once a turn ends past the threshold: a message sent straight
  after waited 173 s for a 970-character note and its own answer, and the
  turn after took 20 s; both knew what was said before the note and after.
  With two server slots instead, so that turns ran beside the note, a turn
  took 42 s where it took 7 s alone and the note had not landed after four
  minutes, so the server keeps one slot and the turn waits. Columns of numbers ran
  at about 1.3 characters to a token, so nothing here estimates tokens from
  characters where the server's count is known.
- 2026-11-26, the slot saved at each stop and restored at the next start. With
  `idleMinutes` 1: the server stopped for idleness after a turn, saving 1.1 GB;
  the next turn in that conversation took 49 s, 25 s of it the load, and did
  not read the conversation again. By hand, on a 5,739-token prompt: 68.5 s to
  read it, 0.2 s to save, 0.2 s to restore after a restart, then 0.4 s.
- The same day the time left the prompt. Asked the time or the weekday, the
  model ran `date` unprompted, twice of twice. Writing a note, it once dated
  a change with the note's old date rather than look the date up; the recipe no
  longer asks for dates.

## Gemma 4 26B A4B (2026-11-17)

Model: `unsloth/gemma-4-26B-A4B-it-GGUF`, `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf`
(15.8 GiB), revision `c099eb48e663`, served by the source build above with
every layer on Vulkan. Lastbook loads the same file through its own runner.

Measured on this machine:

- `llama-bench -p 2048`: micro-batch 512 reads prompts at 102 tokens/s, 2048
  at 164; flash attention changes neither. ghostd uses 2048.
- Generation ran at 23 tokens/s on a short prompt, but at 6.5 tokens/s in
  `llama-bench` minutes later with the machine otherwise idle (load 1.5).
  The cause was not found.
- Thinking cost about a minute per answer (about 1,000 tokens of it);
  without it a turn took 22–39 s.

Lastbook gives its copy back after 15 idle minutes; Ghost gives its own back
after its idle minutes. Both can be resident at once for up to that long.

## Tried before

- **Gemma 4 E4B** (`google/gemma-4-E4B-it-qat-q4_0-gguf`, 2026-11-14): 26.7
  tokens/s generation on Vulkan, and no wrong action or malformed call in 32
  runs of a 16-case, 12-tool probe (29 fully right; it refused "mute my
  microphone" though `bash` could do it). It was never tried on real ghost
  turns; the 26B model replaced it.
- **Qwen3.5-0.8B** (dropped 2026-11-09): an offline fallback making one
  constrained choice from 19 `omarchy` commands. At best 1% wrong actions but
  only 28 of 64 in-scope requests right: too small to tell lookalikes apart
  ("shut down" became lock) without refusing ordinary requests.
- **Crush** (2026-11-17): the 26B model through the Crush harness got 22,646
  prompt tokens a turn, almost all Crush's own, which took 309 s, and guessed
  the time four hours off rather than check the clock. That is why Ghost runs
  the model itself with a short prompt and two tools.

## Running one on Omarchy

- The Omarchy manual recommends LM Studio (a GUI) or Ollama (a CLI), both
  under *Install > AI* in the Omarchy menu. It names no models.
- The menu's Ollama entry installs `ollama-cuda` on NVIDIA, `ollama-rocm` on
  AMD, and plain `ollama` otherwise. On an Apple Silicon machine that is plain
  `ollama`; whether it reaches the GPU there is untested. An `ollama-vulkan`
  package exists but the menu does not pick it.
- llama.cpp with Vulkan is the route measured here. There is no official Arch
  package; the AUR has `llama.cpp-vulkan`, or build from source, which needs
  `cmake` (`uvx cmake` works), `glslc` and the Vulkan headers.
- Weights go in the Hugging Face hub cache (`~/.cache/huggingface/hub`),
  fetched with `uvx --from huggingface_hub hf download <repo> <file>`.

## Open questions

1. Why generation sometimes drops from 23 to about 6 tokens/s.
2. Whether to stop Lastbook's idle copy before loading Ghost's.
