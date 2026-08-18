/**
 * Drill: run the provider's real event follow against a real `consult events`.
 *
 * It builds a throwaway CONSULT_DATA_DIR workspace with one job record and its
 * append-only log, mounts the provider over the real subprocess seam, watches
 * the delegation, then appends a report and finalizes the record while the
 * follow is live — the same sequence a delegate produces with `consult report`.
 *
 * Usage, from this package's directory:
 *   node drill/events-live.mjs /path/to/consult/bin/consult
 *
 * A consult without the events command prints `canReport: false` and delivers
 * nothing, which is the capability gate working.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ConsultDelegation } from '../lib/provider.js'

const consultBin = process.argv[2]
if (consultBin === undefined) {
  process.stderr.write('usage: node drill/events-live.mjs /path/to/consult/bin/consult\n')
  process.exit(2)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-consult-events-drill-'))
const workspaceRoot = path.join(root, 'workspace')
const dataDir = path.join(root, 'data')
await fs.mkdir(path.join(workspaceRoot, '.git'), { recursive: true })

// consult's own layout: <dataDir>/workspaces/<sha256(realpath)>/{jobs,logs}.
const workspaceHash = createHash('sha256').update(await fs.realpath(workspaceRoot)).digest('hex')
const jobsDir = path.join(dataDir, 'workspaces', workspaceHash, 'jobs')
const logsDir = path.join(dataDir, 'workspaces', workspaceHash, 'logs')
await fs.mkdir(jobsDir, { recursive: true })
await fs.mkdir(logsDir, { recursive: true })

const jobId = 'job-drill'
const record = (status, extra = {}) => JSON.stringify({
  jobId, status, profile: 'claude', kind: 'delegate',
  submittedAt: '2026-08-18T00:00:00.000Z', startedAt: '2026-08-18T00:00:01.000Z', ...extra,
})
const reportLine = (type, message, at, data) => `${JSON.stringify({
  method: 'consult/report',
  params: { jobId, at, type, message, ...(data ? { data } : {}) },
})}\n`

await fs.writeFile(path.join(jobsDir, `${jobId}.json`), record('running'))
await fs.writeFile(path.join(logsDir, `${jobId}.log`), reportLine('progress', 'reading src/server.ts', '2026-08-18T00:00:02.000Z'))

const ctx = new Context()
await ctx.plugin(LocalSubprocessRuntime)
await ctx.plugin(ConsultDelegation, {
  consultPath: 'node',
  consultArgs: [consultBin],
  cwd: workspaceRoot,
  dataDir,
  eventFollowRestartMs: 500,
})

const capabilities = await ctx.delegation.capabilities()
process.stdout.write(`canReport: ${capabilities.canReport} (consult ${capabilities.version ?? 'unknown'})\n`)

const page = await ctx.delegation.events(jobId)
process.stdout.write(`events(): supported=${page.supported} count=${page.events.length}\n`)

const received = []
ctx.delegation.watch(jobId, (event) => {
  received.push(event)
  const detail = event.type === 'lifecycle' ? event.lifecycle?.phase : `seq ${event.seq} urgency ${event.urgency}`
  process.stdout.write(`  [event] ${event.type} (${detail}) ${JSON.stringify(event.message)}\n`)
})

await new Promise((resolve) => setTimeout(resolve, 800))
await fs.appendFile(path.join(logsDir, `${jobId}.log`), reportLine('blocked', 'need a decision on the retry policy', '2026-08-18T00:00:05.000Z', { options: ['a', 'b'] }))
await new Promise((resolve) => setTimeout(resolve, 800))
await fs.writeFile(path.join(jobsDir, `${jobId}.json`), record('completed', { completedAt: '2026-08-18T00:00:09.000Z' }))
await new Promise((resolve) => setTimeout(resolve, 1_200))

process.stdout.write(`delivered ${received.length} events; wake-urgency: ${received.filter((e) => e.urgency === 'wake').length}\n`)
await fs.rm(root, { recursive: true, force: true })
process.exit(0)
