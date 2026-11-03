# acp-voice

Hear your coding agent while you look at something else.

`acp-voice` wraps any [Agent Client Protocol](https://agentclientprotocol.com) agent. It passes every message between your editor and the agent through unchanged, and narrates what the agent is doing, in the style of the step lines agent UIs print: "Ran 2 commands, read 3 files." It can read the agent's chat text aloud too, without code blocks.

## Quick start

```sh
npx -y acp-voice setup
```

This shows a list of voices to pick from, installs the one you choose (Kokoro is set up for you), plays a sample and saves your choice. It then offers to add the Claude Code hooks for you. You can also skip the list by naming a voice, for example `npx -y acp-voice setup kokoro:bf_emma` or `npx -y acp-voice setup say`.

## ACP editors (Zed and others)

Put `acp-voice --` in front of the agent command in your editor's config. For Zed:

```json
{
  "agent_servers": {
    "Claude Code (voice)": {
      "command": "npx",
      "args": ["-y", "acp-voice", "--", "npx", "-y", "@agentclientprotocol/claude-agent-acp"]
    }
  }
}
```

The same pattern works for any ACP client and agent.

### Try it without an editor

`demo.mjs` is a tiny ACP client. It sends one prompt to Claude through acp-voice, prints the reply and speaks it:

```sh
node demo.mjs "Explain what a monad is in two sentences."
```

It denies any tool permission requests. To try a different agent, add `-- <agent command>`.

## Claude Code (CLI, desktop app, IDE extensions)

Claude Code doesn't need ACP. `acp-voice hook` uses its [hooks](https://docs.claude.com/en/docs/claude-code/hooks) instead: when Claude finishes a turn, it speaks that turn's steps (or the final reply, if configured). When you send a new message, it stops talking. `acp-voice setup` can add the hooks for you, or add them to `~/.claude/settings.json` yourself:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y acp-voice hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx -y acp-voice hook" }] }]
  }
}
```

To hear each step as it starts instead of all at once at the end, also add a `PreToolUse` hook with the same command. Stop then speaks only the final reply, if `agent_message` is on. Steps that come in quick succession are queued and spoken in one TTS run, so a slow voice falls behind less.

It uses the same config as the proxy. The difference is timing: the proxy speaks while the agent works, and the hook speaks once the turn is finished.

## Configure

Optional. Create `~/.config/acp-voice/config.json`, or point `ACP_VOICE_CONFIG` at a file elsewhere:

```json
{
  "speak": ["tool_calls"],
  "voice": "kokoro:af_heart",
  "skip_code_blocks": true,
  "max_chars": 400,
  "interrupt_on_new_prompt": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `speak` | `["tool_calls"]` | What to read. `"tool_calls"`: step summaries like "Ran 2 commands, edited 1 file." `"tool_titles"`: one line per step instead, like "Read package.json." or the command's description (raise `max_chars` for long turns). `"agent_message"`: the agent's chat text (in the hook, just the final reply unless `"tool_calls"` is also on). `"agent_thought"`: its reasoning (proxy only). `"recap"`: the short end-of-turn recap the Claude desktop app's Code tab has Claude write (hook only). |
| `voice` | none | `say`, `espeak` or `kokoro`, optionally followed by `:<voice name>`, for example `say:Ava (Premium)` or `kokoro:am_michael`. Kokoro voices: `af_heart`, `af_bella`, `af_nicole`, `am_michael`, `am_adam`, `bf_emma`, `bm_george`. Set by `acp-voice setup`. |
| `tts` | `say` (macOS), `espeak --stdin` (Linux) | Any shell command that reads text on stdin. Overrides `voice`. Use it for engines acp-voice doesn't know about. |
| `skip_code_blocks` | `true` | Don't read fenced code. |
| `max_chars` | `400` | Stop talking after this many characters per turn. |
| `interrupt_on_new_prompt` | `true` | Go quiet when you send a new message or cancel. |

### Voices

- **[Kokoro](https://github.com/thewh1teagle/kokoro-onnx)** sounds natural and runs on your machine. `acp-voice setup kokoro` installs it with [uv](https://docs.astral.sh/uv/) into `~/.local/share/acp-voice/kokoro` (about 340 MB). It takes a few seconds to start speaking, so it works best with the Claude Code hook. With the proxy, each sentence reloads the model.
- **`say`** (macOS) and **`espeak`** (Linux) start instantly but sound robotic. macOS Premium voices, which you download in System Settings → Accessibility → Spoken Content, sound much better.
- **Anything else** goes in `tts`, for example [Piper](https://github.com/rhasspy/piper) (`piper --model en_US-amy-medium.onnx --output-raw | aplay -r 22050 -f S16_LE -t raw -`) or a small script that sends text to a cloud TTS service and plays the audio.

## Develop

```sh
npm test
```

No dependencies. All the code is in `acp-voice.js`, plus `tts/kokoro.py` for the Kokoro voice.

## License

MIT
