// The skill sources, embedded as text. Kept apart from standardSkills.ts so
// only the runner (run by Bun, which understands text imports) loads them.
import hapiWorker from '../../skills/hapi-worker.md' with { type: 'text' }
import type { StandardSkill } from './standardSkills'

export const BUNDLED_SKILLS: StandardSkill[] = [
    { name: 'hapi-worker', source: hapiWorker },
]
