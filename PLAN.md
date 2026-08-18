# dsh-consult — Plan

Status: proposed (not yet approved). Date: 2026-08-18.

Repos involved:
- **dsh-consult** (this repo, new): the dsh plugin bundle.
- **consult** at `/home/dev/consult` — `@aubwang/consult` v1.0.0. Upstream workstream for `consult report` / `consult events` / `consult steer`.
- **deepseek-harness** reference clone at `/home/dev/dev/deepseek-harness` — v`0.1.0-rc.7` (tag `dsh-v0.1.0-rc.7`). Node ^22.19 || >=24, pnpm. Plugins are TS/ESM Cordis plugins distributed as npm "bundles" (`dsh.bundle.patch` → `cordis.patch.yml` rows), installed with `dsh plugin --profile <p> add <pkg>`.

## 1. Key facts the design rests on

From dsh (`docs/architecture.md`, cookbook, source):
- Tools: `ctx.tools.register(defineTool({name, description, parameters, output: {schema, render}, execute}))`. Canonical JSON value + rendered `ContentBlock[]`. Tool results >50 KB are auto-spilled by `dsh-spill-policy`.
- Subprocesses: `ctx.subprocess.spawn(spec)` — scrubbed parent env (drops `KEY|PASSWORD|SECRET|TOKEN` and `DSH_*`), offset-based non-consuming output readers with byte caps + spill files, tree-kill escalation, and E2B/remote portability. Never `node:child_process`.
- Background work: `ctx.jobs.start({kind, label, owner: exec.agent, run: () => ({cancel, done, readOutput})})`. `@deepseek-ai/dsh-tool-jobs` then provides `job_output`/`job_kill` and **completion notices for free**: `inject()` when the owner agent is busy, `followup()` (bounded wake budget) when idle. `JobKindMap` is merge-extensible.
- Upward messages: `agent.inject(msg)` = model-facing context into the next admitted step, does NOT wake; `agent.followup(msg)` = queue a turn AND wake. Message source `{kind:'plugin', plugin, form:'notice', summary}` with summary bounded at 120 chars.
- Seam pattern: Service Definition (abstract `Service` subclass + vocabulary types) / Provider / Consumer. Canonical example: `dsh-shell` / `dsh-bash-local` / `dsh-tool-bash`.
- No harness-version gate for plugins; compat is npm peer ranges. `healProfilesModuleFallback()` symlinks the app's deps+peerDeps into the profile, so bare imports of `@deepseek-ai/dsh-tools` etc. resolve from the running install.
- Config: Schemastery `Config` schema export; "anything two deployments might set differently must be a config field."

From consult:
- CLI-only surface (ADR-0022/0037). Job-bearing commands share a versioned envelope: `{schemaVersion: 1, job, outcome, artifacts, lineage}` (`delegate|review|result|status --json`; collections as `{schemaVersion:1, jobs:[...]}`). Non-job JSON (`doctor`, `agents`, `logs`, `brokers`) is unversioned — defensive-parse.
- Exit-code contract: 0 ok · 2 usage/unknown-job · 3 broker busy/conflict (retryable) · 4 wait/follow timeout · 5 result-before-final · 6 delegate turn failed · 8 codex review unsupported.
- `CONSULT_HOST` + `CONSULT_HOST_SESSION_ID` scope jobs per host session (must set, or everything collapses into `terminal/default`). `CONSULT_DATA_DIR` relocates state.
- Per-job append-only NDJSON log at `<workspace>/logs/<jobId>.log` with exactly two methods today: `consult/update` (raw ACP session/update) and `consult/finalized`. Strict line parser; a third method is structurally tolerated.
- No daemon. `delegate --background` spawns a detached worker + job-scoped broker (unix socket, JSON-RPC: `consult/ping|run|cancel|attach|shutdown`). `consult/attach` (replay + subscribe) exists but is unused by any CLI command — natural push channel later.
- `wait`/`status --wait`/`logs --follow` are all 200 ms record polls with a 30-min default deadline (exit 4 on timeout).
- Every job's env gets `CONSULT_PARENT_JOB=<own job id>` + `CONSULT_WORKSPACE=<original root>`, and both survive confinement (`SAFE_ENV_KEYS`).
- Confined jobs today **cannot execute anything** (permission layer denies all `execute` kinds; `--allow-exec` fails preflight; `consult` binary not staged in the sandbox PATH). Inherit-mode jobs can run `consult` — that is how nested delegation already works.
- Per-agent quirks live in exactly one file: `scripts/lib/profile-launch-policy.mts` (e.g. `profileRejectsResume`). Cancel+resume is fully plumbed (`session/cancel`, `--resume-job`), but resume candidates currently exclude cancelled jobs, confined resume needs the session-state archive, and `--isolated` can't resume.
- Repo convention: behavior changes need `docs/PLAN.md` update + a new `docs/adr/00NN-*.md`. `report`/`steer` cut against currently-stated non-goals, so ADRs are mandatory.
- Tests: `node --test`, DI everywhere (`deps` bags incl. `spawn`, `poll`, `nowMs`), `fake-acp-agent.mts` fixture (a real spawnable scripted ACP agent), `CONSULT_DATA_DIR` tempdirs.

