// Runs every spec: node tests/run.mjs
import { summary } from './_util.mjs'

await import('./units.spec.mjs')
await import('./bridge.spec.mjs')
await summary()
