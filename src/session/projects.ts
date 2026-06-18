import { mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"

import { PixiuError } from "../shared/errors"
import { createID } from "../shared/id"
import type { ProjectRecord } from "./types"

type ProjectState = {
  currentProjectId?: string
  projects: ProjectRecord[]
}

const PROJECTS_FILE = "projects.json"
export const DEFAULT_PROJECT_ID = "project_default"

export class JsonProjectStore {
  constructor(
    private readonly stateDir: string,
    private readonly defaultRootPath: string,
  ) {}

  private path() {
    return join(this.stateDir, PROJECTS_FILE)
  }

  async list() {
    const state = await this.readState()
    return state.projects
  }

  async current() {
    const state = await this.readState()
    return state.projects.find((project) => project.id === state.currentProjectId) ?? state.projects[0]!
  }

  async get(projectId: string) {
    const state = await this.readState()
    return state.projects.find((project) => project.id === projectId)
  }

  async create(input: { name?: string; rootPath?: string }) {
    const state = await this.readState()
    const now = new Date().toISOString()
    const rootPath = normalizeRootPath(input.rootPath ?? this.defaultRootPath, this.defaultRootPath)
    const project: ProjectRecord = {
      id: createID("project"),
      name: normalizedName(input.name) ?? defaultProjectName(rootPath),
      rootPath,
      createdAt: now,
      updatedAt: now,
    }
    state.projects.push(project)
    state.currentProjectId = project.id
    await this.writeState(state)
    return project
  }

  async update(projectId: string, patch: { name?: string; rootPath?: string }) {
    const state = await this.readState()
    const index = state.projects.findIndex((project) => project.id === projectId)
    if (index < 0) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
    const current = state.projects[index]!
    const rootPath = patch.rootPath === undefined ? current.rootPath : normalizeRootPath(patch.rootPath, this.defaultRootPath)
    const name = normalizedName(patch.name) ?? current.name
    const updated = {
      ...current,
      name,
      rootPath,
      updatedAt: new Date().toISOString(),
    }
    state.projects[index] = updated
    await this.writeState(state)
    return updated
  }

  async remove(projectId: string) {
    const state = await this.readState()
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
    if (state.projects.length <= 1) {
      throw new PixiuError("Cannot remove the last project entry.", { code: "PROJECT_DELETE_LAST" })
    }
    state.projects = state.projects.filter((item) => item.id !== projectId)
    if (state.currentProjectId === projectId) {
      const nextProjectId = state.projects[0]?.id
      if (nextProjectId) state.currentProjectId = nextProjectId
      else delete state.currentProjectId
    }
    await this.writeState(state)
    return project
  }

  async setCurrent(projectId: string) {
    const state = await this.readState()
    const project = state.projects.find((item) => item.id === projectId)
    if (!project) throw new PixiuError(`Unknown project: ${projectId}`, { code: "PROJECT_NOT_FOUND" })
    state.currentProjectId = project.id
    await this.writeState(state)
    return project
  }

  private async readState(): Promise<ProjectState> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.path(), "utf8"))
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error
      const state = defaultProjectState(this.defaultRootPath)
      await this.writeState(state)
      return state
    }

    const state = normalizeProjectState(parsed, this.defaultRootPath)
    await this.writeState(state)
    return state
  }

  private async writeState(state: ProjectState) {
    await mkdir(dirname(this.path()), { recursive: true })
    await writeFile(this.path(), `${JSON.stringify(state, null, 2)}\n`, "utf8")
  }
}

function defaultProjectState(rootPath: string): ProjectState {
  const now = new Date().toISOString()
  const project: ProjectRecord = {
    id: DEFAULT_PROJECT_ID,
    name: defaultProjectName(rootPath),
    rootPath,
    createdAt: now,
    updatedAt: now,
  }
  return { currentProjectId: project.id, projects: [project] }
}

function normalizeProjectState(value: unknown, defaultRootPath: string): ProjectState {
  const object = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const projects = Array.isArray(object.projects)
    ? object.projects.map((project) => normalizeProject(project, defaultRootPath)).filter((project): project is ProjectRecord => Boolean(project))
    : []
  if (!projects.length) projects.push(defaultProjectState(defaultRootPath).projects[0]!)
  const currentProjectId = typeof object.currentProjectId === "string" && projects.some((project) => project.id === object.currentProjectId)
    ? object.currentProjectId
    : projects[0]?.id
  return {
    ...(currentProjectId ? { currentProjectId } : {}),
    projects,
  }
}

function normalizeProject(value: unknown, defaultRootPath: string): ProjectRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const object = value as Record<string, unknown>
  const id = typeof object.id === "string" && object.id.trim() ? object.id.trim() : undefined
  if (!id) return undefined
  const rootPath = normalizeRootPath(typeof object.rootPath === "string" ? object.rootPath : defaultRootPath, defaultRootPath)
  const now = new Date().toISOString()
  return {
    id,
    name: normalizedName(object.name) ?? defaultProjectName(rootPath),
    rootPath,
    createdAt: typeof object.createdAt === "string" ? object.createdAt : now,
    updatedAt: typeof object.updatedAt === "string" ? object.updatedAt : now,
  }
}

function normalizedName(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : undefined
}

function normalizeRootPath(value: string, defaultRootPath: string) {
  return resolve(defaultRootPath, value)
}

function defaultProjectName(rootPath: string) {
  return basename(rootPath) || "Project"
}
