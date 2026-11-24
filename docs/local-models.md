# Local models

Findings on running a model on the owner's own machine. Ghost runs one itself
as the `local` agent; its contract is
[CONTRACTS.md "Local model"](../CONTRACTS.md#local-model). This page records
what was measured.

## Status

- **In use (2026-11-24):** Inkling 2 Mini as the native `local` agent. See
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
  lowest still reasons. Ghost sends none of these.
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
- Native, in a scratch daemon: the load took 12 s. Asked the time and what
  the owner's WhatsApp chats said about handing over a passport, it read the
  clock from its prompt, searched with Recall, and named four chats, in 44 s.
- A question for the Lastbook library took 2 min 21 s and ten tool calls
  (it tried `find_files` and `grep_files` before reading the page it found),
  and cited the right booklet and pages.
- Those two runs used an earlier tool set (seven tools and an approval step
  for commands), replaced the same day by search, read and delegate, with the
  owner's message searched before the model runs and three tool rounds.

With search, read and delegate, ripgrep and fzf beside Recall, thinking
off, and the first search's top three hits opened into the prompt (all on
2026-11-17, a scratch daemon, the model warm):

- Thinking had cost about a minute per answer (about 1,000 tokens of it);
  without it a turn took 22–39 s, the first after a load 32 s.
- "What did my WhatsApp chats say about handing over a passport?" named
  three or four of the right chats each time, from the first search alone.
- "When was the scooter import tax invoice from PT Yan Trading, and how
  much was it?" found it in `~/Work`. It never called `read`; until the
  right hits were opened into the prompt it answered 15,981,273, a misreading
  of the file name's `IDR 159812737`, in 7 of 8 runs. With them it quoted
  `Rp 159.812.737` both times, but that is the invoice's subtotal, not its
  `TOTAL` line (`Rp 93.248.737`).
- Hits had been numbered in the order sources finished, so the fastest,
  Lastbook, took `S1`; they are now numbered in source order.

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
  the model itself with a prompt of about 1,500 tokens and a few tools
  (search, read, delegate, and two that write its own notes and reminders),
  as Lastbook does.

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
- What `search` finds through Recall is Recall's own configuration. On the
  test machine its root is the home folder, minus code and scratch folders it
  lists as excluded, so a new folder is indexed without anyone adding it.

## Open questions

1. Does the 26B model hold up over long conversations and many tool calls?
2. Why generation sometimes drops from 23 to about 6 tokens/s.
3. Whether to stop Lastbook's idle copy before loading Ghost's.
