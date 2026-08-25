# dsh-plugin-toggle

Hot-plug enable/disable switches for installed DeepSeek Harness plugins, without restarting DSH.

## Features

- List installed plugins with descriptions.
- Enable / disable plugins live.
- Protect core plugins (`CORE_DENYLIST`) from being disabled.
- Auto-applies patches to official plugin inventory UI on startup.
- The session-header preset dropdown now auto-hides when `dsh-preset-switch` is disabled (polling every 5s + on window focus, no manual refresh needed).
- Works in the DSH Web UI Plugin list.

## Install

```bash
dsh plugin --profile web add github:aorucshiea/dsh-plugin-toggle
```

## Usage

- Open DSH Web UI → Settings → Plugins.
- Use the **Disable / Enable** buttons.
- Core plugins are marked **Protected**.

## Notes

- This plugin patches official client/host files at startup. It is idempotent and restores safe behavior when the target official files are in a broken state.
- No API keys or credentials are stored in this repository.

## License

MIT
