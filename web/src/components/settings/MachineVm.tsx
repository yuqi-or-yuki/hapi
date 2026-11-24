import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type { MachineVm } from '@hapi/protocol/schemas'
import type { ApiClient } from '@/api/client'
import type { Machine } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'

const HOURS_PER_MONTH = 730
// Google Cloud on-demand list prices (us regions, USD): E2 per vCPU-hour and
// per GB-hour of memory, balanced persistent disk per GB-month.
const E2_VCPU_HOUR = 0.021811
const E2_MEMORY_GB_HOUR = 0.002923
const DISK_GB_MONTH = 0.1

/** What a VM costs per month if it runs all the time. Null when we have no prices for its family. */
export function estimateVmMonthlyUsd(vm: Pick<MachineVm, 'machineType' | 'vcpus' | 'memoryGb' | 'diskGb'>): number | null {
    if (!vm.machineType.startsWith('e2-')) return null
    const compute = (vm.vcpus * E2_VCPU_HOUR + vm.memoryGb * E2_MEMORY_GB_HOUR) * HOURS_PER_MONTH
    return Math.round(compute + vm.diskGb * DISK_GB_MONTH)
}

export function VmCostLabel(props: { vm: MachineVm | undefined }) {
    const { t } = useTranslation()
    if (!props.vm) return null
    const monthly = estimateVmMonthlyUsd(props.vm)
    return (
        <span
            title={t('settings.machines.vm.costHint', { type: props.vm.machineType, zone: props.vm.zone })}
            className="shrink-0 rounded-full border border-[var(--app-border)] px-2 py-0.5 text-xs text-[var(--app-hint)]"
        >
            {monthly === null ? props.vm.machineType : t('settings.machines.vm.cost', { amount: monthly })}
        </span>
    )
}

/** Next free "<base>-<n>" given the VM names already online, e.g. hapi-agent-1 -> hapi-agent-2. */
export function suggestVmName(existing: string[]): string {
    const base = existing[0]?.replace(/-\d+$/, '') || 'hapi-agent'
    for (let n = 1; ; n += 1) {
        if (!existing.includes(`${base}-${n}`)) return `${base}-${n}`
    }
}

/**
 * Adds a VM by copying one that is already here: same size, same setup, and
 * its runner joins this hub, so it shows up in this list a few minutes later.
 */
export function AddVmRow(props: { api: ApiClient | null; machines: Machine[] }) {
    const { t } = useTranslation()
    const [open, setOpen] = useState(false)
    const [name, setName] = useState('')
    const template = props.machines.find((machine) =>
        machine.metadata?.vm && machine.metadata.capabilities?.includes(MACHINE_CAPABILITIES.CreateVm))

    const create = useMutation({
        mutationFn: async (vmName: string) => {
            if (!props.api || !template) throw new Error('API unavailable')
            return await props.api.createMachineVm(template.id, vmName)
        },
        onSuccess: () => setOpen(false),
    })

    if (!template?.metadata?.vm) return null
    const vm = template.metadata.vm
    const monthly = estimateVmMonthlyUsd(vm)
    const valid = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/.test(name)

    return (
        <div className="px-3 py-3 text-xs">
            {open ? (
                <form
                    className="space-y-2"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (valid) create.mutate(name)
                    }}
                >
                    <div className="text-[var(--app-hint)]">
                        {t('settings.machines.vm.addHint', { type: vm.machineType, zone: vm.zone })}
                        {monthly === null ? null : ` ${t('settings.machines.vm.cost', { amount: monthly })}.`}
                    </div>
                    <div className="flex gap-2">
                        <input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value.toLowerCase())}
                            aria-label={t('settings.machines.vm.name')}
                            placeholder={t('settings.machines.vm.name')}
                            disabled={create.isPending}
                            className="min-w-0 flex-1 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1 font-mono text-xs text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]"
                        />
                        <button type="submit" disabled={!valid || create.isPending} className="font-medium text-[var(--app-link)] hover:underline disabled:opacity-50">
                            {create.isPending ? t('settings.machines.vm.creating') : t('settings.machines.vm.create')}
                        </button>
                        <button type="button" disabled={create.isPending} onClick={() => setOpen(false)} className="font-medium text-[var(--app-link)] hover:underline disabled:opacity-50">
                            {t('settings.machines.accounts.cancel')}
                        </button>
                    </div>
                    {create.error ? <div role="alert" className="text-red-600 dark:text-red-400">{create.error.message}</div> : null}
                </form>
            ) : (
                <>
                    <button
                        type="button"
                        className="font-medium text-[var(--app-link)] hover:underline"
                        onClick={() => {
                            create.reset()
                            setName(suggestVmName(props.machines.flatMap((machine) => machine.metadata?.vm?.name ?? [])))
                            setOpen(true)
                        }}
                    >
                        + {t('settings.machines.vm.add')}
                    </button>
                    {create.data ? (
                        <div className="mt-1 text-emerald-600 dark:text-emerald-400">
                            {t('settings.machines.vm.created', { name: create.data.name })}
                        </div>
                    ) : null}
                </>
            )}
        </div>
    )
}