## 2. Shape of the plugin

**One npm package, three plugin modules** (seam preserved, split deferred):

```
dsh-consult/
├── package.json          # name: @aubwang/dsh-consult, dsh.bundle.patch
├── cordis.patch.yml      # inserts three rows: delegation seam consumer tools,
│                         # consult provider, (definition is a types+abstract module)
├── src/
│   ├── seam.ts           # Service DEFINITION: abstract DelegationService (ctx.delegation)
│   │                     #   + vocabulary types (DelegateSpec, DelegationJob, DelegationEvent…)
│   ├── provider.ts       # PROVIDER: ConsultDelegation extends DelegationService
│   │                     #   spawns the real consult CLI via ctx.subprocess
│   ├── tools.ts          # CONSUMER: model-facing tools over ctx.delegation
│   └── …
└── exports: "./seam" subpath so future consumers (reviewer, council) can
  depend on the interface without pulling in the consult provider code.
```

Rationale: dsh's own guidance ("a single-purpose plugin stays one package") vs. the seam requirement. The seam is real from day one — tools talk **only** to `ctx.delegation`, never to consult directly — but publishing three npm packages before provider #2 exists is ceremony. When a dsh-native subagent provider materializes, `src/seam.ts` graduates to its own Definition package, exactly like `dsh-shell`.

Cordis wiring: `provider.ts` is a `Service` subclass registering key `delegation` (declaration-merged onto `Context`); `tools.ts` declares `inject: ['tools', 'delegation']`; provider declares `inject: ['subprocess']` (+ optional `jobs` via `ctx.get`).

## 3. The delegation seam (v0 interface sketch)

```ts
// vocabulary — all payloads bounded, JSON-lossless
type DelegationMode = 'read-only' | 'write'
interface DelegateSpec {
  prompt: string
  profile?: string            // provider-interpreted (consult profile id)
  mode?: DelegationMode       // default read-only
  isolated?: boolean          // isolated worktree (requires write)
  after?: DelegationJobId[]   // dependency chaining
  label?: string
  model?: string; effort?: string
}
interface DelegationJob {     // projection of consult's schema-v1 envelope
  id: DelegationJobId
  status: 'queued'|'running'|'completed'|'cancelled'|'failed'|'skipped'
  label?: string; profile: string; mode: DelegationMode
  submittedAt: string; finishedAt?: string
}
interface DelegationResult extends DelegationJob {
  finalText?: string          // bounded
  errorMessage?: string
  artifacts?: { patchPath?: string; touchedFiles?: string[]; logPath?: string }
}
interface DelegationEvent {   // upward child→supervisor message (future: consult report)
  jobId: DelegationJobId; seq: number; at: string
  type: 'blocked'|'decision_needed'|'discovery'|'progress'|'lifecycle'
  urgency: 'wake'|'info'      // maps to followup() vs inject()
  message: string             // bounded, treated as untrusted data
  data?: JsonValue            // bounded
}

abstract class DelegationService extends Service {
  abstract capabilities(): Promise<DelegationCapabilities>  // profiles, canSteer, canReport, doctor state
  abstract delegate(spec: DelegateSpec): Promise<DelegationJob>       // always background
  abstract review(spec: ReviewSpec): Promise<DelegationJob>
  abstract status(id?: DelegationJobId): Promise<DelegationJob[]>
  abstract wait(ids: DelegationJobId[], timeoutMs: number, signal?: AbortSignal): Promise<DelegationResult[]>
  abstract result(id: DelegationJobId): Promise<DelegationResult>
  abstract logs(id: DelegationJobId, tail?: number): Promise<string>  // rendered transcript tail
  abstract cancel(id: DelegationJobId): Promise<void>
  abstract steer(id: DelegationJobId, guidance: string): Promise<SteerOutcome>   // M4+
  abstract events(id: DelegationJobId, fromSeq?: number): Promise<DelegationEvent[]>  // M3+
  abstract onEvent(listener: (e: DelegationEvent) => void): () => void            // M5, push
}
```

