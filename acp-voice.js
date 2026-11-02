#!/usr/bin/env node
// acp-voice: sits between an ACP client and agent, passes stdio through untouched,
// and reads the agent's tool calls (counted: "Ran 2 commands, read 1 file.", or one line each) and/or
// its chat text aloud through any stdin-reading TTS command.
// `acp-voice hook` does the same for Claude Code via Stop/UserPromptSubmit (and PreToolUse, for live steps) hooks.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

const DEFAULTS = {
  speak: ['tool_calls'],
  tts: process.platform === 'darwin' ? 'say' : 'espeak --stdin',
  skip_code_blocks: true,
  max_chars: 400,
  interrupt_on_new_prompt: true,
}
const KINDS = { agent_message: 'agent_message_chunk', agent_thought: 'agent_thought_chunk', tool_calls: 'tool_call', tool_titles: 'tool_call' }
// ACP tool kinds -> [verb, singular, plural]
const TOOL_PHRASES = {
  execute: ['ran', 'command', 'commands'],
  read: ['read', 'file', 'files'],
  edit: ['edited', 'file', 'files'],
  delete: ['deleted', 'file', 'files'],
  move: ['moved', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  fetch: ['fetched', 'page', 'pages'],
  other: ['used', 'tool', 'tools'],
}
// Claude Code tool names -> ACP tool kinds, for hook mode
const CLAUDE_TOOL_KINDS = {
  Bash: 'execute', Read: 'read', Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit',
  Grep: 'search', Glob: 'search', WebSearch: 'search', WebFetch: 'fetch',
}
// Bookkeeping tools (todo list, desktop app task list/wrap-up) that aren't steps worth speaking
const SILENT_TOOLS = /^(TodoWrite|mcp__ccd_)/
const IDLE_FLUSH_MS = 800

// One spoken line per Claude Code tool call, like the step labels the app shows.
function claudeTitle({ name, input = {} }) {
  if (input.description) return input.description
  const file = input.file_path || input.notebook_path
  const f = file ? basename(file) : 'a file'
  switch (name) {
    case 'Bash': return 'Ran a command'
    case 'Read': return `Read ${f}`
    case 'Write': return `Wrote ${f}`
    case 'Edit': case 'MultiEdit': case 'NotebookEdit': return `Edited ${f}`
    case 'Grep': case 'Glob': return `Searched for ${input.pattern}`
    case 'WebSearch': return `Searched the web for ${input.query}`
    case 'WebFetch': return `Fetched ${(input.url ?? '').replace(/^https?:\/\//, '').split('/')[0]}`
    default: return `Used ${name.split('__').pop().replace(/_/g, ' ')}`
  }
}

// "Edit file" -> "Edit file.\n", so the speaker treats each title as its own sentence.
const sentence = (t) => t.trim().replace(/[.!?:]?$/, '.') + '\n'

function loadConfig() {
  const path = process.env.ACP_VOICE_CONFIG || join(homedir(), '.config', 'acp-voice', 'config.json')
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf8')) }
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`acp-voice: ignoring config ${path}: ${e.message}`)
    return DEFAULTS
  }
}

// ["execute", "execute", "read"] -> "Ran 2 commands, read 1 file.", in order of first use.
function summarize(kinds) {
  const counts = new Map()
  for (const k of kinds) { const key = TOOL_PHRASES[k] ? k : 'other'; counts.set(key, (counts.get(key) ?? 0) + 1) }
  const s = [...counts].map(([k, n]) => { const [verb, one, many] = TOOL_PHRASES[k]; return `${verb} ${n} ${n > 1 ? many : one}` }).join(', ')
  return s[0].toUpperCase() + s.slice(1) + '.'
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

// Text blocks ({text}), tool calls ({kind, title}) and desktop app wrap-up recaps ({recap}) of the current turn: everything after the last typed prompt.
// ponytail: rereads the whole transcript each turn, tail-read it if long sessions get slow
function lastTurn(transcriptPath) {
  let events = []
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    let m
    try { m = JSON.parse(line) } catch { continue }
    if (m.isSidechain || !m.message) continue
    const c = m.message.content
    if (m.type === 'user') {
      if (!Array.isArray(c) || !c.some((b) => b.type === 'tool_result')) events = []
    } else if (m.type === 'assistant' && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === 'text') events.push({ text: b.text })
        else if (b.type === 'tool_use' && /__wrap_up$/.test(b.name) && b.input?.recap) events.push({ recap: b.input.recap })
        else if (b.type === 'tool_use' && !SILENT_TOOLS.test(b.name)) events.push({ kind: CLAUDE_TOOL_KINDS[b.name] ?? 'other', title: claudeTitle(b) })
      }
    }
  }
  return events
}

// Claude Code hook. PreToolUse speaks each step as it starts; Stop speaks the final reply and wrap-up recap,
// plus the turn's steps if PreToolUse isn't hooked up; UserPromptSubmit silences everything queued.
// Speech goes through a spool file that one detached drainer reads, so the hook returns at once and
// a burst of steps becomes one TTS run (one model load for slow voices like Kokoro).
const SPOOL = join(tmpdir(), 'acp-voice-hook.spool')
const PID_FILE = join(tmpdir(), 'acp-voice-hook.pid')
const drainerPid = () => { try { const pid = Number(readFileSync(PID_FILE, 'utf8')); process.kill(pid, 0); return pid } catch {} }

