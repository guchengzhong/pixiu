import type { PermissionAction } from "../config/defaults"
import type { JsonObject } from "../shared/json"

export type PermissionRequest = {
  tool: string
  input: JsonObject
  cwd: string
  reason?: string
  risk?: "low" | "medium" | "high"
}

export type PermissionDecision = {
  action: PermissionAction
  reason: string
  originalAction?: PermissionAction
  rule?: {
    index: number
    action: PermissionAction
    tool?: string
    pattern?: string
  }
}

export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan"

export type PermissionRule = {
  tool?: string
  pattern?: string
  action: PermissionAction
}

export interface PermissionManager {
  check(request: PermissionRequest): Promise<PermissionDecision>
}
