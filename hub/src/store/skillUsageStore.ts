import type { Database } from 'bun:sqlite'

export type SkillUsageRow = {
    skillName: string
    count: number
    lastUsedAt: number
}

type DbRow = {
    skill_name: string
    count: number
    last_used_at: number
}

export function recordSkillUsage(db: Database, namespace: string, skillName: string, at: number): void {
    db.query(`
        INSERT INTO skill_usage (namespace, skill_name, count, last_used_at)
        VALUES ($namespace, $skill_name, 1, $last_used_at)
        ON CONFLICT(namespace, skill_name) DO UPDATE SET
            count = count + 1,
            last_used_at = excluded.last_used_at
    `).run({ namespace, skill_name: skillName, last_used_at: at })
}

export class SkillUsageStore {
    constructor(private readonly db: Database) {}

    record(namespace: string, skillName: string, at: number = Date.now()): void {
        recordSkillUsage(this.db, namespace, skillName, at)
    }

    list(namespace: string): SkillUsageRow[] {
        return this.db.query<DbRow, [string]>(`
            SELECT skill_name, count, last_used_at FROM skill_usage
            WHERE namespace = ?
            ORDER BY count DESC, last_used_at DESC
        `).all(namespace).map(row => ({
            skillName: row.skill_name,
            count: row.count,
            lastUsedAt: row.last_used_at
        }))
    }
}
