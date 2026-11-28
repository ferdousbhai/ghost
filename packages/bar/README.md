# `ghost-bar`

Ghost's bar: a prompt near the bottom of the screen, over whatever else is
there, and above it what the owner asked with the whole of what the ghost
answers. What it is to the rest of Ghost (a client of the daemon's API, one
instance, dictation) is in [`CONTRACTS.md`](../../CONTRACTS.md#package-boundaries);
this page is how it behaves.

## On screen

Nothing of it stays on screen. The prompt goes when a question is sent. The
answer stays until the owner puts the bar away: all of it, as Markdown,
scrolling past about half the screen's height, with the command that is
running as one status line. Reasoning, commands and what they printed are not
in it: `ghost show` lists them. The answers to the ghost's open question are
buttons under what it said, the one it recommends first and marked; any other
answer is typed.

The prompt sits just above where Omarchy's dictation shows what it hears, so
neither covers the other. Where the machine has that dictation, the prompt
ends in a microphone and the key that starts it, as Hyprland has it bound;
a click on the microphone does the same as the key.

## Keys

| Key | What it does |
|---|---|
| `Enter` | Sends what is in the prompt; while a turn runs, as a follow-up to it. What could not be sent comes back to the prompt. |
| `Escape` | Puts the bar away. It stops nothing: a running turn runs on and is on screen when the bar is summoned again; an answer that had ended while on screen is not. Turning to another window does the same for an answer; the prompt keeps the keyboard until it is sent or put away. |
| `Ctrl+C` | As in a terminal: stops the running turn; with none, empties the prompt; with nothing to empty, puts the bar away. |
| `Up`, `Down` (`Page Up`, `Page Down`) | Back and forth through the conversation's newest messages, an exchange at a time. |
| `Ctrl+Q` | Ends the bar. |

Summoning the bar (`ghost-bar` again, which is what a key binding runs) shows
it with its prompt and gives it the keyboard. The conversation is read again
each time it is summoned and when a turn ends, so it shows what was said from
the terminal or the page. A launch of another version replaces the running
bar; a build of the same version needs `Ctrl+Q` first.

It reaches the daemon through the CLI's own client (`ghostd::client`), found
afresh for each request, which gives up after 5 s. A port, config or token
file it cannot use is an error line in the bar.

## Working on it

The look is [omui](https://github.com/ferdousbhai/omui)'s, on Omarchy's
current theme; [`style.css`](src/style.css) holds only Ghost's own rules, on
omui's `@om_*` colours. [`dev/qa.sh`](dev/qa.sh) walks the main flows, with
screenshots, in a bar built with the `qa` feature, against a scratch ghostd (the
release build) and a stand-in model on a private broadway display; never try a change on the
owner's session.
