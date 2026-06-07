import { relative, resolve } from "node:path"

import { MinicodeError } from "../shared/errors"

export type PathGuardOptions = {
  workspaceRoot: string
  workspaceOnly: boolean
}

export type GuardedPath = {
  absolutePath: string
  relativePath: string
  outsideWorkspace: boolean
}

export function isInside(parent: string, child: string) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${"/"}`) && !resolve(rel).startsWith(".."))
}

export class PathGuard {
  readonly workspaceRoot: string

  constructor(private readonly options: PathGuardOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot)
  }

  resolvePath(path: string, options: { allowOutside?: boolean } = {}): GuardedPath {
    const absolutePath = resolve(this.workspaceRoot, path)
    const outsideWorkspace = !isInside(this.workspaceRoot, absolutePath)
    if (outsideWorkspace && this.options.workspaceOnly && !options.allowOutside) {
      throw new MinicodeError(`Path escapes workspace: ${path}`, { code: "PATH_OUTSIDE_WORKSPACE" })
    }
    return {
      absolutePath,
      relativePath: relative(this.workspaceRoot, absolutePath) || ".",
      outsideWorkspace,
    }
  }
}
