import { homedir } from "node:os"
import { join } from "node:path"
import { Plugin } from "@opencode/plugin"
import pTimeout from "p-timeout"
import { createLogger } from "./utils.ts"

interface Options {
  triggers?: string[]
  triggerMode?: "any" | "all"
  targets?: string[]
  targetsMode?: "include" | "exclude"
  codemodeOn?: boolean
  codemodeOff?: boolean
  debug?: boolean
}

type Active = { dispose: () => Promise<void> }

export default Plugin.define({
  id: "oc-codemode-follower",
  async setup(ctx) {
    const o = { ...ctx.options } as Options
    const triggers = (o.triggers ?? ["rea"]).map((name) => name.trim().toLowerCase())
    const targets = (o.targets ?? []).map((name) => name.trim().toLowerCase())
    const log = createLogger(
      join(homedir(), ".local", "share", "opencode", "log", "codemode-follower.log"),
      o.debug === true,
    )

    let lastOn = false
    let offStreak = 0
    let busy = false
    let disposed = false
    let statuses = new Map<string, string>()

    const readStatuses = async () => {
      const res = await pTimeout(ctx.mcp.list(), { milliseconds: 9000 })
      const next = new Map<string, string>()
      for (const server of res.data) {
        next.set(
          server.name.trim().toLowerCase(),
          typeof server.status === "string" ? server.status : server.status.status,
        )
      }
      statuses = next
    }
    const register = () =>
      ctx.mcp.transform((editor) => {
        const changed: string[] = []
        for (const [name, current] of editor.list()) {
          const key = name.trim().toLowerCase()
          if (triggers.includes(key)) {
            if (lastOn && current.disabled !== undefined) {
              editor.update(name, (server) => {
                delete server.disabled
              })
              changed.push(`${name}:enabled`)
            } else if (!lastOn && offStreak >= 4 && current.disabled !== true && statuses.get(key) !== "connected") {
              editor.update(name, (server) => {
                server.disabled = true
              })
              changed.push(`${name}:disabled`)
            }
            continue
          }
          if (current.disabled === true) continue
          if (
            !(o.targetsMode === "exclude" ? !targets.includes(key) : targets.includes(key) || targets.includes("*")) ||
            current.codemode === (lastOn ? (o.codemodeOn ?? true) : (o.codemodeOff ?? false))
          ) {
            continue
          }
          try {
            editor.update(name, (server) => {
              server.codemode = lastOn ? (o.codemodeOn ?? true) : (o.codemodeOff ?? false)
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

    const previous = (globalThis as Record<string, unknown>)["oc-codemode-follower:active"] as Active | undefined
    if (previous) {
      log("setup: replacing instance from a previous hot reload")
      await previous.dispose().catch(() => {})
    }

    try {
      await readStatuses()
    } catch (error) {
      log(`seed list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    lastOn =
      o.triggerMode === "all"
        ? triggers.length > 0 && triggers.every((trigger) => statuses.get(trigger) === "connected")
        : triggers.some((trigger) => statuses.get(trigger) === "connected")
    let registration = await register()
    let interval: ReturnType<typeof setInterval>
    const active: Active = {
      dispose: async () => {
        disposed = true
        clearInterval(interval)
        await registration.dispose().catch(() => {})
      },
    }
    ;(globalThis as Record<string, unknown>)["oc-codemode-follower:active"] = active

    interval = setInterval(() => {
      if (busy || disposed) return
      busy = true
      void (async () => {
        try {
          await readStatuses()
          if (disposed) return
          if (
            o.triggerMode === "all"
              ? triggers.length > 0 && triggers.every((trigger) => statuses.get(trigger) === "connected")
              : triggers.some((trigger) => statuses.get(trigger) === "connected")
          ) {
            offStreak = 0
            if (lastOn) return
            lastOn = true
            log(`poll: ${triggers.join("/")} connected -> ON`)
          } else if (
            triggers.length > 0 &&
            triggers.every((trigger) => ["disabled", "failed", "needs_auth"].includes(statuses.get(trigger) ?? ""))
          ) {
            offStreak++
            if (offStreak < 4 || !lastOn) return
            lastOn = false
            log(`poll: ${triggers.join("/")} offline x${offStreak} -> OFF`)
          } else {
            offStreak = 0
            return
          }
          await registration.dispose().catch(() => {})
          if (disposed) return
          const next = await register().catch((error: unknown) => {
            lastOn = !lastOn
            throw new Error("MCP transform registration failed", { cause: error })
          })
          if (disposed) await next.dispose().catch(() => {})
          else registration = next
        } catch (error) {
          log(`poll failed: ${error instanceof Error ? error.message : String(error)}`)
        } finally {
          busy = false
        }
      })()
    }, 3000)

    log(
      `setup: triggers=${triggers.join("/")} mode=${o.triggerMode === "all" ? "all" : "any"} initial=${lastOn ? "ON" : "OFF"}`,
    )

    return () => {
      void active.dispose()
      if ((globalThis as Record<string, unknown>)["oc-codemode-follower:active"] === active) {
        delete (globalThis as Record<string, unknown>)["oc-codemode-follower:active"]
      }
    }
  },
})
