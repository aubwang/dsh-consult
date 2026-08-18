#!/usr/bin/env node
/**
 * A minimal ACP agent that plays the delegate in the full-loop drill.
 *
 * It is registered as a real consult profile and driven by the real broker over
 * real JSON-RPC stdio, so nothing about the transport is simulated — only the
 * model is. Modelled on the sessions mode of consult's own
 * `scripts/lib/__fixtures__/fake-acp-agent.mts`, trimmed to the one scenario
 * this drill needs.
 *
 * The scenario, in three beats:
 *
 *  1. FIRST `session/prompt`: emit a chunk, shell out to `consult report --type
 *     blocked`, then leave the turn OPEN. The job id and workspace reach this
 *     process automatically through CONSULT_PARENT_JOB / CONSULT_WORKSPACE, and
 *     CONSULT_DATA_DIR is inherited; the consult binary arrives through the
 *     profile record's own `env` as DRILL_CONSULT_BIN.
 *  2. `session/cancel`: answer the open prompt with `cancelled` immediately.
 *     A steer is a cancel-then-re-prompt, and the broker gives the agent a
 *     2 s ack window — miss it and the steer is withdrawn instead of delivered.
 *  3. SECOND `session/prompt` (the steer continuation): echo the supervisor's
 *     guidance back verbatim in a final chunk and end the turn, so the drill can
 *     prove the guidance actually reached the model.
 *
 * stdin is read asynchronously rather than with a blocking `readSync` loop, so
 * the `consult report` subprocess cannot delay the cancel ack.
 */

import { spawn } from 'node:child_process'

const PROTOCOL_VERSION = 1
const GUIDANCE_START = '--- BEGIN CONSULT SUPERVISOR GUIDANCE ---'
const GUIDANCE_END = '--- END CONSULT SUPERVISOR GUIDANCE ---'
const REPORT_MESSAGE = 'need supervisor guidance: which approach?'

let promptCount = 0
/** The in-flight prompt whose turn `session/cancel` must settle. */
let openPrompt = null

const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

const chunk = (sessionId, text) => write({
  jsonrpc: '2.0',
  method: 'session/update',
  params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } },
})

const agentIdentity = {
  protocolVersion: PROTOCOL_VERSION,
  agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
  agentInfo: { name: 'dsh-consult-drill-delegate', version: '1.0.0' },
}

/** Flatten an ACP prompt's content blocks into one string. */
function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : []
  return blocks.map((block) => (typeof block?.text === 'string' ? block.text : '')).join('\n')
}

/** The supervisor's guidance, as consult delimits it inside the re-prompt. */
function guidanceOf(text) {
  const start = text.indexOf(GUIDANCE_START)
  const end = text.indexOf(GUIDANCE_END)
  if (start === -1 || end === -1 || end < start) return undefined
  return text.slice(start + GUIDANCE_START.length, end).trim()
}

/** Report upward, exactly as a real delegate would mid-turn. */
function reportBlocked() {
  const bin = process.env.DRILL_CONSULT_BIN
  if (bin === undefined) {
    process.stderr.write('drill delegate: DRILL_CONSULT_BIN is not set; cannot report\n')
    return
  }
  const child = spawn(process.execPath, [bin, 'report', '--type', 'blocked', '--message', REPORT_MESSAGE], {
    cwd: process.env.CONSULT_WORKSPACE ?? process.cwd(),
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  child.stderr.on('data', (data) => process.stderr.write(`drill delegate report: ${data}`))
  child.on('error', (error) => process.stderr.write(`drill delegate report failed: ${error.message}\n`))
}

function handle(message) {
  switch (message.method) {
    case 'initialize':
      write({ jsonrpc: '2.0', id: message.id, result: agentIdentity })
      return
    case 'session/new':
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'drill-session-1' } })
      return
    case 'session/resume':
    case 'session/load':
      write({ jsonrpc: '2.0', id: message.id, result: { sessionId: message.params?.sessionId } })
      return
    case 'session/cancel':
      // Answer inside the broker's ack window or the steer is withdrawn.
      if (openPrompt !== null) {
        write({ jsonrpc: '2.0', id: openPrompt.id, result: { stopReason: 'cancelled' } })
        openPrompt = null
      }
      return
    case 'session/prompt': {
      promptCount += 1
      const sessionId = message.params?.sessionId
      if (promptCount === 1) {
        chunk(sessionId, 'starting; I need a decision before I can continue')
        reportBlocked()
        // Deliberately no response: the turn stays open until the steer cancels it.
        openPrompt = message
        return
      }
      const guidance = guidanceOf(promptText(message.params))
      chunk(sessionId, guidance === undefined
        ? 'continued without recognizable supervisor guidance'
        : `continued with supervisor guidance: ${guidance}`)
      write({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })
      return
    }
    default:
      if (message.id !== undefined) {
        write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } })
      }
  }
}

let buffered = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data) => {
  buffered += data
  let index
  while ((index = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, index)
    buffered = buffered.slice(index + 1)
    if (line.trim().length === 0) continue
    try {
      handle(JSON.parse(line))
    } catch (error) {
      process.stderr.write(`drill delegate: ${error.message}\n`)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
