/**
 * Optional Host `Config` schema.
 *
 * Declaring a Config is what makes the Loader entry a settings namespace, and a
 * served settings namespace is what gives the Plugins page's row page an
 * editable `form`. Only `.volatile()` fields are editable from the page (the
 * settings service projects nothing else), and a volatile field updates in
 * place, so changing the token or the peer name does not restart the plugin.
 * The schema itself comes from `@deepseek-ai/schemastery`,
 * which a profile-installed bundle can only reach through the Host's module
 * resolution (it is not a dependency of this package). Every resolution route
 * is attempted; when none works the plugin still loads exactly as before and
 * simply has no editable settings form.
 */
import { readdirSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Real path of a file, or the input unchanged when it cannot be resolved. */
function real(input) {
  try {
    return realpathSync(input)
  } catch {
    return input
  }
}

/**
 * Directories whose `node_modules` may hold the package. The Host process can
 * be a CLI launcher (`.../bin/dsh`, often a symlink), a Desktop host inside an
 * asar, or a profile-launched process; every route is walked upward because the
 * package may be hoisted at any level.
 */
function candidateBaseDirs() {
  const bases = new Set()
  const add = (dir) => {
    if (typeof dir === 'string' && dir !== '') bases.add(dir)
  }
  const argv1 = process.argv[1]
  if (typeof argv1 === 'string' && argv1 !== '') {
    add(dirname(real(argv1)))
    add(dirname(argv1))
  }
  add(dirname(fileURLToPath(import.meta.url)))
  add(process.env.DSH_PROFILE_DIR)
  const envHome = process.env.DSH_HOME
  const profile = process.env.DSH_PROFILE ?? process.argv[2]
  if (typeof envHome === 'string' && envHome !== '') {
    if (typeof profile === 'string' && profile !== '' && !profile.startsWith('-')) add(join(envHome, 'profiles', profile))
    add(join(envHome, 'profiles'))
    add(envHome)
  }
  const home = homedir()
  if (typeof profile === 'string' && profile !== '' && !profile.startsWith('-')) add(join(home, '.dsh', 'profiles', profile))
  try {
    for (const entry of readdirSync(join(home, '.dsh', 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) add(join(home, '.dsh', 'profiles', entry.name))
    }
  } catch {
    // No profile directory: a portable install.
  }
  add(join(home, '.dsh'))
  add(home)
  return [...bases]
}

/** Candidate `node_modules` directories, nearest first. */
function candidateRequireDirs() {
  const dirs = []
  for (const base of candidateBaseDirs()) {
    let dir = resolve(base)
    for (let depth = 0; depth < 10; depth += 1) {
      const modules = join(dir, 'node_modules')
      if (!dirs.includes(modules)) dirs.push(modules)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return dirs
}

/** Load the schemastery module from any route that resolves. */
async function importSchemastery() {
  const attempts = [() => import('@deepseek-ai/schemastery')]
  for (const dir of candidateRequireDirs()) {
    attempts.push(async () => {
      const require = createRequire(join(dir, 'noop.js'))
      const resolved = require.resolve('@deepseek-ai/schemastery')
      return await import(pathToFileURL(resolved).href)
    })
  }
  for (const attempt of attempts) {
    try {
      const module = await attempt()
      const schema = module?.default ?? module
      if (typeof schema?.object === 'function') return schema
    } catch {
      // Try the next route.
    }
  }
  return undefined
}

/** Copy of the documented row fields, so the settings page can edit them. */
function schemaShape(z) {
  return z.object({
    name: z.string().default('').volatile().description('Peer name shown to the other machines. Empty uses DSH_LAN_NAME or the host name.'),
    token: z.string().default('').volatile().description('Shared secret for the whole mesh. Empty falls back to DSH_LAN_TOKEN, then <DSH_HOME>/lan-mesh/token. Every machine needs the same value.'),
    port: z.natural().min(1).max(65535).default(7317).description('TCP port of the peer server.'),
    bind: z.string().default('0.0.0.0').description('Bind address of the peer server.'),
    server: z.boolean().default(true).description('Run the peer server so other machines can call this one.'),
    discover: z.boolean().default(true).description('Announce and listen on the LAN with UDP beacons.'),
    discoveryPort: z.natural().min(1).max(65535).default(7318).description('UDP port used for LAN discovery.'),
    announceMs: z.natural().min(1000).max(300000).default(5000).description('Beacon interval in milliseconds.'),
    peers: z
      .array(z.object({
        name: z.string().required(),
        host: z.string().required(),
        port: z.natural().min(1).max(65535).default(7317),
        token: z.string().default(''),
      }))
      .default([])
      .description('Static peers for subnets where UDP broadcast does not reach.'),
    taskCwd: z.string().default('').description('Default working directory for delegated tasks on this machine.'),
    toolTimeoutMs: z.natural().min(1000).max(86400000).default(900000).description('Deadline of lan_delegate and lan_exec in milliseconds.'),
    allowExec: z.boolean().default(true).volatile().description('Accept raw shell commands from peers through lan_exec.'),
  })
}

/**
 * Resolve the optional Config schema.
 * @returns the schemastery object schema, or `undefined` when the package
 *   cannot be loaded in this deployment (the plugin then has no settings form).
 */
export async function loadConfigSchema() {
  const z = await importSchemastery()
  if (z === undefined) return undefined
  try {
    return schemaShape(z)
  } catch {
    return undefined
  }
}
