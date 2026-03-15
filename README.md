# SillyTavern GProxy Prompt Cache

SillyTavern extension for deterministic summary/body prompt splitting and GProxy cache trigger injection.

## What it does

- Hooks `CHAT_COMPLETION_PROMPT_READY`
- Skips Prompt Manager dry-runs
- Recomputes managed assistant-message ranges on every real send
- Detects assistant messages containing a matching `<details><summary>摘要</summary>...</details>` block
- Lets you configure the body-window base `x` (default `10`)
- Keeps the newest managed turns as body-only, and turns older managed turns into summary-only blocks after the `2x` managed turn
- Appends the selected GProxy magic trigger to:
  - the summary boundary message
  - the latest managed assistant message

Current split rule:

- before `2x` managed assistant turns: all body-only
- after that, the oldest chunks of `x` become summary-only
- the newest managed turns keep body text, so the live body window stays between `x` and `2x-1` turns
- and so on

## Install

### Option 1: Import from Git Repo

In SillyTavern:

1. Open `Manage extensions`
2. Click `Install extension`
3. Paste this repo URL:

```text
https://github.com/LeenHawk/SillyTavern-GProxy-Prompt-Cache
```

4. Reload SillyTavern
5. Enable `GProxy Prompt Cache`

### Option 2: Manual install

Put these files into:

```text
public/scripts/extensions/third-party/SillyTavern-GProxy-Prompt-Cache/
```

Then reload SillyTavern.

## JS-Slash-Runner

Recommended companion extension:

```text
https://github.com/N0VI028/JS-Slash-Runner
```

It is not required for the core prompt rewrite, but it is useful for scripted control.

Available slash commands:

- `/gproxycache-status`
- `/gproxycache-set enabled=true trigger=1h summary=摘要 x=10`

## Files

- `manifest.json`: extension manifest
- `index.js`: prompt rewrite logic
- `settings.html`: small settings panel
