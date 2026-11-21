# read-aloud

A Claude Code mod that reads Claude's replies aloud with the macOS voices, starting while Claude is still working, so you can listen instead of reading.

## What it does

- **Reads as Claude works.** Each piece of text Claude writes between its steps is read as soon as it appears, one sentence after another with no gaps. Code blocks are shown but never read.
- **Only the session you are working in speaks.** With several sessions open, the one you last typed in (or clicked a read-aloud button in) reads; switching to another session stops the first.
- **Stops when you dictate.** As soon as any app starts recording from the microphone (Claude's press-and-hold dictation, macOS Dictation, a call), reading stops, and you can continue later from the sentence where it stopped.
- **Keeps track of what you have not heard.** Replies you have not listened to get an unread marker with **▶ Listen from here** and **✓ Mark as read**; heard ones keep **▶ Listen from here** and **↺ Mark as unread**.
- **Speed controls.** **− 1.0× +** above the prompt, from 0.8× to 2.5×; a change applies from the next sentence.
- **Now reading panel.** **📖 Follow** opens a panel beside the chat that shows the reply being read as it appears in the chat, the current sentence in blue, read paragraphs greyed out. Click the blue sentence to restart it, or hover a paragraph and press ▶ to start there.
- **Conversational replies.** **💬 Conversational** asks Claude to write its messages to you as plain spoken explanations, keeping exact test results, errors and file names you need, while all technical work goes on as usual.

## Requirements

- macOS (it uses the built-in `say` voices and the system audio APIs).
- The Xcode Command Line Tools, for the small Swift audio reader the mod builds on first use (`xcode-select --install` if `swiftc` is missing).
- Claude Code with mods (plugin hooks modules) support.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install read-aloud --marketplace IlijaVorontsov/claude-mods
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```bash
claude plugin install read-aloud --marketplace IlijaVorontsov/claude-mods
```

In the Claude desktop app: click + next to the prompt box, then Plugins, Add marketplace with `IlijaVorontsov/claude-mods`, then Add plugin.

## Use

Turn it on with **🔊 Read aloud** above the prompt, or `/read-aloud`.

| Command | Does |
| --- | --- |
| `/read-aloud` | Turn reading on or off (`on`, `off` also work) |
| `/read-aloud stop` | Stop the current reading |
| `/read-aloud continue` | Read what you have not heard yet, from where it stopped |
| `/read-aloud speed 1.6` | Set the speed (0.5 to 3) |
| `/read-aloud voice Samantha` | Use another installed voice (list them with `say -v '?'`) |
| `/read-aloud status` | Show the state and make this the session that speaks |
| `/conversational` | Turn conversational replies on or off |

The voice defaults to Zoe (Enhanced) where it is installed (System Settings → Accessibility → Spoken Content → System Voice → Manage Voices), and to the system voice otherwise.

## How it works

Everything runs on your Mac. The mod keeps its working files in `~/.claude/read-aloud/` (the audio reader it builds, which session is active, the reading speed) and sends nothing anywhere.
