import type { AdminConnection } from '@iobroker/gui-components';

import { t } from './i18n';

export interface ApiResult {
    ok?: boolean;
    error?: string;
    [key: string]: any;
}

/** How long the editor waits for the adapter to answer one command */
const SEND_TIMEOUT_MS = 30_000;

/**
 * All `sendTo` commands of the adapter. The socket comes from Admin, the same connection the
 * rest of the Admin UI uses, so there is no own socket handling in the editor.
 */
export class MenuApi {
    constructor(
        private readonly socket: AdminConnection,
        private readonly instance: () => string,
    ) {}

    private send(command: string, data: unknown): Promise<ApiResult> {
        const timeout = new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(t('tab.socketNoConnect'))), SEND_TIMEOUT_MS),
        );
        return Promise.race([this.socket.sendTo(this.instance(), command, data) as Promise<ApiResult>, timeout]);
    }

    getRegistry(): Promise<ApiResult> {
        return this.send('getRegistry', {});
    }
    importRegistry(registry: unknown): Promise<ApiResult> {
        return this.send('importRegistry', registry);
    }
    resetRegistry(): Promise<ApiResult> {
        return this.send('resetRegistry', {});
    }
    deleteRegistryMenus(keys: string[]): Promise<ApiResult> {
        return this.send('deleteRegistryMenus', { keys });
    }
    getLayout(): Promise<ApiResult> {
        return this.send('getLayout', {});
    }
    saveLayout(layout: unknown): Promise<ApiResult> {
        return this.send('saveLayout', { layout });
    }
    registerNotifyAreas(areas: Record<string, string[]>): Promise<ApiResult> {
        return this.send('registerNotifyAreas', areas);
    }
    getNotifyAreasFull(): Promise<ApiResult> {
        return this.send('getNotifyAreasFull', {});
    }
    deleteNotifyArea(area: string): Promise<ApiResult> {
        return this.send('deleteNotifyArea', { area });
    }
    getPendingNotifyAreas(): Promise<ApiResult> {
        return this.send('getPendingNotifyAreas', {});
    }
    approveNotifyArea(area: string): Promise<ApiResult> {
        return this.send('approveNotifyArea', { area });
    }
    setNotifyOverride(area: string, type: string, override: boolean): Promise<ApiResult> {
        return this.send('setNotifyOverride', { area, type, override });
    }
    setNotifyTypeLabel(area: string, type: string, label: string): Promise<ApiResult> {
        return this.send('setNotifyTypeLabel', { area, type, label });
    }
    setNotifyAreaLabel(area: string, label: string): Promise<ApiResult> {
        return this.send('setNotifyAreaLabel', { area, label });
    }
}
