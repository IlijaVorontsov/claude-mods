# claude-mods

Mods for [Claude Code](https://claude.com/claude-code): small plugins that change how the app looks and behaves. This repository is a plugin marketplace, so you add it once and install any mod from it.

| Mod | What it does |
| --- | --- |
| [read-aloud](read-aloud/) | Reads Claude's replies aloud while it works, with a queue of unheard replies, speed controls, a Now reading panel and a conversational reply mode. macOS. |

## Installing a mod

At the prompt of a Claude Code terminal session:

```
/plugin install read-aloud --marketplace IlijaVorontsov/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (the user scope makes the mod load in every session).

From a shell:

```bash
claude plugin install read-aloud --marketplace IlijaVorontsov/claude-mods
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `IlijaVorontsov/claude-mods`, then Add plugin.

## License

MIT, see [LICENSE](LICENSE).
