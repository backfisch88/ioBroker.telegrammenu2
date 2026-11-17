import type { MenuApi } from './api';
import { t } from './i18n';
import { buildLayout, buildRegistry } from './registryExport';
import { buttonLayoutKey, type EditorEdge, type EditorNode } from './registryGraph';

export type SaveResult =
    | { ok: true; keys: string[]; importedCount: number; areaSnapshot?: { nodeId: string; areas: string[] } }
    | { ok: false; error: string };

const splitList = (text: string): string[] =>
    text
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);

/** The node of the notification menu, if it has areas to save or areas that were removed */
function notifyNodeOf(nodes: EditorNode[]): EditorNode | undefined {
    return nodes.find(
        node =>
            node.type === 'auto' &&
            (node.data.source || 'users') === 'notifyPrefs' &&
            ((node.data.notifyAreas || []).length || (node.data._notifyAreasSnapshot || []).length),
    );
}

/** Saves areas, their labels, overrides and type labels, and deletes the areas removed in the editor */
async function saveNotifyAreas(
    api: MenuApi,
    node: EditorNode,
): Promise<{ nodeId: string; areas: string[] } | undefined> {
    const areas: Record<string, any>[] = node.data.notifyAreas || [];

    const typesOfArea: Record<string, string[]> = {};
    for (const entry of areas) {
        if (entry.area) {
            typesOfArea[entry.area] = splitList(entry.typesStr || '');
        }
    }
    if (Object.keys(typesOfArea).length) {
        await api.registerNotifyAreas(typesOfArea);
    }

    for (const entry of areas) {
        if (entry.area && entry.areaLabel) {
            await api.setNotifyAreaLabel(entry.area, entry.areaLabel);
        }
    }

    for (const entry of areas) {
        if (!entry.area) {
            continue;
        }
        const overridden = new Set(splitList(entry.overrideStr || ''));
        for (const type of splitList(entry.typesStr || '')) {
            await api.setNotifyOverride(entry.area, type, overridden.has(type));
        }
    }

    for (const entry of areas) {
        if (!entry.area || !entry.labelsStr) {
            continue;
        }
        const types = splitList(entry.typesStr || '');
        // Labels are kept by position, so an empty one is not trimmed away
        const labels: string[] = entry.labelsStr.split(',').map((label: string) => label.trim());
        for (let index = 0; index < types.length && index < labels.length; index++) {
            if (labels[index]) {
                await api.setNotifyTypeLabel(entry.area, types[index], labels[index]);
            }
        }
    }

    const before: string[] = node.data._notifyAreasSnapshot || [];
    const remaining = new Set(areas.map(entry => entry.area).filter(Boolean));
    const removed = before.filter(area => !remaining.has(area));
    for (const area of removed) {
        await api.deleteNotifyArea(area);
    }
    return removed.length ? { nodeId: node.id, areas: [...remaining] } : undefined;
}

/**
 * Saves the graph: menus, the layout and the notification areas.
 * `previousKeys` are the menus the adapter had after the last save, those that are gone now are deleted.
 */
export async function saveToAdapter(
    api: MenuApi,
    nodes: EditorNode[],
    edges: EditorEdge[],
    previousKeys: string[] | null,
): Promise<SaveResult> {
    const registry = buildRegistry(nodes, edges);
    if (!registry.main) {
        return { ok: false, error: t('toolbar.noMainMenuWarning') };
    }

    const response = await api.importRegistry(registry);
    if (response && response.ok === false) {
        return { ok: false, error: t('tab.errorMsg', { msg: response.error || t('tab.unknown') }) };
    }

    const keys = Object.keys(registry);
    const removed = (previousKeys || []).filter(key => !keys.includes(key));
    if (removed.length) {
        await api.deleteRegistryMenus(removed);
    }

    await api.saveLayout(buildLayout(nodes, edges, buttonLayoutKey));

    const notifyNode = notifyNodeOf(nodes);
    const areaSnapshot = notifyNode ? await saveNotifyAreas(api, notifyNode) : undefined;

    return { ok: true, keys, importedCount: response?.imported?.length ?? keys.length, areaSnapshot };
}
