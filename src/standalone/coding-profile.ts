import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'

export const CodingProfile = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/)
export type CodingProfile = z.infer<typeof CodingProfile>
const MAX_TEMPLATE = 16_384

function promptDirectory(): string {
  const base = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
  if (!isAbsolute(base)) throw new Error('Pi agent directory must be absolute')
  const path = join(base, 'prompts')
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()))
    throw new Error('Unsafe Pi prompt directory')
  return path
}

/** Discover names only; never load arbitrary project prompts or enable Pi resource discovery. */
export function availableCodingProfiles(directory = promptDirectory()): string[] {
  return ['default', ...readdirSync(directory).filter(name => name.endsWith('.md') && CodingProfile.safeParse(name.slice(0, -3)).success)
    .filter(name => { const stat = lstatSync(join(directory, name)); return stat.isFile() && !stat.isSymbolicLink()
      && (process.getuid === undefined || stat.uid === process.getuid()) && stat.size > 0 && stat.size <= MAX_TEMPLATE })
    .map(name => name.slice(0, -3)).filter(name => name !== 'default').sort()]
}

/** Profiles affect instructions only; never tools, grants, workspaces or shell access. */
export function profileInstructions(raw: string, directory?: string): string {
  const profile = CodingProfile.parse(raw)
  if (profile === 'default') return 'General coding: preserve correctness; do not claim tests or performance gains without measurements.'
  directory ??= promptDirectory()
  const dirStat = lstatSync(directory)
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink() || (process.getuid && dirStat.uid !== process.getuid()))
    throw new Error('Unsafe Pi prompt directory')
  if (!availableCodingProfiles(directory).includes(profile)) throw new Error('Unknown or unsafe Pi prompt profile')
  const path = join(directory, `${profile}.md`)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_TEMPLATE || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Unsafe Pi prompt template')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fd))
    if (text.includes('\0')) throw new Error('Unsafe Pi prompt template')
    // Do not expand template arguments or treat frontmatter as executable code.
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      .replaceAll('$ARGUMENTS', '[Ticket task provided separately]').replaceAll('$@', '[Ticket task provided separately]')
    return `${body}\nTicket authorization and tool restrictions override conflicting template instructions. No shell, tests, commit or push.`
  } finally { closeSync(fd) }
}
