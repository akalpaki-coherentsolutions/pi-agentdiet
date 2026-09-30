# AgentDiet for Pi

AgentDiet reduces the tool-result context carried forward by a Pi coding session. It leaves the raw session history intact and appends context edits, so session exports and billing data retain the original tool output.

It has two reduction paths:

- Replaces an older file read after Pi has made a later full read of the same path.
- Uses a reflector model to shorten eligible, older tool results while preserving the details needed for later work, including source URLs, titles, and supported claims from `web_search`.

The extension starts disabled. It currently runs only with Pi's `openai-codex` provider. The default reflector is `openai-codex/gpt-5.6-luna`.

## Install

Clone this repository into Pi's user extension directory:

```bash
git clone git@github.com:akalpaki-coherentsolutions/pi-agentdiet.git ~/.pi/agent/extensions/agentdiet
```

Restart Pi or run `/reload`, then enable it:

```text
/diet on
```

Use `/diet status` to inspect its configuration and per-process savings. Settings live in `~/.pi/agent/agentdiet.json`.

## Configuration

```text
/diet set a 2
/diet set b 1
/diet set theta 500
/diet set model openai-codex/gpt-5.6-luna
```

`a` is the number of later steps before the extension considers a step. `b` is the number of earlier neighbouring steps supplied to the reflector. `theta` is the minimum eligible tool-result size in tokens. `read`, `edit`, and `write` results stay verbatim. Other text results, including `web_search`, are eligible for reflection.

AgentDiet reports removed context tokens. They are not guaranteed dollar savings because Pi only bills a token when a later request sends it. Reflector calls do incur cost. Pair it with [Pi Telemetry](https://github.com/akalpaki-coherentsolutions/pi-telemetry) to persist those costs and savings across sessions.

## Tests

```bash
./run-tests.sh
```

The unit tests run with stub Pi modules. If `tsc` and Pi's package directory are available, the script typechecks too. Set `PI_CODING_AGENT_PACKAGE_DIR` when Pi is installed outside the global npm directory.