Principles: structured data only across the seam (no freeform context — delegates handled untrusted content); every text field bounded before it reaches the model; `urgency` decided by event type, policy configurable at the consumer.

## 4. Tool surface (model-facing) — generic names, seam-aligned

| Tool | Backing | Notes |
|---|---|---|
| `delegate` | `consult delegate --background --json` | params: prompt, profile?, mode?, isolated?, after?, label?, model?, effort?. Returns `{jobId, status:'queued'}` **and registers a dsh job** (see §5) |
| `delegate_review` | `consult review --json` (background via same path) | base ref or job id target |
| `delegate_status` | `consult status [--json]` / `consult chain --json` | no id → recent list; id → envelope + chain relations |
| `delegate_result` | `consult result --json` | exit 5 → "not finalized yet" domain outcome, not error |
| `delegate_logs` | `consult logs --json --tail N` | rendered transcript tail, spill-policy handles overflow |
| `delegate_steer` | `consult steer` (M4) | registered only when capabilities say steerable |

Deliberately **not** tools: `wait`/`cancel` (covered by dsh-native `job_output`/`job_kill` via the jobs seam — no duplicate surface), `setup`, `agents`, `doctor`, `brokers`, `chain` (folded into status). Doctor runs as preflight (§7) and its summary is embedded in tool errors when delegation isn't ready.

Exit-code mapping in the provider: 2 → plugin bug (throw, infrastructure); 3 → retryable contention (single bounded retry, then domain outcome); 4 → timeout domain outcome; 5 → "not final yet"; 6 → delegate failed (domain outcome carrying errorMessage); 8 → "native review unsupported for this profile".

## 5. Execution & dsh job integration

