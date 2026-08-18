/**
 * Copying one real consult profile into a throwaway registry.
 *
 * The live-dogfood mode of the full-loop drill runs against a real agent, which
 * means reusing the real profile record — its binary, its arguments, its
 * environment — so that authentication and configuration are exercised as the
 * user actually has them. Everything else about the drill stays disposable: the
 * copy lands in a temporary `CONSULT_DATA_DIR` that is deleted afterwards, and
 * the drill never writes to the user's own registry.
 *
 * Only the selection is here, as a pure function, because it is the part with
 * failure modes worth a test: a name that is not installed, a registry that is
 * not a registry, a schema version this drill does not understand.
 * @module drill/profiles
 */

/** One profile record, copied verbatim — the drill interprets none of its fields. */
export type ProfileRecord = Record<string, unknown>

/** The shape of a consult `profiles.json`, as far as this drill needs it. */
export interface ProfilesDocument {
  schemaVersion?: unknown
  default?: unknown
  hostDefaults?: unknown
  profiles?: unknown
}

/** The registry version this drill knows how to copy from. */
export const PROFILES_SCHEMA_VERSION = 1

/**
 * Build a throwaway registry containing exactly one profile, copied from a real one.
 *
 * The record is copied verbatim rather than field-picked: consult's registry
 * carries per-profile launch details (`codexPath`, `installedVia`, and whatever
 * a later version adds) that this drill has no business interpreting, and
 * dropping one silently would make the drill test a differently-configured
 * agent than the user has.
 * @param source - the parsed contents of the user's real profiles.json.
 * @param name - the profile to copy.
 * @returns a registry with that profile installed and set as the default.
 * @throws Error naming what was wrong, for a drill operator to read.
 */
export function selectProfileRegistry(source: ProfilesDocument, name: string): {
  schemaVersion: number
  default: string
  hostDefaults: Record<string, never>
  profiles: Record<string, ProfileRecord>
} {
  if (source.schemaVersion !== PROFILES_SCHEMA_VERSION) {
    throw new Error(
      `this drill reads consult profiles schemaVersion ${PROFILES_SCHEMA_VERSION}, found ${JSON.stringify(source.schemaVersion)}`,
    )
  }
  if (typeof source.profiles !== 'object' || source.profiles === null || Array.isArray(source.profiles)) {
    throw new Error('the consult registry has no profiles object')
  }
  const profiles = source.profiles as Record<string, unknown>
  const record = profiles[name]
  if (record === undefined) {
    const installed = Object.keys(profiles)
    throw new Error(
      `no consult profile named ${JSON.stringify(name)}; installed: ${installed.length > 0 ? installed.join(', ') : '(none)'}`,
    )
  }
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new Error(`the consult profile ${JSON.stringify(name)} is not a record`)
  }
  return {
    schemaVersion: PROFILES_SCHEMA_VERSION,
    // The user's own registry may have no default, or a different one; the
    // throwaway pins the profile under test so nothing else can be selected.
    default: name,
    hostDefaults: {},
    profiles: { [name]: { ...record } as ProfileRecord },
  }
}
