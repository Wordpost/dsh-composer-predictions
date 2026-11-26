# Composer predictions for DeepSeek Harness

Independent community plugin for DeepSeek Harness (DSH). It suggests a next message and helps clarify a draft. **It never sends a message.**

[Русская версия](https://github.com/Wordpost/dsh-composer-predictions/blob/main/README.ru.md)

## Install the beta

The beta targets **DSH `0.2.2-rc.5`** and the composer in Desktop or Web, in a managed profile. Other DSH versions and headless use are not supported by this beta. A configured model is required.

1. In DSH, enable the optional **Custom plugin indexes** bundle if **Discover** is not visible under **Plugins**.
2. Open **Plugins → Discover → Add index source** (or **Manage index sources…**) and paste:

   ```text
   https://raw.githubusercontent.com/Wordpost/dsh-composer-predictions/main/dsh-index.json
   ```

3. Select the index, search for **Composer predictions**, and choose **Install**. DSH shows the exact version and source before installing. This index is third-party and is not part of DSH's official catalog.

If you previously installed the local development bundle `@local/dsh-composer-predictions`, disable it before installing the beta. Do not run both copies in the same profile: they use the same composer slots and HTTP routes. You can turn off or remove the beta under **Plugins → Installed**.

## Use it

- **Next message.** After a live, completed reply, a suggestion may appear in the focused, empty composer. Background generation does not show a spinner or block typing. Press **Tab** or use the button beside it to insert an editable draft; clearing an accepted draft does not restore the suggestion. Press **Esc** or click **×** to dismiss that suggestion without changing the draft. Turn off **Settings → General → Automatic next-message suggestions** to use the sparkle button only on demand; the setting is saved in this browser or app and does not affect draft improvement. If the automatic attempt finds no useful suggestion, the sparkle offers one manual try. You can also use the sparkle in an older conversation with a completed reply; opening it does not call the model. If a model request fails, the toolbar shows the reason and allows a retry, up to three manual attempts total per reply. The plugin does not retry automatically.
- **Improve draft.** With a plain-text draft, click the wand beside the composer controls. Compare the original and revised text, then choose **Replace draft** or **Keep original**. A stale preview cannot overwrite an edited draft. Commands and inline references or quotes are not rewritten.

## Data and costs

The plugin calls your configured model provider through DSH. Automatic or manual next-message suggestions send the full final assistant reply and latest human request, plus up to four earlier whole visible text messages sharing a 5,000 UTF-16-code-unit budget. Long replies can take more input tokens; if the model rejects the context, the plugin does not silently truncate the reply or retry automatically. Draft improvement runs only when clicked and sends the draft (up to 2,000 code units) plus up to two original chat excerpts (up to 800 each). It does not send attachment bodies, reasoning blocks, or tool results. Provider retention policies and token charges still apply. The plugin has no separate service or telemetry endpoint and does not call tools, modify history, or send messages. Disable the bundle if you do not want these extra model calls.

## Development

Run `node --test` with Node.js 24, or install a checkout through **Plugins → Add plugin** using its absolute directory path. The [releases page](https://github.com/Wordpost/dsh-composer-predictions/releases) lists the public releases. Please report issues with your DSH version and a redacted reproduction; do not include private drafts or credentials.

Licensed under MIT. This project is not affiliated with DeepSeek.
