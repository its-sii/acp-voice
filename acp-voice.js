#!/usr/bin/env node
// acp-voice: sits between an ACP client and agent, passes stdio through untouched,
// and reads the agent's chat text aloud through any stdin-reading TTS command.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const DEFAULTS = {
  speak: ['agent_message'],
  tts: process.platform === 'darwin' ? 'say' : 'espeak --stdin',
  skip_code_blocks: true,
  max_chars: 400,
  interrupt_on_new_prompt: true,
}
const KINDS = { agent_message: 'agent_message_chunk', agent_thought: 'agent_thought_chunk' }
const IDLE_FLUSH_MS = 800

function loadConfig() {
  const path = process.env.ACP_VOICE_CONFIG || join(homedir(), '.config', 'acp-voice', 'config.json')
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`acp-voice: ignoring config ${path}: ${e.message}`)
    return DEFAULTS
  }
}

// Serial queue: one TTS process at a time, text written to its stdin.
function createVoice(cmd) {
  const queue = []
  let current = null
  const next = () => {
    if (current || !queue.length) return
    current = spawn(cmd, { shell: true, stdio: ['pipe', 'ignore', 'inherit'] })
    current.on('error', (e) => console.error(`acp-voice: tts failed: ${e.message}`))
    current.on('exit', () => { current = null; next() })
    current.stdin.on('error', () => {})
    current.stdin.end(queue.shift())
  }
  return {
    say: (text) => { queue.push(text); next() },
    stop: () => { queue.length = 0; current?.kill() },
  }
}

// Turns streamed chunks into whole sentences, dropping ``` code blocks if configured.
function createSpeaker(cfg, say) {
  let buf = '', inCode = false, spoken = 0
  const emit = (s) => {
    s = s.replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim()
    if (!/\w/.test(s) || spoken >= cfg.max_chars) return // \w: skip empty and --- rules
    spoken += s.length
    say(s)
  }
  const drain = (force) => {
    for (;;) {
      const fence = cfg.skip_code_blocks ? buf.indexOf('```') : -1
      if (inCode) {
        // keep 2 chars in case a closing fence is split across chunks
        if (fence < 0) { buf = force ? '' : buf.slice(-2); return }
        buf = buf.slice(fence + 3); inCode = false; continue
      }
      const end = buf.search(/[.!?]\s|\n/)
      if (fence >= 0 && (end < 0 || fence < end)) { emit(buf.slice(0, fence)); buf = buf.slice(fence + 3); inCode = true; continue }
      if (end >= 0) { emit(buf.slice(0, end + 1)); buf = buf.slice(end + 1); continue }
      if (force) { emit(buf); buf = '' }
      return
    }
  }
  return {
    feed: (text) => { buf += text; drain(false) },
    flush: () => drain(true),
    reset: () => { buf = ''; inCode = false; spoken = 0 },
  }
}

// Calls fn for each newline-delimited JSON message without consuming the stream.
function onMessages(stream, fn) {
  const dec = new StringDecoder('utf8')
  let rest = ''
  stream.on('data', (chunk) => {
    const lines = (rest + dec.write(chunk)).split('\n')
    rest = lines.pop()
    for (const line of lines) {
      let msg
      try { msg = JSON.parse(line) } catch { continue }
      fn(msg)
    }
  })
}

const sep = process.argv.indexOf('--')
const [cmd, ...args] = process.argv.slice(sep < 0 ? 2 : sep + 1)
if (!cmd) {
  console.error('usage: acp-voice -- <agent command> [args...]')
  process.exit(2)
}

const cfg = loadConfig()
const kinds = new Set(cfg.speak.map((k) => KINDS[k] ?? k))
const voice = createVoice(cfg.tts)
const speaker = createSpeaker(cfg, voice.say)
let idle

const agent = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] })
agent.on('error', (e) => { console.error(`acp-voice: cannot start ${cmd}: ${e.message}`); process.exit(1) })
agent.stdin.on('error', () => {})
process.stdin.pipe(agent.stdin)
agent.stdout.pipe(process.stdout)

onMessages(process.stdin, (msg) => {
  if (msg.method !== 'session/prompt' && msg.method !== 'session/cancel') return
  if (cfg.interrupt_on_new_prompt) voice.stop()
  speaker.reset()
})

onMessages(agent.stdout, (msg) => {
  const u = msg.method === 'session/update' && msg.params?.update
  if (!u || !kinds.has(u.sessionUpdate) || u.content?.type !== 'text') return
  speaker.feed(u.content.text)
  clearTimeout(idle)
  idle = setTimeout(speaker.flush, IDLE_FLUSH_MS)
})

agent.on('exit', (code, signal) => {
  clearTimeout(idle)
  speaker.flush()
  process.stdin.destroy()
  process.exitCode = code ?? (signal ? 1 : 0)
  // node exits once queued speech finishes
})

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { voice.stop(); agent.kill(sig) })
