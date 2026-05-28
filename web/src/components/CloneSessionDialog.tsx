import { useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslation } from '@/lib/use-translation'

const MODEL_OPTIONS = [
    { value: null, label: 'Same as original' },
    { value: 'sonnet', label: 'Claude Sonnet' },
    { value: 'opus', label: 'Claude Opus' },
    { value: 'haiku', label: 'Claude Haiku' },
]

type CloneSessionDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionName: string
    onClone: (model: string | null) => Promise<void>
    isPending: boolean
}

export function CloneSessionDialog(props: CloneSessionDialogProps) {
    const { t } = useTranslation()
    const { isOpen, onClose, sessionName, onClone, isPending } = props
    const [selectedModel, setSelectedModel] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)

    const handleClone = async () => {
        setError(null)
        try {
            await onClone(selectedModel)
            onClose()
        } catch {
            setError(t('dialog.clone.error'))
        }
    }

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t('dialog.clone.title')}</DialogTitle>
                </DialogHeader>
                <div className="mt-4 flex flex-col gap-4">
                    <p className="text-sm text-[var(--app-hint)]">
                        {t('dialog.clone.description', { name: sessionName })}
                    </p>

                    <div className="flex flex-col gap-2">
                        <label className="text-xs font-medium text-[var(--app-hint)] uppercase tracking-wide">
                            {t('dialog.clone.model')}
                        </label>
                        <div className="flex flex-col gap-1.5">
                            {MODEL_OPTIONS.map((option) => (
                                <button
                                    key={String(option.value)}
                                    type="button"
                                    onClick={() => setSelectedModel(option.value)}
                                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors ${
                                        selectedModel === option.value
                                            ? 'border-[var(--app-button)] bg-[var(--app-button)]/10 text-[var(--app-fg)]'
                                            : 'border-[var(--app-border)] bg-transparent text-[var(--app-fg)] hover:bg-[var(--app-subtle-bg)]'
                                    }`}
                                    disabled={isPending}
                                >
                                    <span className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 ${
                                        selectedModel === option.value
                                            ? 'border-[var(--app-button)] bg-[var(--app-button)]'
                                            : 'border-[var(--app-hint)]'
                                    }`} />
                                    {option.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    {error ? (
                        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-900/20 dark:text-red-400">
                            {error}
                        </div>
                    ) : null}

                    <div className="flex gap-2 justify-end">
                        <Button
                            type="button"
                            variant="secondary"
                            onClick={onClose}
                            disabled={isPending}
                        >
                            {t('button.cancel')}
                        </Button>
                        <Button
                            type="button"
                            onClick={handleClone}
                            disabled={isPending}
                        >
                            {isPending ? t('dialog.clone.cloning') : t('dialog.clone.confirm')}
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
