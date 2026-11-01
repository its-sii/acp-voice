// Minimal ACP client for trying acp-voice without an editor:
//   node demo.mjs "your prompt" [-- agent command...]
// Sends one prompt, prints the reply, denies any tool permission requests.
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

const sep = process.argv.indexOf('--')
const text = process.argv[2] && sep !== 2 ? process.argv[2] : 'In three sentences, say hello and explain what you can help with.'
const agentCmd = sep < 0 ? ['npx', '-y', '@agentclientprotocol/claude-agent-acp'] : process.argv.slice(sep + 1)

const proc = spawn('node', [new URL('acp-voice.js', import.meta.url).pathname, '--', ...agentCmd], { stdio: ['pipe', 'pipe', 'inherit'] })
let nextId = 0
const pending = new Map()
const send = (msg) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const request = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextId
  pending.set(id, { resolve, reject })
  send({ id, method, params })
})

createInterface({ input: proc.stdout }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (pending.has(msg.id) && !msg.method) {
    const p = pending.get(msg.id); pending.delete(msg.id)
    return msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
  if (msg.method === 'session/request_permission') return send({ id: msg.id, result: { outcome: { outcome: 'cancelled' } } })
  if (msg.id !== undefined && msg.method) return send({ id: msg.id, error: { code: -32601, message: 'not supported by demo' } })
  const u = msg.params?.update
  if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') process.stdout.write(u.content.text)
})

try {
  await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await request('session/new', { cwd: process.cwd(), mcpServers: [] })
  const { stopReason } = await request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  console.log(`\n[${stopReason}]`)
} catch (e) {
  console.error(`demo: ${e.message}`)
  process.exitCode = 1
}
proc.stdin.end()
