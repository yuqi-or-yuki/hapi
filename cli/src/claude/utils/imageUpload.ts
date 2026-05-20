import { logger } from '@/ui/logger'

type UploadBlobFn = (mimeType: string, data: string) => Promise<string>

/**
 * Scans a Claude log message for base64 image blocks inside tool_result content
 * (user messages) or directly in content (assistant messages), uploads each to
 * the hub, and replaces them with hapi_image references.
 * Returns the original message unchanged if no images are found or if the
 * message type/structure doesn't match.
 */
export async function uploadImagesInLogMessage(logMsg: any, uploadBlob: UploadBlobFn): Promise<any> {
    // Handle user messages: images inside tool_result blocks
    if (logMsg.type === 'user' && Array.isArray(logMsg.message?.content)) {
        let hasImages = false
        for (const block of logMsg.message.content) {
            if (block && typeof block === 'object' && block.type === 'tool_result' && Array.isArray(block.content)) {
                for (const inner of block.content) {
                    if (inner && typeof inner === 'object' && inner.type === 'image' &&
                        inner.source && inner.source.type === 'base64') {
                        hasImages = true
                        break
                    }
                }
            }
            if (hasImages) break
        }
        logger.debug(`[blob-upload]: hasImages=${hasImages} logMsg.type=${logMsg.type} contentLen=${logMsg.message?.content?.length}`)
        if (!hasImages) return logMsg

        const transformed = JSON.parse(JSON.stringify(logMsg))
        for (const block of transformed.message.content) {
            if (!block || typeof block !== 'object' || block.type !== 'tool_result' || !Array.isArray(block.content)) continue
            for (let i = 0; i < block.content.length; i++) {
                const inner = block.content[i]
                if (!inner || typeof inner !== 'object' || inner.type !== 'image') continue
                if (!inner.source || inner.source.type !== 'base64') continue
                const mimeType = typeof inner.source.media_type === 'string' ? inner.source.media_type : 'image/png'
                const data = typeof inner.source.data === 'string' ? inner.source.data : null
                if (!data) continue
                try {
                    logger.debug(`[blob-upload]: uploading ${mimeType} blob, dataLen=${data.length}`)
                    const blobId = await uploadBlob(mimeType, data)
                    logger.debug(`[blob-upload]: upload succeeded, blobId=${blobId}`)
                    block.content[i] = { type: 'hapi_image', blobId, mimeType }
                } catch (e) {
                    logger.debug('[blob-upload]: Failed to upload image blob, using placeholder', e)
                    block.content[i] = { type: 'text', text: `[image: ${mimeType}]` }
                }
            }
        }
        return transformed
    }

    // Handle assistant messages: images directly in content array
    if (logMsg.type === 'assistant' && Array.isArray(logMsg.message?.content)) {
        let hasImages = false
        for (const block of logMsg.message.content) {
            if (block && typeof block === 'object' && block.type === 'image' &&
                block.source && block.source.type === 'base64') {
                hasImages = true
                break
            }
        }
        logger.debug(`[blob-upload]: hasImages=${hasImages} logMsg.type=${logMsg.type} contentLen=${logMsg.message?.content?.length}`)
        if (!hasImages) return logMsg

        const transformed = JSON.parse(JSON.stringify(logMsg))
        for (let i = 0; i < transformed.message.content.length; i++) {
            const block = transformed.message.content[i]
            if (!block || typeof block !== 'object' || block.type !== 'image') continue
            if (!block.source || block.source.type !== 'base64') continue
            const mimeType = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png'
            const data = typeof block.source.data === 'string' ? block.source.data : null
            if (!data) continue
            try {
                logger.debug(`[blob-upload]: uploading assistant ${mimeType} blob, dataLen=${data.length}`)
                const blobId = await uploadBlob(mimeType, data)
                logger.debug(`[blob-upload]: upload succeeded, blobId=${blobId}`)
                transformed.message.content[i] = { type: 'hapi_image', blobId, mimeType }
            } catch (e) {
                logger.debug('[blob-upload]: Failed to upload assistant image blob, using placeholder', e)
                transformed.message.content[i] = { type: 'text', text: `[image: ${mimeType}]` }
            }
        }
        return transformed
    }

    return logMsg
}

/**
 * Wraps a message sender with image upload processing.
 * Returns a send function and a flush function.
 * Call flush() after all messages are received to await pending uploads.
 */
export function withImageUpload(
    send: (msg: any) => void,
    uploadBlob: UploadBlobFn
): { send: (msg: any) => void; flush: () => Promise<void> } {
    let chain: Promise<void> = Promise.resolve()
    return {
        send: (msg: any) => {
            chain = chain
                .then(async () => {
                    const processed = await uploadImagesInLogMessage(msg, uploadBlob)
                    send(processed)
                })
                .catch(e => {
                    logger.debug('[blob-upload]: message chain error, sending unprocessed', e)
                    send(msg)
                })
        },
        flush: () => chain
    }
}
