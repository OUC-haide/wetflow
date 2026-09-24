import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const destination = resolve(root, 'dist/node/worker.py')
mkdirSync(dirname(destination), { recursive: true })
copyFileSync(resolve(root, 'src/modeling/worker.py'), destination)
