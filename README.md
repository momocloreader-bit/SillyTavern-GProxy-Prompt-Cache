# SillyTavern GProxy Prompt Cache

SillyTavern extension for deterministic summary/body prompt splitting and GProxy cache trigger injection.

## What it does

- Hooks `CHAT_COMPLETION_PROMPT_READY`
- Skips Prompt Manager dry-runs
- Recomputes managed assistant-message ranges on every real send
- Detects assistant messages containing a matching `<details><summary>摘要</summary>...</details>` block
- Keeps the newest managed turns as body-only, and turns older managed turns into summary-only blocks after the 20th managed turn
- Appends the selected GProxy magic trigger to:
  - the summary boundary message
  - the latest managed assistant message

Current split rule:

- `1-19` managed assistant turns: all body-only
- `20-29`: oldest `10` become summary-only
- `30-39`: oldest `20` become summary-only
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
- `/gproxycache-set enabled=true trigger=1h summary=摘要`

## Files

- `manifest.json`: extension manifest
- `index.js`: prompt rewrite logic
- `settings.html`: small settings panel
