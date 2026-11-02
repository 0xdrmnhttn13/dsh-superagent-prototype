#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
for (const [kind, values] of Object.entries({ dependencies: pkg.dependencies, devDependencies: pkg.devDependencies, peerDependencies: pkg.peerDependencies ?? {} })) {
  for (const name of Object.keys(values)) if (name.startsWith('@deepseek-ai/') || /cordis/i.test(name)) throw new Error(`${kind} contains ${name}`)
}
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', 'src', 'scripts', 'tests'], { encoding: 'utf8' }).split('\n')
const forbidden = files.filter(file => existsSync(file) && /\.(ts|tsx|js|mjs)$/.test(file)).flatMap(file => {
  const code = readFileSync(file, 'utf8')
  return /(?:from\s*['"]|import\s*\(\s*['"]|require\s*\(\s*['"])(?:@deepseek-ai\/|cordis(?:\/|['"]))/i.test(code) ? [file] : []
})
if (forbidden.length) throw new Error(`DSH/Cordis source dependency: ${forbidden.join(', ')}`)
const bundle = readFileSync(new URL('../lib/daemon.mjs', import.meta.url), 'utf8')
if (/@deepseek-ai\/|(?:from|import|require)\s*\(?\s*['"]cordis/.test(bundle)) throw new Error('DSH/Cordis import found in built daemon')
console.log('Dependency audit: no DSH/Cordis package, source import, or built runtime reference')