function hook(cfg) {
  const input = JSON.parse(readFileSync(0, 'utf8'))
  const event = input.hook_event_name
  if (event === 'UserPromptSubmit') {
    if (!cfg.interrupt_on_new_prompt) return
    // ponytail: pid file can go stale, a reused pid would get SIGTERM; track start time if that ever bites
    const pid = drainerPid()
    if (pid) try { process.kill(-pid, 'SIGTERM') } catch {}
    for (const f of [SPOOL, PID_FILE]) try { unlinkSync(f) } catch {}
    return
  }
  const parts = []
  const speaker = createSpeaker(cfg, (s) => parts.push(s))
  const speak = new Set(cfg.speak)
  const anyTools = speak.has('tool_titles') || speak.has('tool_calls')
  const liveFile = join(tmpdir(), `acp-voice-live-${input.session_id}`)
  if (event === 'PreToolUse') {
    if (!anyTools || SILENT_TOOLS.test(input.tool_name)) return
    writeFileSync(liveFile, '') // tells Stop these steps were already spoken
    speaker.feed(sentence(claudeTitle({ name: input.tool_name, input: input.tool_input })))
  } else if (event === 'Stop') {
    const live = existsSync(liveFile)
    const titles = speak.has('tool_titles') && !live // one line per tool, instead of counts
    const turnTools = anyTools && !live
    const events = lastTurn(input.transcript_path)
    const lastTool = events.findLastIndex((e) => e.kind)
    const lastRecap = events.findLastIndex((e) => e.recap) // a failed wrap-up gets retried, speak only the last
    let group = []
    const flushGroup = () => { if (group.length) speaker.feed(summarize(group) + '\n'); group = [] }
    events.forEach((e, i) => {
      if (e.recap) { if (speak.has('recap') && i === lastRecap) { flushGroup(); speaker.feed(e.recap + '\n') } }
      else if (e.kind) { if (titles) speaker.feed(sentence(e.title)); else if (turnTools) group.push(e.kind) }
      // messages alone: just the final reply; with tool calls: the whole turn in order
      else if (speak.has('agent_message') && (turnTools || i > lastTool)) { flushGroup(); speaker.feed(e.text + '\n') }
    })
    flushGroup()
  } else return
  speaker.flush()
  if (!parts.length) return
  appendFileSync(SPOOL, parts.join(' ') + '\n')
  if (drainerPid()) return
  const drainer = spawn(process.execPath, [process.argv[1], 'drain'], { detached: true, stdio: 'ignore' })
  writeFileSync(PID_FILE, String(drainer.pid))
  drainer.unref()
}

// Detached: speaks everything spooled so far in one TTS run, repeats until the spool stays empty.
// ponytail: a hook landing between unlink and the final check can start a second drainer; harmless overlap
function drain(cfg) {
  const taken = SPOOL + '.' + process.pid
  for (;;) {
    let text = ''
    try { renameSync(SPOOL, taken); text = readFileSync(taken, 'utf8'); unlinkSync(taken) } catch {}
    if (text.trim()) { spawnSync(cfg.tts, { shell: true, input: text.trim().replace(/\n/g, ' '), stdio: ['pipe', 'ignore', 'ignore'] }); continue }
    try { unlinkSync(PID_FILE) } catch {}
    if (!existsSync(SPOOL)) return
    writeFileSync(PID_FILE, String(process.pid))
  }
}

const cfg = loadConfig()
if (process.argv[2] === 'hook') {
  hook(cfg)
} else if (process.argv[2] === 'drain') {
  drain(cfg)
} else {
  proxy(cfg)
}

function proxy(cfg) {
  const sep = process.argv.indexOf('--')
  const [cmd, ...args] = process.argv.slice(sep < 0 ? 2 : sep + 1)
  if (!cmd) {
    console.error('usage: acp-voice -- <agent command> [args...]\n       acp-voice hook   (Claude Code Stop/UserPromptSubmit hook)')
    process.exit(2)
  }

  const kinds = new Set(cfg.speak.map((k) => KINDS[k] ?? k))
  const titles = cfg.speak.includes('tool_titles')
  const voice = createVoice(cfg.tts)
  const speaker = createSpeaker(cfg, voice.say)
  const tools = [] // kinds of tool calls since the last message text
  const flushTools = () => { if (tools.length) speaker.feed(summarize(tools.splice(0)) + '\n') }
  const flushAll = () => { flushTools(); speaker.flush() }
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
    tools.length = 0
  })

  onMessages(agent.stdout, (msg) => {
    const u = msg.method === 'session/update' && msg.params?.update
    if (!u || !kinds.has(u.sessionUpdate)) return
    if (u.sessionUpdate === 'tool_call') { speaker.flush(); if (titles) speaker.feed(sentence(u.title || 'Used a tool')); else tools.push(u.kind) }
    else if (u.content?.type === 'text') { flushTools(); speaker.feed(u.content.text) }
    else return
    clearTimeout(idle)
    // ponytail: a pause groups tool calls, so slow back-to-back calls are spoken one by one
    idle = setTimeout(flushAll, IDLE_FLUSH_MS)
  })

  agent.on('exit', (code, signal) => {
    clearTimeout(idle)
    flushAll()
    process.stdin.destroy()
    process.exitCode = code ?? (signal ? 1 : 0)
    // node exits once queued speech finishes
  })

  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { voice.stop(); agent.kill(sig) })
}
