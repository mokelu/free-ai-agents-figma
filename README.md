# Remove BG + AI Chat  -  Figma port of the Free AI and Agents family

Free AI chat and vault-editing agents for **Figma**. No account, no signup, free monthly tokens. Bring your own key if you want other providers.

This folder is the **port starting kit** for the Figma ecosystem. The source of truth lives in [$data.source](../../free-ai-agents).

## What stays constant on every platform

- Top-tier free AI models (DeepSeek, Qwen, Mercury, ...)
- Agents that edit your vault, with approval before every change
- Chat and agent modes (read, search, write, move, tags, properties)
- Web tools (web_read, web_search)
- Voice typing (option, with your own Groq key)
- Local history and snapshots with restore

## On Figma

- **Runtime:** Figma plugin (plain JavaScript + HTML iframe UI)
- **Plugin mechanism:** manifest.json + code.js sandbox + ui.html iframe; network limited to api.usefree.space
- **Chat UI:** Plugin window chat panel with live document context injected (page/selection/palette summaries)
- **Agents:** one-click selection agents (WCAG contrast fix, type-scale snap, AI palette remap, in-place copy rewrite) + page hygiene agent (scan -> checkbox-approved batch fixes)
- **Storage:** figma.clientStorage for keys/history; pluginData on nodes for context
- **Distribution:** Figma Community plugins listing

See [PORT.md](PORT.md) for the adapter mapping and [STATUS.md](STATUS.md) for progress.

## License

MIT. Website: [usefree.space](https://usefree.space) | Main repo: [github.com/mokelu/free-ai-agents](https://github.com/mokelu/free-ai-agents)
