import type { PixiuConfig, PermissionAction } from "../config/defaults"
import type { PermissionDecision, PermissionManager, PermissionMode, PermissionRequest, PermissionRule } from "./types"

const EDIT_TOOLS = new Set(["write", "edit", "patch"])
const PLAN_ALLOWED_TOOLS = new Set(["read", "grep", "glob", "todo", "todowrite", "skill_search", "skill", "skillhub_search"])

function wildcardMatch(pattern: string, value: string) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(value)
}

export function normalizePermissionRules(config: PixiuConfig): PermissionRule[] {
  return Object.entries(config.permissions).map(([tool, rule]) => {
    if (typeof rule === "string") return { tool, action: rule }
    const normalized: PermissionRule = { tool, action: rule.action }
    if (rule.pattern) normalized.pattern = rule.pattern
    return normalized
  })
}

export function evaluatePermission(request: PermissionRequest, rules: PermissionRule[]): PermissionDecision {
  const matchedIndex = rules.findIndex((rule) => {
    const toolMatches = !rule.tool || rule.tool === request.tool || wildcardMatch(rule.tool, request.tool)
    if (!toolMatches) return false
    if (!rule.pattern) return true
    return wildcardMatch(rule.pattern, JSON.stringify(request.input))
  })
  const matched = matchedIndex === -1 ? undefined : rules[matchedIndex]
  const action: PermissionAction = matched?.action ?? (request.risk === "high" ? "ask" : "allow")
  const rule = matched
    ? {
        index: matchedIndex,
        action: matched.action,
        ...(matched.tool ? { tool: matched.tool } : {}),
        ...(matched.pattern ? { pattern: matched.pattern } : {}),
      }
    : undefined
  return {
    action,
    reason: matched
      ? `matched permission rule #${matchedIndex} for ${matched.tool ?? "*"}${matched.pattern ? ` pattern ${matched.pattern}` : ""}`
      : `default ${action}${request.risk ? ` for ${request.risk} risk` : ""}`,
    ...(rule ? { rule } : {}),
  }
}

export class StaticPermissionManager implements PermissionManager {
  constructor(
    private readonly rules: PermissionRule[],
    private readonly options: {
      nonInteractive?: boolean
      autoApprove?: boolean
      permissionMode?: PermissionMode
      ask?: (request: PermissionRequest, decision: PermissionDecision) => Promise<PermissionDecision>
    } = {},
  ) {}

  async check(request: PermissionRequest) {
    const decision = evaluatePermission(request, this.rules)
    const permissionMode = this.options.permissionMode ?? "default"
    if (permissionMode === "bypassPermissions") {
      return {
        ...decision,
        action: "allow" as const,
        ...(decision.action !== "allow" ? { originalAction: decision.action } : {}),
        reason: `permission mode bypassPermissions: ${decision.reason}`,
      }
    }
    if (permissionMode === "plan" && !PLAN_ALLOWED_TOOLS.has(request.tool)) {
      return {
        ...decision,
        action: "deny" as const,
        ...(decision.action !== "deny" ? { originalAction: decision.action } : {}),
        reason: `permission mode plan denies ${request.tool}: ${decision.reason}`,
      }
    }
    if (permissionMode === "acceptEdits" && EDIT_TOOLS.has(request.tool) && decision.action === "ask") {
      return {
        ...decision,
        action: "allow" as const,
        originalAction: "ask" as const,
        reason: `permission mode acceptEdits approved edit: ${decision.reason}`,
      }
    }
    if (decision.action !== "ask") return decision
    if (this.options.autoApprove) {
      return {
        ...decision,
        action: "allow" as const,
        originalAction: "ask" as const,
        reason: `auto-approved ask rule: ${decision.reason}`,
      }
    }
    if (this.options.nonInteractive ?? true) {
      return {
        ...decision,
        action: "deny" as const,
        originalAction: "ask" as const,
        reason: `ask denied in non-interactive mode: ${decision.reason}`,
      }
    }
    if (this.options.ask) return this.options.ask(request, decision)
    return decision
  }
}
