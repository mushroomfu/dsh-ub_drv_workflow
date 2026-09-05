import { rmSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = resolve(projectRoot, 'lib')

if (dirname(outputDir) !== projectRoot || basename(outputDir) !== 'lib') {
  throw new Error(`Refusing to clean unexpected output path: ${outputDir}`)
}

rmSync(outputDir, { recursive: true, force: true })
