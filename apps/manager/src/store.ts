import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { DATA_DIR, PROJECTS_FILE } from './config.js'
import { ProjectConfig } from './types.js'

const FileShape = z.object({
  version: z.literal(1).default(1),
  projects: z.array(ProjectConfig).default([]),
})

let cache: ProjectConfig[] | null = null

async function read(): Promise<ProjectConfig[]> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(PROJECTS_FILE, 'utf8')
    const parsed = FileShape.parse(JSON.parse(raw))
    cache = parsed.projects
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      cache = []
    } else {
      throw new Error(
        `Could not read ${PROJECTS_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return cache
}

async function write(projects: ProjectConfig[]): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true })
  const body = JSON.stringify({ version: 1, projects }, null, 2)
  // Write-then-rename so a crash mid-write can't leave a truncated registry.
  const tmp = path.join(DATA_DIR, `.projects.${process.pid}.tmp`)
  await fs.writeFile(tmp, body, 'utf8')
  await fs.rename(tmp, PROJECTS_FILE)
  cache = projects
}

export async function listProjects(): Promise<ProjectConfig[]> {
  return [...(await read())]
}

export async function getProject(id: string): Promise<ProjectConfig | undefined> {
  return (await read()).find((p) => p.id === id)
}

export async function requireProject(id: string): Promise<ProjectConfig> {
  const project = await getProject(id)
  if (!project) throw new HttpError(404, `No project registered with id "${id}"`)
  return project
}

export async function upsertProject(project: ProjectConfig): Promise<ProjectConfig> {
  const projects = await read()
  const idx = projects.findIndex((p) => p.id === project.id)
  const next = [...projects]
  if (idx >= 0) next[idx] = project
  else next.push(project)
  await write(next)
  return project
}

export async function deleteProject(id: string): Promise<boolean> {
  const projects = await read()
  const next = projects.filter((p) => p.id !== id)
  if (next.length === projects.length) return false
  await write(next)
  return true
}

/** Error carrying an HTTP status so routes can translate it without try/catch soup. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}
