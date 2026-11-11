// Same-process fallback: test cases can run even when the OS denies Node test workers.
import { readdirSync } from 'node:fs'
for(const f of readdirSync('tests').filter(f=>f.endsWith('.test.mjs')).sort()) {
  await import(new URL(`../../../tests/${f}`,import.meta.url))
}
