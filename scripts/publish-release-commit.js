import { appendFileSync } from "node:fs"
import { join } from "node:path"
import { $ } from "bun"

try {
  for (const name of ["GITHUB_OUTPUT", "VERSION", "GH_TOKEN", "DEFAULT_BRANCH"]) {
    if (!process.env[name]) throw new Error(`${name} is not set`)
  }

  await $`git config user.name 'github-actions[bot]'`.quiet()
  await $`git config user.email 'github-actions[bot]@users.noreply.github.com'`.quiet()
  await $`git add -u -- ${join(process.env.PACKAGE_DIR ?? ".", "package.json")} bun.lock`.quiet()

  const tagExists =
    (await $`git show-ref --verify --quiet ${`refs/tags/v${process.env.VERSION}`}`.quiet().nothrow()).exitCode === 0
  const staged = (await $`git diff --cached --quiet`.quiet().nothrow()).exitCode !== 0
  if (!staged && tagExists) {
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${(await $`git rev-parse HEAD`.text()).trim()}\n`)
    console.log(`Tag v${process.env.VERSION} already points at the checked version; nothing to commit.`)
  } else {
    if (staged) await $`git commit -m ${`chore(release): bump version to ${process.env.VERSION}`}`.quiet()
    const releaseSha = (await $`git rev-parse HEAD`.text()).trim()

    if (tagExists) {
      await $`git fetch origin ${process.env.DEFAULT_BRANCH}`.quiet()
      await $`git checkout --detach FETCH_HEAD`.quiet()
      const picked = await $`git cherry-pick ${releaseSha}`.quiet().nothrow()
      if (picked.exitCode !== 0) {
        if ((await $`git diff --cached --quiet`.quiet().nothrow()).exitCode !== 0) {
          throw new Error(
            `\`git cherry-pick ${releaseSha}\` failed: ${picked.stderr.toString().trim() || picked.stdout.toString().trim()}`,
          )
        }
        await $`git cherry-pick --skip`.quiet()
        console.log(
          `Version bump for v${process.env.VERSION} is already on ${process.env.DEFAULT_BRANCH}; nothing to cherry-pick.`,
        )
      } else {
        await $`git -c 'credential.helper=!gh auth git-credential' push origin ${`HEAD:refs/heads/${process.env.DEFAULT_BRANCH}`}`.quiet()
        console.log(`Cherry-picked the version bump for v${process.env.VERSION} onto ${process.env.DEFAULT_BRANCH}.`)
      }
    } else {
      await $`git tag ${`v${process.env.VERSION}`}`.quiet()
      await $`git -c 'credential.helper=!gh auth git-credential' push --atomic origin ${`HEAD:refs/heads/${process.env.DEFAULT_BRANCH}`} ${`refs/tags/v${process.env.VERSION}`}`.quiet()
      console.log(`Tagged v${process.env.VERSION} and pushed it with ${process.env.DEFAULT_BRANCH}.`)
    }

    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${releaseSha}\n`)
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message)
  process.exitCode = 1
}
