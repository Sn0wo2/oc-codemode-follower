import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { dirname } from "node:path"

export function createLogger(path: string, enabled: boolean) {
  if (enabled) {
    try {
      mkdirSync(dirname(path), { recursive: true })
    } catch {}
  }

  return (line: string) => {
    if (!enabled) return
    try {
      if (statSync(path).size > 1_000_000) truncateSync(path, 0)
    } catch {}
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {}
  }
}
