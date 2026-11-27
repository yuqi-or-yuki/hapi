export type PipelineLink = { from: string; to: string; pending: number; handled: number }

export type Pipeline<T> = {
    /** Workers by distance from the start: stage 0 feeds stage 1, and so on. */
    stages: T[][]
    links: PipelineLink[]
}

/**
 * Splits the swarm into pipelines (workers joined by links, laid out in the
 * order work flows) and the workers that stand alone. Links to a worker that
 * is no longer in the swarm are ignored.
 */
export function buildPipelines<T>(
    workers: readonly T[],
    links: readonly PipelineLink[],
    idOf: (worker: T) => string
): { pipelines: Pipeline<T>[]; alone: T[] } {
    const byId = new Map(workers.map((worker) => [idOf(worker), worker]))
    const live = links.filter((link) => byId.has(link.from) && byId.has(link.to))

    // Group workers that are connected, in either direction.
    const group = new Map<string, string>()
    const find = (id: string): string => {
        const parent = group.get(id) ?? id
        if (parent === id) return id
        const root = find(parent)
        group.set(id, root)
        return root
    }
    for (const link of live) group.set(find(link.from), find(link.to))

    // A worker's stage is the longest chain of links leading to it.
    const depth = new Map<string, number>()
    const depthOf = (id: string, seen: Set<string> = new Set()): number => {
        const known = depth.get(id)
        if (known !== undefined) return known
        if (seen.has(id)) return 0
        seen.add(id)
        const value = Math.max(0, ...live.filter((link) => link.to === id).map((link) => depthOf(link.from, seen) + 1))
        depth.set(id, value)
        return value
    }

    const pipelines = new Map<string, Pipeline<T>>()
    for (const link of live) {
        const root = find(link.from)
        const pipeline = pipelines.get(root) ?? { stages: [], links: [] }
        pipeline.links.push(link)
        pipelines.set(root, pipeline)
    }
    const alone: T[] = []
    for (const worker of workers) {
        const id = idOf(worker)
        const pipeline = pipelines.get(find(id))
        if (!pipeline) { alone.push(worker); continue }
        const stage = depthOf(id)
        while (pipeline.stages.length <= stage) pipeline.stages.push([])
        pipeline.stages[stage].push(worker)
    }
    return { pipelines: [...pipelines.values()], alone }
}

/**
 * For the office: each worker in a pipeline walks behind the one before it,
 * in the order work flows, so a pipeline moves through the rooms as a train.
 * Maps a follower's id to the id it follows; the head of a pipeline and
 * workers on their own are absent.
 */
export function trainOrder<T>(workers: readonly T[], links: readonly PipelineLink[], idOf: (worker: T) => string): Map<string, string> {
    const follows = new Map<string, string>()
    for (const pipeline of buildPipelines(workers, links, idOf).pipelines) {
        const line = pipeline.stages.flat().map(idOf)
        for (let i = 1; i < line.length; i += 1) follows.set(line[i], line[i - 1])
    }
    return follows
}

/**
 * The links that feed a stage. Every link ends at exactly one worker, so the
 * connectors above each stage between them account for the whole pipeline —
 * except under a cycle, where a link can end in stage 0; `looseLinks` has those.
 */
export function linksInto<T>(pipeline: Pipeline<T>, stage: number, idOf: (worker: T) => string): PipelineLink[] {
    const ids = new Set(pipeline.stages[stage]?.map(idOf))
    return pipeline.links.filter((link) => ids.has(link.to))
}

/** Links no connector shows: only a cycle can put one here. */
export function looseLinks<T>(pipeline: Pipeline<T>, idOf: (worker: T) => string): PipelineLink[] {
    const shown = new Set(pipeline.stages.flatMap((_, stage) => (stage > 0 ? linksInto(pipeline, stage, idOf) : [])))
    return pipeline.links.filter((link) => !shown.has(link))
}
