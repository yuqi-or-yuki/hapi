import { logger } from '@/ui/logger';
import type { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import {
    listClaudeModels,
    type ListClaudeModelsRequest,
    type ListClaudeModelsResponse
} from '../claudeModels';
import { getErrorMessage, rpcError } from '../rpcResponses';

export function registerClaudeModelHandlers(rpcHandlerManager: RpcHandlerManager): void {
    rpcHandlerManager.registerHandler<ListClaudeModelsRequest, ListClaudeModelsResponse>('listClaudeModels', async () => {
        logger.debug('List Claude models request');

        try {
            const models = await listClaudeModels();
            return { success: true, models };
        } catch (error) {
            logger.debug('Failed to list Claude models:', error);
            return rpcError(getErrorMessage(error, 'Failed to list Claude models'));
        }
    });
}
