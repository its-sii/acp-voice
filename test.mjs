// End-to-end: fake ACP agent behind the proxy, TTS swapped for a file append.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'acp-voice-'))
const spoken = join(dir, 'spoken.txt')
const config = join(dir, 'config.json')
writeFileSync(config, JSON.stringify({ speak: ['agent_message', 'tool_calls'], tts: `cat >> '${spoken}'; echo >> '${spoken}'` }))

const update = (sessionUpdate, text) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate, content: { type: 'text', text } } } })
const toolCall = (kind) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'x', kind } } })
const agentOutput = [
  update('agent_thought_chunk', 'Thinking quietly. '),
  update('agent_message_chunk', 'Hel'),
  update('agent_message_chunk', 'lo **there**. Here is `code`:\n``'),
  update('agent_message_chunk', '`js\nconst x = 1.\n``'),
  update('agent_message_chunk', '`\n---\nDone'),
  toolCall('execute'), toolCall('edit'), toolCall('execute'),
  JSON.stringify({ jsonrpc: '2.0', id: 1, result: { stopReason: 'end_turn' } }),
].join('\n') + '\n'

// Agent replies only after the prompt arrives, like a real one.
const fakeAgent = `process.stdin.once('data', () => { process.stdout.write(${JSON.stringify(agentOutput)}); process.exit(0) })`
const prompt = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { sessionId: 's', prompt: [] } }) + '\n'

const out = execFileSync('node', ['acp-voice.js', '--', 'node', '-e', fakeAgent], {
  input: prompt,
  env: { ...process.env, ACP_VOICE_CONFIG: config },
}).toString()

assert.equal(out, agentOutput, 'agent stdout must pass through byte-for-byte')
assert.deepEqual(readFileSync(spoken, 'utf8').trim().split('\n'), ['Hello there.', 'Here is code:', 'Done', 'Ran 2 commands, edited 1 file.'])

// Hook mode: only the turn after the last typed prompt is spoken, through a detached drainer.
const entry = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra })
const transcript = join(dir, 'transcript.jsonl')
writeFileSync(transcript, [
  entry('user', 'first question'),
  entry('assistant', [{ type: 'text', text: 'Old reply.' }, { type: 'tool_use', id: 'o', name: 'Edit', input: {} }]),
  entry('user', 'second question'),
  entry('assistant', [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls', description: 'List files' } }, { type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/repo/package.json' } }, { type: 'tool_use', id: 'w', name: 'TodoWrite', input: {} }]),
  entry('user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
  entry('assistant', [{ type: 'text', text: 'Subagent noise.' }], { isSidechain: true }),
  entry('assistant', [{ type: 'thinking', thinking: 'hmm' }]),
  entry('assistant', [{ type: 'text', text: 'All **done**.\n```sh\nnpm test\n```\nBye' }]),
].join('\n') + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const hookEvent = (event) => execFileSync('node', ['acp-voice.js', 'hook'], {
  input: JSON.stringify({ transcript_path: transcript, session_id: 's', ...event }),
  env: { ...process.env, ACP_VOICE_CONFIG: config, TMPDIR: dir },
})
// Waits for the drainer to finish, so the next run can't be spoken with this run's config.
const drained = async () => { for (let i = 0; i < 100 && existsSync(join(dir, 'acp-voice-hook.pid')); i++) await sleep(20) }
async function runHook(speak, name) {
  const hookSpoken = join(dir, name)
  writeFileSync(config, JSON.stringify({ ...(speak && { speak }), tts: `cat > '${hookSpoken}'` }))
  hookEvent({ hook_event_name: 'Stop', session_id: 'end-only' })
  await drained()
  return readFileSync(hookSpoken, { flag: 'a+' }).toString()
}
assert.equal(await runHook(undefined, 'default.txt'), 'Ran 1 command, read 1 file.')
assert.equal(await runHook(['agent_message'], 'reply.txt'), 'All done. Bye')
assert.equal(await runHook(['agent_message', 'tool_calls'], 'both.txt'), 'Checking. Ran 1 command, read 1 file. All done. Bye')
assert.equal(await runHook(['tool_titles'], 'titles.txt'), 'List files. Read package.json.')

// Live steps: PreToolUse lines play in order without overlapping (slow TTS, so later ones get batched),
// then Stop adds only the final reply instead of repeating the steps.
const live = join(dir, 'live.txt')
writeFileSync(config, JSON.stringify({ speak: ['tool_titles', 'agent_message'], tts: `sleep 0.2; cat >> '${live}'; echo >> '${live}'` }))
hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run tests' } })
hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'TodoWrite', tool_input: {} })
hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/a.js' } })
hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/r/b.js' } })
hookEvent({ hook_event_name: 'Stop' })
await drained()
const lines = readFileSync(live, 'utf8').trim().split('\n')
assert.equal(lines.join(' '), 'Run tests. Read a.js. Edited b.js. All done. Bye')
assert.ok(lines.length < 4, `expected batching, got ${lines.length} TTS runs`)

// A new prompt silences queued speech.
writeFileSync(config, JSON.stringify({ speak: ['tool_titles'], tts: `sleep 0.5; cat >> '${live}'` }))
hookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/r/late.js' } })
hookEvent({ hook_event_name: 'UserPromptSubmit' })
await sleep(800)
assert.ok(!readFileSync(live, 'utf8').includes('late'), 'interrupted speech must not play')
console.log('ok')
