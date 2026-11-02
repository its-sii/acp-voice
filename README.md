# acp-voice

Hear your coding agent while you look at something else.

`acp-voice` wraps any [Agent Client Protocol](https://agentclientprotocol.com) agent. It passes every message between your editor and the agent through unchanged, and reads the agent's chat text aloud: no diffs, no tool calls, no code blocks.

## Use

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

Claude Code doesn't need ACP. `acp-voice hook` uses its [hooks](https://docs.claude.com/en/docs/claude-code/hooks) instead: when Claude finishes a turn, it speaks the final reply. When you send a new message, it stops talking. Add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{ "type": "command", "command": "npx -y acp-voice hook" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "npx -y acp-voice hook" }] }]
  }
}
```

It uses the same config as the proxy. The difference is timing: the proxy speaks while the agent streams its reply, and the hook speaks once the reply is finished.

## Configure

Optional. Create `~/.config/acp-voice/config.json`, or point `ACP_VOICE_CONFIG` at a file elsewhere:

```json
{
  "speak": ["agent_message"],
  "tts": "say -r 210",
  "skip_code_blocks": true,
  "max_chars": 400,
  "interrupt_on_new_prompt": true
}
```

| Key | Default | Meaning |
|---|---|---|
| `speak` | `["agent_message"]` | Which updates to read. Add `"agent_thought"` to hear the agent's reasoning too. |
| `tts` | `say` (macOS), `espeak --stdin` (Linux) | Shell command that receives each sentence on stdin. |
| `skip_code_blocks` | `true` | Don't read fenced code. |
| `max_chars` | `400` | Stop talking after this many characters per turn. |
| `interrupt_on_new_prompt` | `true` | Go quiet when you send a new message or cancel. |

### TTS examples

Any command that reads text from stdin works:

- macOS: `say -v Samantha -r 200`
- Linux: `espeak --stdin`, or [Piper](https://github.com/rhasspy/piper): `piper --model en_US-amy-medium.onnx --output-raw | aplay -r 22050 -f S16_LE -t raw -`
- [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), a natural-sounding local neural voice: see [`tts/kokoro.py`](tts/kokoro.py) for setup. It works best with the Claude Code hook. With the proxy, each sentence reloads the model, which takes a few seconds.
- Cloud: wrap your provider's CLI in a small script that reads stdin and plays the audio.

## Develop

```sh
npm test
```

No dependencies. All the code is in `acp-voice.js`.

## License

MIT
