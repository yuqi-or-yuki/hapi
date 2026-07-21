import { MessagePrimitive, useAssistantState } from '@assistant-ui/react'
import { MarkdownText } from '@/components/assistant-ui/markdown-text'
import { Reasoning, ReasoningGroup } from '@/components/assistant-ui/reasoning'
import { HappyToolMessage } from '@/components/AssistantChat/messages/ToolMessage'
import { CliOutputBlock } from '@/components/CliOutputBlock'
import type { HappyChatMessageMetadata } from '@/lib/assistant-runtime'
import { getAssistantCopyText } from '@/components/AssistantChat/messages/assistantCopyText'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { CodexReviewCard } from '@/components/AssistantChat/messages/CodexReviewCard'
import { MessageActions } from '@/components/AssistantChat/messages/MessageActions'

const TOOL_COMPONENTS = {
    Fallback: HappyToolMessage
} as const

const MESSAGE_PART_COMPONENTS = {
    Text: MarkdownText,
    Reasoning: Reasoning,
    ReasoningGroup: ReasoningGroup,
    tools: TOOL_COMPONENTS
} as const

function formatSentTime(value: Date | number | string | null | undefined): string | null {
    if (value == null) return null
    const date = value instanceof Date
        ? value
        : new Date(typeof value === 'number' && value < 1_000_000_000_000 ? value * 1000 : value)
    const ms = date.getTime()
    if (!Number.isFinite(ms)) return null
    return date.toLocaleTimeString([], {
        hour: 'numeric',
        minute: '2-digit'
    })
}

function SentTime({ value }: { value: Date | number | string | null | undefined }) {
    const label = formatSentTime(value)
    if (!label) return null

    return (
        <div className="mt-1 px-0.5 text-right text-[10px] leading-tight text-[var(--app-hint)] opacity-60" title={`Sent ${label}`}>
            {label}
        </div>
    )
}

export function HappyAssistantMessage() {
    const messageId = useAssistantState(({ message }) => message.id)
    const isCliOutput = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'cli-output'
    })
    const codexReview = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        return custom?.kind === 'codex-review' ? custom.review : undefined
    })
    const cliText = useAssistantState(({ message }) => {
        const custom = message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined
        if (custom?.kind !== 'cli-output') return ''
        return message.content.find((part) => part.type === 'text')?.text ?? ''
    })
    const toolOnly = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return false
        const parts = message.content
        return parts.length > 0 && parts.every((part) => part.type === 'tool-call')
    })
    const copyText = useAssistantState(({ message }) => {
        if (message.role !== 'assistant') return ''
        return getAssistantCopyText(message.content)
    })

    const durationMs = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.durationMs)
    const usage = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.usage)
    const messageModel = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.model)
    const turnCount = useAssistantState(({ message }) => (message.metadata.custom as Partial<HappyChatMessageMetadata> | undefined)?.turnCount)

    const metadata = { durationMs, usage, model: messageModel ?? null, turnCount }

    const rootClass = toolOnly
        ? 'py-1 min-w-0 max-w-full overflow-x-hidden'
        : 'px-1 min-w-0 max-w-full overflow-x-hidden'

    return (
        <MessagePrimitive.Root
            id={getConversationMessageAnchorId(messageId)}
            className={`happy-message ${rootClass} scroll-mt-4`}
        >
            {isCliOutput
                ? <CliOutputBlock text={cliText} />
                : codexReview
                    ? <CodexReviewCard review={codexReview} />
                    : <MessagePrimitive.Content components={MESSAGE_PART_COMPONENTS} />}
            <MessageActions align="start" copyText={copyText || undefined} metadata={metadata} />
        </MessagePrimitive.Root>
    )
}
