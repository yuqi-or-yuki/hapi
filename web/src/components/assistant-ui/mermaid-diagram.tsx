import type { SyntaxHighlighterProps } from '@assistant-ui/react-markdown'
import { useEffect, useId, useState, type ComponentPropsWithoutRef } from 'react'
import { cn } from '@/lib/utils'

let initializedTheme: 'light' | 'dark' | null = null
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null

async function getMermaid() {
    if (!mermaidPromise) {
        mermaidPromise = import('mermaid').then((module) => module.default)
    }
    return mermaidPromise
}

function resolveTheme() {
    if (typeof document === 'undefined') return 'light' as const
    return document.documentElement.dataset.theme === 'dark' ? 'dark' as const : 'light' as const
}

// LLM-generated mermaid frequently leaves special characters (parentheses,
// angle brackets, slashes) unquoted inside node labels, which mermaid's
// parser rejects — e.g. `A[Quality (size, coherence)]` or `A[A / B]`.
// Wrapping such label text in quotes makes it parse. We only apply this as a
// *repair* after the original source fails to render, and re-validate the
// result before using it, so valid diagrams are never altered.
const LABEL_NEEDS_QUOTING = /[()<>/]/

function quoteNodeLabels(source: string, open: '[' | '{', close: ']' | '}'): string {
    // Inner text must not contain the same bracket family, so we don't mangle
    // compound shapes like [[subroutine]] or {{hexagon}}.
    const innerClass = open === '[' ? '[^[\\]]+' : '[^{}]+'
    const re = new RegExp(`\\${open}(${innerClass})\\${close}`, 'g')
    return source.replace(re, (match, inner: string) => {
        const trimmed = inner.trim()
        if (!trimmed) return match
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) return match
        if (!LABEL_NEEDS_QUOTING.test(inner)) return match
        return `${open}"${inner.replace(/"/g, '&quot;')}"${close}`
    })
}

export function repairMermaidSource(source: string): string {
    let repaired = quoteNodeLabels(source, '[', ']')
    repaired = quoteNodeLabels(repaired, '{', '}')
    return repaired
}

async function ensureMermaid(theme: 'light' | 'dark') {
    const mermaid = await getMermaid()
    if (initializedTheme === theme) return mermaid

    mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        themeVariables: theme === 'dark'
            ? {
                primaryColor: '#323843',
                primaryTextColor: '#edf1f5',
                primaryBorderColor: '#6d8fd6',
                lineColor: '#94a3b8',
                tertiaryColor: '#2d3440',
                background: '#2a2f35',
                mainBkg: '#323843',
                secondBkg: '#2d3440',
                tertiaryBkg: '#29313b',
                clusterBkg: '#2d3440',
                clusterBorder: '#6d8fd6',
                edgeLabelBackground: '#2a2f35',
            }
            : {
                primaryColor: '#f8fbff',
                primaryTextColor: '#2d333b',
                primaryBorderColor: '#b8cdfd',
                lineColor: '#94a3b8',
                tertiaryColor: '#eef4ff',
                background: '#f5f6f7',
                mainBkg: '#f8fbff',
                secondBkg: '#eef4ff',
                tertiaryBkg: '#edf3fb',
                clusterBkg: '#eef4ff',
                clusterBorder: '#b8cdfd',
                edgeLabelBackground: '#f5f6f7',
            },
    })

    initializedTheme = theme
    return mermaid
}

function MermaidFallback(props: ComponentPropsWithoutRef<'pre'> & { code: string }) {
    return (
        <pre
            className={cn(
                'aui-mermaid-fallback m-0 overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] p-4 text-sm text-[var(--app-fg)]',
                props.className
            )}
        >
            <code>{props.code}</code>
        </pre>
    )
}

export function MermaidDiagram(props: SyntaxHighlighterProps) {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => resolveTheme())
    const [renderError, setRenderError] = useState(false)
    const [svg, setSvg] = useState<string | null>(null)
    const id = useId().replace(/:/g, '-')

    useEffect(() => {
        if (typeof document === 'undefined') return undefined

        const root = document.documentElement
        const observer = new MutationObserver(() => {
            setTheme(resolveTheme())
        })

        observer.observe(root, {
            attributes: true,
            attributeFilter: ['data-theme'],
        })

        return () => observer.disconnect()
    }, [])

    useEffect(() => {
        let cancelled = false

        const render = async () => {
            const mermaid = await ensureMermaid(theme)
            try {
                const result = await mermaid.render(`mermaid-${id}`, props.code)
                if (cancelled) return
                setSvg(result.svg)
                setRenderError(false)
                return
            } catch (err) {
                console.error('[MermaidDiagram] initial render failed:', err, '\nSource:\n', props.code)
            }

            // Retry once with common LLM syntax mistakes auto-repaired. Use a
            // fresh render id since the failed attempt may have left a stale
            // element behind.
            const repaired = repairMermaidSource(props.code)
            if (!cancelled && repaired !== props.code) {
                try {
                    const result = await mermaid.render(`mermaid-${id}-repaired`, repaired)
                    if (cancelled) return
                    setSvg(result.svg)
                    setRenderError(false)
                    return
                } catch (err) {
                    console.error('[MermaidDiagram] repaired render also failed:', err, '\nRepaired source:\n', repaired)
                }
            }

            if (cancelled) return
            setSvg(null)
            setRenderError(true)
        }

        void render()

        return () => {
            cancelled = true
        }
    }, [id, props.code, theme])

    if (renderError || !svg) {
        return <MermaidFallback code={props.code} data-mermaid-diagram data-rendered="false" />
    }

    return (
        <div
            data-mermaid-diagram
            data-rendered="true"
            className="aui-mermaid-diagram overflow-x-auto rounded-b-xl bg-[var(--app-code-bg)] px-4 py-3"
        >
            <div
                className="min-w-fit [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
                dangerouslySetInnerHTML={{ __html: svg }}
            />
        </div>
    )
}
