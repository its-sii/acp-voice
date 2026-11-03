#!/usr/bin/env node
// acp-voice: sits between an ACP client and agent, passes stdio through untouched,
// and reads the agent's tool calls (counted: "Ran 2 commands, read 1 file.", or one line each) and/or
// its chat text aloud through any stdin-reading TTS command.
// `acp-voice hook` does the same for Claude Code via Stop/UserPromptSubmit (and PreToolUse, for live steps) hooks.
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { createInterface } from 'node:readline/promises'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'

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

const CONFIG_PATH = process.env.ACP_VOICE_CONFIG || join(homedir(), '.config', 'acp-voice', 'config.json')
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`

// "say", "say:Ava (Premium)", "espeak:en-gb", "kokoro", "kokoro:bf_emma" -> shell command reading stdin.
// Resolved at every run, so kokoro follows wherever this script lives (npx cache, global install, checkout).
function voiceCommand(voice) {
  const [engine, name] = [voice.split(':')[0], voice.split(':').slice(1).join(':')]
  if (engine === 'say') return name ? `say -v ${shq(name)}` : 'say'
  if (engine === 'espeak') return name ? `espeak --stdin -v ${shq(name)}` : 'espeak --stdin'
  if (engine === 'kokoro') return `${shq(process.execPath)} ${shq(process.argv[1])} kokoro --voice ${shq(name || 'af_heart')}`
  return null
}

function loadConfig() {
  let user = {}
  try {
    user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`acp-voice: ignoring config ${CONFIG_PATH}: ${e.message}`)
  }
  const fromVoice = !user.tts && user.voice && voiceCommand(user.voice)
  if (user.voice && !user.tts && !fromVoice) console.error(`acp-voice: unknown voice "${user.voice}", using the default`)
  return { ...DEFAULTS, ...user, ...(fromVoice && { tts: fromVoice }) }
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

const KOKORO_DIR = process.env.KOKORO_DIR || join(homedir(), '.local', 'share', 'acp-voice', 'kokoro')
const KOKORO_PY = join(KOKORO_DIR, 'venv', 'bin', 'python') // ponytail: POSIX venv layout, Windows needs Scripts\python.exe
const KOKORO_FILES = ['kokoro-v1.0.onnx', 'voices-v1.0.bin']
const KOKORO_URL = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/'

// `acp-voice kokoro [--voice v]`: speak stdin with Kokoro. Installed by `acp-voice setup kokoro`.
function runKokoro(args) {
  if (!existsSync(KOKORO_PY) || !KOKORO_FILES.every((f) => existsSync(join(KOKORO_DIR, f)))) {
    console.error('acp-voice: Kokoro is not set up yet, run: npx -y acp-voice setup kokoro')
    process.exit(1)
  }
  const py = spawn(KOKORO_PY, [fileURLToPath(new URL('tts/kokoro.py', import.meta.url)), ...args], { stdio: 'inherit' })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => py.kill(sig))
  py.on('exit', (code) => process.exit(code ?? 1))
}

// Idempotent: skips whatever is already in place. Needs uv for the Python side.
async function installKokoro() {
  const run = (cmd, a) => {
    if (spawnSync(cmd, a, { stdio: 'inherit' }).status !== 0) throw new Error(`${cmd} ${a.join(' ')} failed`)
  }
  mkdirSync(KOKORO_DIR, { recursive: true })
  if (!(existsSync(KOKORO_PY) && spawnSync(KOKORO_PY, ['-c', 'import kokoro_onnx']).status === 0)) {
    if (spawnSync('uv', ['--version']).error) throw new Error('Kokoro needs uv, see https://docs.astral.sh/uv/getting-started/installation/')
    console.log('Installing Kokoro...')
    // 3.12: onnxruntime wheels lag behind the newest Python
    if (!existsSync(KOKORO_PY)) run('uv', ['venv', '-q', '--python', '3.12', join(KOKORO_DIR, 'venv')])
    run('uv', ['pip', 'install', '-q', '--python', KOKORO_PY, 'kokoro-onnx'])
  }
  for (const f of KOKORO_FILES) {
    const dest = join(KOKORO_DIR, f)
    if (existsSync(dest)) continue
    console.log(`Downloading ${f} (${f.endsWith('.onnx') ? '310' : '27'} MB)...`)
    const res = await fetch(KOKORO_URL + f)
    if (!res.ok) throw new Error(`downloading ${f}: HTTP ${res.status}`)
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest + '.part'))
    renameSync(dest + '.part', dest) // a cut-off download never looks finished
  }
}

const VOICES = [
  ['kokoro:af_heart', 'Kokoro, natural US female voice (local, ~340 MB download, needs uv)'],
  ['kokoro:am_michael', 'Kokoro, US male'],
  ['kokoro:bf_emma', 'Kokoro, UK female'],
  ['kokoro:bm_george', 'Kokoro, UK male'],
  ...(process.platform === 'darwin'
    ? [['say', 'macOS system voice (instant, robotic)'],
       ['say:Ava (Premium)', 'macOS Premium voice (download it in System Settings > Accessibility > Spoken Content)']]
    : [['espeak', 'eSpeak (instant, robotic)']]),
]

// `acp-voice setup [voice]`: install the voice, save it to the config, offer the Claude Code hooks.
async function setup(arg) {
  const rl = process.stdin.isTTY && createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (q, def) => (rl ? (await rl.question(q)).trim() : '') || def
  let voice = arg
  if (!voice) {
    if (!rl) throw new Error('usage: acp-voice setup <voice>, e.g. kokoro:af_heart or say')
    console.log('Pick a voice (or type any say:<name>, espeak:<name>, kokoro:<name>):')
    VOICES.forEach(([v, d], i) => console.log(`  ${i + 1}) ${v.padEnd(18)} ${d}`))
    const pick = await ask('Voice [1]: ', '1')
    voice = VOICES[Number(pick) - 1]?.[0] ?? pick
  }
  if (!voiceCommand(voice)) throw new Error(`unknown voice "${voice}": use say, espeak or kokoro, optionally with :<name>`)
  if (voice.startsWith('kokoro')) await installKokoro()

  const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {}
  if (config.tts) console.log(`Replacing your custom "tts": ${config.tts}`)
  delete config.tts
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, voice }, null, 2) + '\n')
  console.log(`Saved voice "${voice}" to ${CONFIG_PATH}`)
  if (rl) spawnSync(voiceCommand(voice), { shell: true, input: 'This is how acp-voice sounds.', stdio: ['pipe', 'inherit', 'inherit'] })

  const settings = join(homedir(), '.claude', 'settings.json')
  if (rl && existsSync(dirname(settings)) && !/^n/i.test(await ask('Add Claude Code hooks to ~/.claude/settings.json? [Y/n] ', 'y'))) addHooks(settings)
  if (rl) rl.close()
}

// Adds Stop + UserPromptSubmit hooks unless an acp-voice hook is already there; backs up first.
function addHooks(path) {
  const s = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
  // npx cache paths change between versions, so npx installs get the npx command
  const command = process.argv[1].includes('/_npx/') ? 'npx -y acp-voice hook' : `${shq(process.execPath)} ${shq(process.argv[1])} hook`
  s.hooks ??= {}
  const added = []
  for (const event of ['Stop', 'UserPromptSubmit']) {
    const list = (s.hooks[event] ??= [])
    if (JSON.stringify(list).includes('acp-voice')) continue
    list.push({ hooks: [{ type: 'command', command }] })
    added.push(event)
  }
  if (!added.length) return console.log('Claude Code hooks are already set up.')
  if (existsSync(path)) copyFileSync(path, path + '.bak')
  writeFileSync(path, JSON.stringify(s, null, 2) + '\n')
  console.log(`Added ${added.join(' and ')} hooks (old settings saved as settings.json.bak). New Claude Code sessions will talk.`)
}

const cfg = loadConfig()
const fail = (e) => { console.error(`acp-voice: ${e.message}`); process.exit(1) }
if (process.argv[2] === 'hook') {
  hook(cfg)
} else if (process.argv[2] === 'drain') {
  drain(cfg)
} else if (process.argv[2] === 'kokoro') {
  runKokoro(process.argv.slice(3))
} else if (process.argv[2] === 'setup') {
  setup(process.argv[3]).catch(fail)
} else {
  proxy(cfg)
}

function proxy(cfg) {
  const sep = process.argv.indexOf('--')
  const [cmd, ...args] = process.argv.slice(sep < 0 ? 2 : sep + 1)
  if (!cmd) {
    console.error(`usage: acp-voice -- <agent command> [args...]
       acp-voice hook                 (Claude Code Stop/UserPromptSubmit/PreToolUse hook)
       acp-voice setup [voice]        (pick and install a voice, add Claude Code hooks)`)
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
