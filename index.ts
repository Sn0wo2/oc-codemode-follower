import { appendFileSync, mkdirSync, statSync, truncateSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { Plugin } from "@opencode/plugin"

type TriggerMode = "any" | "all"
type TargetsMode = "include" | "exclude"

interface Options {
  triggers?: string[]
  triggerMode?: TriggerMode
  targets?: string[]
  targetsMode?: TargetsMode
  codemodeOn?: boolean
  codemodeOff?: boolean
  debug?: boolean
}

const norm = (name: string) => name.trim().toLowerCase()
const OFFLINE = new Set(["disabled", "failed", "needs_auth"])
const POLL_MS = 3000
const OFF_POLLS = 4
const POLL_TIMEOUT_MS = POLL_MS * 3

const STATE_KEY = "oc-codemode-follower:active"
type Active = { dispose: () => Promise<void> }
const globals = globalThis as { [key: string]: unknown }

export default Plugin.define({
  id: "oc-codemode-follower",
  async setup(ctx) {
    const o = ((ctx as { options?: Options }).options ?? {}) as Options
    const triggers = (o.triggers ?? ["rea"]).map(norm)
    const allMode = o.triggerMode === "all"
    const targets = (o.targets ?? []).map(norm)
    const exclude = o.targetsMode === "exclude"
    const onValue = o.codemodeOn ?? true
    const offValue = o.codemodeOff ?? false
    const debug = o.debug === true

    const logFile = join(homedir(), ".local", "share", "opencode", "log", "codemode-follower.log")
    if (debug) {
      try {
        mkdirSync(dirname(logFile), { recursive: true })
      } catch {}
    }
    const log = (line: string) => {
      if (!debug) return
      try {
        if (statSync(logFile).size > 1_000_000) truncateSync(logFile, 0)
      } catch {}
      try {
        appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
      } catch {}
    }

    let lastOn = false
    let offStreak = 0
    let busy = false
    let statuses = new Map<string, string>()

    const readStatuses = async () => {
      const res = await ctx.mcp.list()
      const next = new Map<string, string>()
      for (const server of res.data) {
        next.set(norm(server.name), typeof server.status === "string" ? server.status : server.status.status)
      }
      statuses = next
    }
    const isOn = () => {
      const states = triggers.map((t) => statuses.get(t))
      return allMode
        ? states.length > 0 && states.every((s) => s === "connected")
        : states.some((s) => s === "connected")
    }
    const isOffline = () => {
      const states = triggers.map((t) => statuses.get(t))
      return states.length > 0 && states.every((s) => s !== undefined && OFFLINE.has(s))
    }

    const register = () =>
      ctx.mcp.transform((editor) => {
        const value = lastOn ? onValue : offValue
        const changed: string[] = []
        for (const [name, current] of editor.list()) {
          const key = norm(name)
          const flag = current as { codemode?: boolean; disabled?: boolean }
          if (triggers.includes(key)) {
            if (lastOn && flag.disabled !== undefined) {
              editor.update(name, (server) => {
                delete (server as { disabled?: boolean }).disabled
              })
              changed.push(`${name}:enabled`)
            } else if (
              !lastOn &&
              offStreak >= OFF_POLLS &&
              flag.disabled !== true &&
              statuses.get(key) !== "connected"
            ) {
              editor.update(name, (server) => {
                ;(server as { disabled?: boolean }).disabled = true
              })
              changed.push(`${name}:disabled`)
            }
            continue
          }
          if (flag.disabled === true) continue
          const hit = exclude ? !targets.includes(key) : targets.includes(key) || targets.includes("*")
          if (!hit || flag.codemode === value) continue
          try {
            editor.update(name, (server) => {
              ;(server as { codemode?: boolean }).codemode = value
            })
            changed.push(name)
          } catch (error) {
            log(`apply: update ${name} failed: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        log(
          `apply: ${triggers.join("/")}=${lastOn ? "ON" : "OFF"}; changed: ${changed.length ? changed.join(", ") : "none"}`,
        )
      })

    const previous = globals[STATE_KEY] as Active | undefined
    if (previous) {
      log("setup: replacing instance from a previous hot reload")
      await previous.dispose().catch(() => {})
    }

    try {
      await readStatuses()
    } catch (error) {
      log(`seed list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    lastOn = isOn()
    let registration = await register()
    const active: Active = {
      dispose: async () => {
        await registration.dispose().catch(() => {})
      },
    }
    globals[STATE_KEY] = active

    const commit = async () => {
      await registration.dispose().catch(() => {})
      registration = await register()
    }

    const attempt = async () => {
      try {
        await readStatuses()
        if (isOn()) {
          offStreak = 0
          if (!lastOn) {
            lastOn = true
            log(`poll: ${triggers.join("/")} connected -> ON`)
            await commit()
          }
        } else if (isOffline()) {
          offStreak++
          if (offStreak >= OFF_POLLS && lastOn) {
            lastOn = false
            log(`poll: ${triggers.join("/")} offline x${offStreak} -> OFF`)
            await commit()
          }
        }
      } catch (error) {
        log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const tick = async () => {
      if (busy) return
      busy = true
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          attempt(),
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              log("poll: timed out, will retry")
              resolve()
            }, POLL_TIMEOUT_MS)
          }),
        ])
      } finally {
        clearTimeout(timer)
        busy = false
      }
    }
    const timer = setInterval(() => void tick(), POLL_MS)

    log(`setup: triggers=${triggers.join("/")} mode=${allMode ? "all" : "any"} initial=${lastOn ? "ON" : "OFF"}`)

    return () => {
      clearInterval(timer)
      void active.dispose()
      if ((globals[STATE_KEY] as Active | undefined) === active) delete globals[STATE_KEY]
    }
  },
})
