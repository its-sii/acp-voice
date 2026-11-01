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
  update('agent_message_chunk', '`\nDone'),
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
console.log('ok')