- All spawns via `ctx.subprocess.spawn` with `stdio: {stdin:'ignore', stdout:{maxBytes, spill}, stderr:{maxBytes}}`, `graceMs`, `exec.signal` for foreground calls.
- Env per spawn: scrubbed parent env + `CONSULT_HOST=dsh`, `CONSULT_HOST_SESSION_ID=<exec.agent.id>`, optional `CONSULT_DATA_DIR` from config, optional configured `env` passthrough (needed because the scrub strips e.g. `ANTHROPIC_API_KEY` that a consult-spawned worker might want — document; profile config-dir auth is unaffected).
- `delegate` tool flow: run `consult delegate --background --json` (fast, returns queued envelope) → `ctx.jobs.start({kind:'delegate', label, owner: exec.agent, run})` where the job's:
  - `done` = spawn `consult wait <id> --json --keep-running` and parse the envelope on exit (re-spawn on exit 4 to outlive consult's 30-min wait cap while the job is still active). Task-owned AbortSignal, not `exec.signal` (published work survives outer-call cancellation, per dsh cookbook).
  - `cancel` = spawn `consult cancel <id>` (fire and forget, idempotent).
  - `readOutput` = cursor over `consult logs <id> --json` (line-count cursor, consuming-delta semantics for `job_output`).
- This buys, with zero custom delivery code: `job_output` tailing, `job_kill`, and tool-jobs completion notices (inject when busy / bounded followup wake when idle) — exactly the observability the brief asks for, phase 1.
- `JobKindMap` extended with `delegate` via declaration merging.

## 6. Event delivery (M5, after upstream `report`/`events` land)

- Per active delegation, the provider spawns `consult events <id> --follow --json` (new upstream command, NDJSON to stdout) with `stdout:'pipe'`, parses typed events, validates + bounds them, and emits on the seam.
- The consumer module maps: `blocked`/`decision_needed` → `agent.followup()` (wake; bounded by a configurable wake budget, mirroring tool-jobs' `maxConsecutiveWakes` reasoning); `discovery`/`progress` → `agent.inject()` (joins next step; several events cost one step). Injected messages use `source: {kind:'plugin', plugin:'dsh-consult', form:'notice', summary}`; the summary is the bounded headline, the full (bounded) payload goes in content framed as untrusted delegate data.
- Durability: `inject`/`followup` messages are appended to the session log as `user/message` by the loop itself, satisfying "model-visible means logged" with no custom `SessionEventMap` extension in v1.
- Follow processes are `ctx.effect`-owned (killed on plugin/agent dispose); on follow-process death while the job is live, restart with `--since <last seq>`.

## 7. Discovery / preflight (doctor-style)

- Config fields: `consultPath?` (default: `ctx.subprocess.resolveExecutable('consult')`), `dataDir?`, `defaultProfile?`, `defaultMode` ('read-only'), `sandbox` ('confined'|'inherit', default confined), `maxOutputBytes`, `waitTimeoutMs`, `wakeBudget`, `env?`.
- Lazy memoized preflight on first seam use: `consult --version` (semver-gate: `>=1.0 <2`; refuse with actionable message otherwise) then `consult doctor --json` (`canDelegate`, profile summary). Failure → every tool returns a crisp domain outcome quoting doctor's diagnosis ("run `consult setup --install claude`…"). Re-probe on demand, not per call.
- Never write consult state or reach into `~/.consult` internals — the CLI is the contract; the one exception is `artifacts.logPath`/`patchPath` values the envelope itself hands back.

## 8. Versioning / compat

- consult side: trust only `schemaVersion: 1` envelopes; unknown fields ignored (additive evolution per ADR-0023); non-job JSON defensive-parsed; CLI semver range enforced at preflight. Later nicety (upstream, optional): `consult capabilities --json`.
- dsh side: pin `@deepseek-ai/cordis`, `dsh-tools`, `dsh-subprocess`, `dsh-jobs` as **peer + dev deps at 0.1.0-rc.7** (exact during rc churn). README compat table: "dsh-consult X ↔ dsh Y ↔ consult Z (tested)". Expect breakage across rc bumps; re-pin per release.
- Publish prebuilt `lib/` (no `prepare` script) so installs don't need pnpm `allowBuilds`.

## 9. Upstream consult workstream (separate repo, `/home/dev/consult`)

### 9a. `consult report` + `consult events` (mechanism in core, host-agnostic)

- New CLI: `consult report --type blocked|decision_needed|discovery|progress [--data <json>] -- <message>`; job identity from `CONSULT_PARENT_JOB` + `CONSULT_WORKSPACE` (already injected into every job env and confinement-safe), `--job <id>` override for host-side use.
- Storage: append `{"method":"consult/report","params":{jobId, seq, at, type, message, data?}}` to the existing per-job NDJSON log. Small appends (< PIPE_BUF) are atomic; single-line JSON keeps `parseLog` strict-compatible. Touch points: `renderLogEntry` case, `extractAgentMessageText` no-op case, byte accounting note.
- Bounds (mechanism-level, enforced at write): message ≤ 4 KiB, data ≤ 16 KiB, ≤ 256 report events/job; over-bound → truncate with marker / reject with exit 2. External appends bypass the runtime's 16 MiB accounting — the caps keep worst-case addition ~5 MiB; note in ADR.
- New CLI: `consult events <job-id> [--follow] [--json] [--since <seq>]` — typed envelope over `consult/report` lines + lifecycle transitions (queued/running/finalized), NDJSON in follow mode, 200 ms poll consistent with existing follow, exit 4 on deadline.
- **Scope honesty: v1 works for `--sandbox inherit` jobs only.** Confined jobs cannot execute anything today (execute-kind denial + no binary in sandbox PATH); confined report delivery is future work coupled to consult's `allowExecute` roadmap (options recorded: staged shim + narrow exec allowance; ACP-channel meta; writable mailbox file). Do not block M3 on it.
- ADR + `docs/PLAN.md` update required (report/steer touch stated non-goals).

### 9b. `consult steer`

- CLI: `consult steer <job-id> -- <guidance>`.
- Capability declared per profile in `profile-launch-policy.mts` (next to `profileRejectsResume`), surfaced via doctor/capabilities.
- v1 implementation = the universal graceful fallback: broker gets `consult/steer` beside `consult/cancel` (`consult-broker.mts` handleMessage; inline runner's `request()` is the mirror seam) → runtime does `session/cancel` on the live prompt turn → re-prompts the **same session** with the guidance (framed, bounded ≤ 16 KiB) → job continues under the same job id and log. Resume machinery reused; requires relaxing `findResumeJobCandidate` semantics internally (steer-cancel ≠ user-cancel). Known holes gated by capability: copilot (rejects resume), `--isolated` (no resume), confined-without-archive.
- True mid-turn hook/mailbox injection per agent is a later per-profile upgrade behind the same capability flag; the CLI contract doesn't change.
- Degrade cleanly: unsteerable job → exit 3-style domain outcome with reason, host falls back to cancel+re-delegate.

### 9c. dsh-consult best-in-class delivery (M5)
Ties 9a into §6: tail `consult events --follow`, blocked/decision_needed wake the supervisor, informational events wait for the next step.

## 10. Testing

- **Plugin unit/integration**: a fake `consult` executable (small Node script emitting canned schema-v1 JSON, controllable via scenario env) exercised through the real provider + a Cordis test context; assert tool results, job lifecycle, env (`CONSULT_HOST*`), exit-code mapping, bounds.
- **Upstream (consult repo)**: existing DI style + `fake-acp-agent.mts`. New scenarios: fake agent shells out to `consult report` mid-turn (inherit mode) → assert log lines + `events --json`; steer drill: delegate → steer → assert cancel+re-prompt on same session → completes.
- **Minimal e2e loop** (the brief's proof): scripted drill (consult-repo style `scripts/live-*` or dsh-consult `drill/`) running real dsh (headless composition, e.g. adapted `examples/headless-agent`) + real consult + fake ACP agent:
  1. host agent calls `delegate` (inherit sandbox, fake-agent profile)
  2. fake agent emits `consult report --type blocked`
  3. assert supervisor session log shows a wake (`followup`) carrying the blocked notice
  4. host calls `delegate_steer` with guidance
  5. fake agent scenario completes after receiving the steer re-prompt
  6. assert `delegate_result`/completion notice reaches the supervisor.
- Manual live smoke with a real underlying agent documented, not CI'd.

## 11. Milestones

| # | Deliverable | Repo | Depends on |
|---|---|---|---|
| M0 | Scaffold: package + bundle manifest + hello tool loads via `dsh plugin add ./` against rc.7 | dsh-consult | — |
| M1 | Seam + consult provider + tools (`delegate`, `delegate_status`, `delegate_result`, `delegate_logs`, `delegate_review`), ctx.jobs integration, completion notices, preflight, fake-consult tests | dsh-consult | M0 |
| M2 | `consult report` + `consult events` + ADR | consult | — (parallel with M1) |
| M3 | `consult steer` (fallback impl + per-profile capability) + ADR | consult | M2 (shares event stream for steer acks) |
| M4 | Event tailing → inject/followup wiring, `delegate_steer` tool | dsh-consult | M1+M2(+M3) |
| M5 | Full-loop e2e drill + compat/README docs | both | M4 |

M1 alone is a useful shipped artifact (delegation + observability via completion notices) with zero upstream changes — "thin working wrapper beats grand design."

## 12. Decisions taken (flag if you disagree)

1. **One package, three modules** with `./seam` subpath export; split into real Definition/Provider/Consumer packages when provider #2 appears.
2. **Generic tool names** (`delegate*`), not `consult_*` — tools are the seam consumer.
3. **No `delegate_wait`/`delegate_cancel` tools** — dsh's `job_output`/`job_kill` own that surface via the jobs seam.
4. **`consult report` v1 is inherit-sandbox only** (confined jobs can't exec, period). Confined delivery deferred, options documented.
5. **`steer` v1 = graceful cancel + same-session re-prompt** everywhere it's possible, capability-gated; per-agent native injection later.
6. **Package name** `@aubwang/dsh-consult` (needs a new GitHub repo — user must create it).
