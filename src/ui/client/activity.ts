import type { ActivityItem } from "./types"

export type ActivityDisplayGroups = {
  primary: ActivityItem[]
  secondary: ActivityItem[]
}

export function groupActivityForDisplay(activity: ActivityItem[]): ActivityDisplayGroups {
  const primary: ActivityItem[] = []
  const secondary: ActivityItem[] = []
  for (const item of activity) {
    if (isPrimaryActivity(item)) primary.push(item)
    else secondary.push(item)
  }
  return {
    primary: primary.reverse(),
    secondary: secondary.reverse(),
  }
}

export function isPrimaryActivity(item: ActivityItem) {
  if (item.kind === "permission" || item.kind === "system") return false
  if (item.source === "llm_intent") return true
  if (isGenericShellActivity(item)) return false
  if (item.kind === "file" && isTemporaryOrOutsideTarget(item.target)) return false
  if (item.title.startsWith("Used tool:")) return false
  return true
}

function isGenericShellActivity(item: ActivityItem) {
  if (item.kind !== "shell") return false
  return item.title === "Ran command" || item.title === "Command failed"
}

function isTemporaryOrOutsideTarget(target: string | undefined) {
  if (!target) return false
  return target.startsWith("../") || target.startsWith("/tmp/") || target.includes("/tmp/")
}
