# PORT.md  -  Remove BG + AI Chat (Free AI and Agents family) on Figma

**Principle: the features stay the same; only the carrier changes.** When we build one port, we build for all  -  shared prompts, shared agents, shared free-pool auth.

## Platform facts

| Aspect | Figma |
|---|---|
| Runtime | Figma plugin (TypeScript + HTML iframe UI) |
| Mechanism | Standard plugin manifest; iframe sandbox for chat; figma.* bridge via postMessage
| Chat UI | Plugin window chat panel (design canvas is the document)
| Storage | figma.clientStorage for keys/history; pluginData on nodes for context
| Distribution | Figma Community plugins listing

## Adapter map (Obsidian -> Figma)

| Obsidian :: API -> figma: Plugin API node tree |
| Obsidian Vault -> Figma documents/components |
| Obsidian commands -> plugin commands + quick actions |
| Obsidian settings -> plugin window settings UI |

## Source status

- The Obsidian builds live in the source repo (../free-ai-agents) as reference only - they do not run here.
- The NATIVE source for this port lives in this folder (see STATUS.md for what is implemented).
- LICENSE - MIT carries over unchanged.

## First concrete step

**Plugin scaffold from Figma templates; iframe chat UI reusing the existing chat markup from styles.css.**

## Progress (mirror of the Trello Ecosystem Ports card)

See [STATUS.md](STATUS.md)  -  keep it in sync with the 'Revisit: Microtransactions' card and the 'Create the Free AI and Agents app across all ecosystems' card.

