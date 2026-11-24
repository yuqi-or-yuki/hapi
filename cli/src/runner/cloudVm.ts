import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import os from 'node:os'
import type { CreateVmResponse } from '@hapi/protocol'
import type { MachineVm } from '@hapi/protocol/schemas'
import { configuration } from '@/configuration'

/**
 * When the runner lives on a Google Compute Engine VM it says so in its
 * machine metadata (the web app shows a cost estimate), and it can create a
 * sibling: a copy of itself whose runner joins the same hub. Everything comes
 * from the VM's own metadata server and service account; no keys are stored.
 */

const METADATA = 'http://metadata.google.internal/computeMetadata/v1'
const HEADERS = { 'Metadata-Flavor': 'Google' }
export const VM_NAME_PATTERN = /^[a-z]([-a-z0-9]{0,40}[a-z0-9])?$/

type InstanceMetadata = {
    name: string
    zone: string
    machineType: string
    attributes?: Record<string, string>
    serviceAccounts?: Record<string, { email?: string }>
}

async function metadata<T>(path: string, timeoutMs = 1500): Promise<T> {
    const res = await fetch(`${METADATA}/${path}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) throw new Error(`metadata ${path}: ${res.status}`)
    return (path.includes('recursive=true') || path.endsWith('/token') ? await res.json() : await res.text()) as T
}

const lastSegment = (value: string) => value.split('/').pop() ?? value

async function readInstance(): Promise<{ project: string; instance: InstanceMetadata }> {
    const [project, instance] = await Promise.all([
        metadata<string>('project/project-id'),
        metadata<InstanceMetadata>('instance/?recursive=true'),
    ])
    return { project, instance }
}

export async function detectCloudVm(): Promise<MachineVm | undefined> {
    if (process.platform !== 'linux') return undefined
    try {
        const { project, instance } = await readInstance()
        let diskGb = 0
        try {
            const fsStat = statfsSync('/')
            diskGb = Math.round((fsStat.blocks * fsStat.bsize) / 1e9)
        } catch { /* cost estimate just leaves the disk out */ }
        return {
            provider: 'gcp',
            name: instance.name,
            project,
            zone: lastSegment(instance.zone),
            machineType: lastSegment(instance.machineType),
            vcpus: os.cpus().length,
            memoryGb: Math.round(os.totalmem() / 2 ** 30),
            diskGb,
        }
    } catch {
        return undefined
    }
}

/** The hub address another VM can reach: our tailnet IP when the hub is on this machine. */
async function reachableHubUrl(): Promise<string> {
    const url = new URL(configuration.apiUrl)
    if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return configuration.apiUrl
    const ip = await new Promise<string>((resolve, reject) => {
        execFile('tailscale', ['ip', '-4'], { timeout: 5000 }, (error, stdout) => {
            const first = stdout?.trim().split('\n')[0]
            if (error || !first) reject(new Error('This machine has no Tailscale address for the new VM to reach the hub on'))
            else resolve(first)
        })
    })
    url.hostname = ip
    return url.toString().replace(/\/$/, '')
}

export async function createSiblingVm(name: string): Promise<CreateVmResponse> {
    if (!VM_NAME_PATTERN.test(name)) {
        throw new Error('Use lowercase letters, digits and hyphens, starting with a letter')
    }
    let project: string
    let instance: InstanceMetadata
    try {
        ({ project, instance } = await readInstance())
    } catch {
        throw new Error('This machine is not a Google Cloud VM, so it cannot create one')
    }
    const startupScript = instance.attributes?.['startup-script']
    const binary = instance.attributes?.['hapi-binary']
    const serviceAccount = instance.serviceAccounts?.default?.email
    if (!startupScript || !binary || !serviceAccount) {
        throw new Error('This VM was not created by the HAPI agent-vm scripts, so there is nothing to copy')
    }

    const zone = lastSegment(instance.zone)
    const hubUrl = await reachableHubUrl()
    const { access_token: token } = await metadata<{ access_token: string }>('instance/service-accounts/default/token')
    const res = await fetch(`https://compute.googleapis.com/compute/v1/projects/${project}/zones/${zone}/instances`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
            name,
            machineType: `zones/${zone}/machineTypes/${lastSegment(instance.machineType)}`,
            labels: { 'hapi-agent': 'true' },
            disks: [{
                boot: true,
                autoDelete: true,
                initializeParams: {
                    sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64',
                    diskSizeGb: '100',
                    diskType: `zones/${zone}/diskTypes/pd-balanced`,
                },
            }],
            networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{ type: 'ONE_TO_ONE_NAT', name: 'External NAT' }] }],
            serviceAccounts: [{ email: serviceAccount, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }],
            metadata: {
                items: [
                    { key: 'startup-script', value: startupScript },
                    { key: 'hapi-binary', value: binary },
                    // A runner for this hub, not a second HAPI of its own.
                    { key: 'hapi-api-url', value: hubUrl },
                ],
            },
        }),
    })
    if (!res.ok) {
        const detail = await res.json().catch(() => null) as { error?: { message?: string } } | null
        throw new Error(detail?.error?.message ?? `Google Cloud refused to create the VM (${res.status})`)
    }
    return { name, zone }
}
