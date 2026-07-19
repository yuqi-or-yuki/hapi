import { describe, expect, it, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

const mermaidMocks = vi.hoisted(() => ({
    initializeMock: vi.fn(),
    renderMock: vi.fn().mockResolvedValue({
        svg: '<svg data-testid="mock-mermaid"></svg>'
    })
}))

vi.mock('mermaid', () => ({
    default: {
        initialize: mermaidMocks.initializeMock,
        render: mermaidMocks.renderMock,
    }
}))

import { MermaidDiagram, repairMermaidSource } from '@/components/assistant-ui/mermaid-diagram'
import { MARKDOWN_COMPONENTS_BY_LANGUAGE } from '@/components/assistant-ui/markdown-text'

describe('MermaidDiagram', () => {
    it('is wired into the shared markdown language overrides and renders svg output', async () => {
        render(
            <MermaidDiagram
                code={'graph TD\nA --> B'}
                language="mermaid"
                components={{
                    Pre: (props) => <pre {...props} />,
                    Code: (props) => <code {...props} />,
                }}
            />
        )

        await waitFor(() => {
            const diagram = document.querySelector('[data-mermaid-diagram][data-rendered="true"]')
            expect(diagram).toBeTruthy()
            expect(diagram?.querySelector('[data-testid="mock-mermaid"]')).toBeTruthy()
        })

        expect(mermaidMocks.initializeMock).toHaveBeenCalled()
        expect(mermaidMocks.initializeMock).toHaveBeenCalledWith(expect.objectContaining({
            securityLevel: 'strict'
        }))
        expect(mermaidMocks.renderMock).toHaveBeenCalledWith(expect.stringContaining('mermaid-'), 'graph TD\nA --> B')
        expect(MARKDOWN_COMPONENTS_BY_LANGUAGE.mermaid.SyntaxHighlighter).toBe(MermaidDiagram)
    })

    it('retries with a repaired source when the original fails to render', async () => {
        mermaidMocks.renderMock.mockReset()
        mermaidMocks.renderMock
            .mockRejectedValueOnce(new Error('Parse error'))
            .mockResolvedValueOnce({ svg: '<svg data-testid="repaired-mermaid"></svg>' })

        render(
            <MermaidDiagram
                code={'flowchart TD\nA[Quality (size, coherence)] --> B[Done]'}
                language="mermaid"
                components={{
                    Pre: (props) => <pre {...props} />,
                    Code: (props) => <code {...props} />,
                }}
            />
        )

        await waitFor(() => {
            expect(document.querySelector('[data-testid="repaired-mermaid"]')).toBeTruthy()
        })

        // Second call receives the repaired source with the label quoted.
        expect(mermaidMocks.renderMock).toHaveBeenLastCalledWith(
            expect.stringContaining('-repaired'),
            expect.stringContaining('A["Quality (size, coherence)"]')
        )
    })
})

describe('repairMermaidSource', () => {
    it('quotes node labels containing parentheses', () => {
        expect(repairMermaidSource('A[Quality (size, coherence)]'))
            .toBe('A["Quality (size, coherence)"]')
    })

    it('quotes labels containing angle-bracket line breaks', () => {
        expect(repairMermaidSource('A[Line one<br/>(detail)]'))
            .toBe('A["Line one<br/>(detail)"]')
    })

    it('quotes rhombus labels too', () => {
        expect(repairMermaidSource('B{Pick (a/b)}')).toBe('B{"Pick (a/b)"}')
    })

    it('leaves plain labels untouched', () => {
        const src = 'flowchart TD\nA[Start] --> B[End]'
        expect(repairMermaidSource(src)).toBe(src)
    })

    it('does not double-quote already-quoted labels', () => {
        const src = 'A["Already (quoted)"]'
        expect(repairMermaidSource(src)).toBe(src)
    })

    it('does not touch compound bracket shapes', () => {
        const src = 'A[[Subroutine]]'
        expect(repairMermaidSource(src)).toBe(src)
    })
})
