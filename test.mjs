// End-to-end: fake ACP agent behind the proxy, TTS swapped for a file append.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'acp-voice-'))
const spoken = join(dir, 'spoken.txt')
const config = join(dir, 'config.json')
writeFileSync(config, JSON.stringify({ tts: `cat >> '${spoken}'; echo >> '${spoken}'` }))

const update = (sessionUpdate, text) =>
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate, content: { type: 'text', text } } } })
const agentOutput = [
  update('agent_thought_chunk', 'Thinking quietly. '),
  update('agent_message_chunk', 'Hel'),
  update('agent_message_chunk', 'lo **there**. Here is `code`:\n``'),
  update('agent_message_chunk', '`js\nconst x = 1.\n``'),
  update('agent_message_chunk', '`\n---\nDone'),
  JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Edit file' } } }),
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
assert.deepEqual(readFileSync(spoken, 'utf8').trim().split('\n'), ['Hello there.', 'Here is code:', 'Done'])

// Hook mode: only the reply after the last user/tool-result entry is spoken, in one detached TTS run.
const hookSpoken = join(dir, 'hook.txt')
writeFileSync(config, JSON.stringify({ tts: `cat > '${hookSpoken}'` }))
const entry = (type, content, extra = {}) => JSON.stringify({ type, message: { role: type, content }, ...extra })
const transcript = join(dir, 'transcript.jsonl')
writeFileSync(transcript, [
  entry('user', 'first question'),
  entry('assistant', [{ type: 'text', text: 'Old reply.' }]),
  entry('user', 'second question'),
  entry('assistant', [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }]),
  entry('user', [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
  entry('assistant', [{ type: 'text', text: 'Subagent noise.' }], { isSidechain: true }),
  entry('assistant', [{ type: 'thinking', thinking: 'hmm' }]),
  entry('assistant', [{ type: 'text', text: 'All **done**.\n```sh\nnpm test\n```\nBye' }]),
].join('\n') + '\n')
execFileSync('node', ['acp-voice.js', 'hook'], {
  input: JSON.stringify({ hook_event_name: 'Stop', transcript_path: transcript }),
  env: { ...process.env, ACP_VOICE_CONFIG: config, TMPDIR: dir },
})
for (let i = 0; i < 50 && !readFileSync(hookSpoken, { flag: 'a+' }).length; i++) await new Promise((r) => setTimeout(r, 20))
assert.equal(readFileSync(hookSpoken, 'utf8'), 'All done. Bye')
console.log('ok')
