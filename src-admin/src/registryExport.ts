import { t } from './i18n';
import type { EditorEdge, EditorNode, NodeData, Registry } from './registryGraph';

/** The status emoji of a node: a datapoint and rules instead of one fixed emoji */
function iconOf(data: NodeData): { datapoint: string; rules: unknown[]; fallback: string } | undefined {
    return data.emojiMode === 'dynamic'
        ? { datapoint: data.statusDatapoint || '', rules: data.statusRules || [], fallback: data.emoji || '' }
        : undefined;
}

const isMenu = (node: EditorNode): boolean => node.type === 'menu' || node.type === 'auto';
const label = (data: NodeData): string => `${data.emoji || ''} ${data.title || ''}`.trim();
const toNumber = (value: unknown): number | undefined =>
    value !== undefined && value !== '' ? Number(value) : undefined;

/** Settings that only the main menu carries and that apply to all menus */
function globalSettings(data: NodeData): Record<string, unknown> {
    const isMain = data.menuKey === 'main';
    return {
        groupingEnabled: isMain ? data.groupingEnabled !== false : undefined,
        groupableExcludeTypes:
            isMain && data.groupableExcludeTypesStr
                ? data.groupableExcludeTypesStr
                      .split(',')
                      .map((type: string) => type.trim())
                      .filter(Boolean)
                : undefined,
        boolTranslateEnabled: isMain ? data.boolTranslateEnabled !== false : undefined,
        boolTrueText: (isMain && data.boolTrueText) || undefined,
        boolFalseText: (isMain && data.boolFalseText) || undefined,
        dateTranslateEnabled: isMain ? data.dateTranslateEnabled !== false : undefined,
        dateFormat: (isMain && data.dateFormat) || undefined,
        dateTimeFormat: (isMain && data.dateTimeFormat) || undefined,
    };
}

/** One button of a menu, made from the node the menu points to */
function buttonOf(node: EditorNode): Record<string, any> {
    const data = node.data;
    const isCommand = node.type === 'command';
    const hasHttp = isCommand && data.httpUrl;

    if (isMenu(node)) {
        return {
            text: label(data),
            cmd: `TG:NAV:${(data.title || '').toUpperCase()}`,
            nextMenu: data.menuKey || node.id,
            perm: data.perm || undefined,
            icon: iconOf(data),
        };
    }
    if (node.type === 'nav') {
        if (data.action === 'backmain') {
            // "Back" and "Main menu" stay together in one row
            return {
                __pair: [
                    { text: `⬅️ ${t('canvas.defaultBackTitle')}`, cmd: 'TG:NAV:BACK', navpair: true },
                    { text: `\u{1F3E0} ${t('demo.mainMenuTitle')}`, cmd: 'TG:NAV:MAIN', navpair: true },
                ],
            };
        }
        return {
            text: label(data),
            cmd: data.action === 'back' ? 'TG:NAV:BACK' : data.action === 'main' ? 'TG:NAV:MAIN' : 'TG:NAV:CANCEL',
        };
    }
    return {
        text: label(data),
        cmd: data.cmd || '',
        perm: data.perm || undefined,
        inputType: node.type === 'number' ? 'number' : node.type === 'text' ? 'text' : undefined,
        nodeType: node.type,
        message: data.message || undefined,
        scriptId: data.scriptId || undefined,
        datapoint: data.datapoint || undefined,
        imageDatapoint: ((isCommand || node.type === 'toggle') && data.imageDatapoint) || undefined,
        fixedValue: (isCommand && data.datapoint && data.fixedValue) || undefined,
        prompt: (data.datapoint && data.prompt) || undefined,
        onValue: (data.datapoint && data.onValue) || undefined,
        offValue: (data.datapoint && data.offValue) || undefined,
        min: node.type === 'number' && data.min !== undefined && data.min !== '' ? data.min : undefined,
        max: node.type === 'number' && data.max !== undefined && data.max !== '' ? data.max : undefined,
        httpUrl: (isCommand && data.httpUrl) || undefined,
        httpMethod: (hasHttp && data.httpMethod) || undefined,
        httpAuthUser: (hasHttp && data.httpAuthUser) || undefined,
        httpAuthPass: (hasHttp && data.httpAuthPass) || undefined,
        httpBody: (hasHttp && data.httpBody) || undefined,
        icon: iconOf(data),
    };
}

/**
 * Turns the graph of the editor back into the registry the adapter stores.
 * The menu a node is connected from becomes its parent, the buttons of a menu are the nodes it
 * points to, top to bottom, and are wrapped into rows of the width the main menu sets.
 */
export function buildRegistry(nodes: EditorNode[], edges: EditorEdge[]): Registry {
    const mainNode = nodes.find(node => isMenu(node) && node.data.menuKey === 'main');
    const buttonsPerRow = mainNode && Number(mainNode.data.buttonsPerRow) > 0 ? Number(mainNode.data.buttonsPerRow) : 2;
    const registry: Registry = {};

    for (const node of nodes.filter(isMenu)) {
        const parentEdge = edges.find(edge => {
            if (edge.target !== node.id) {
                return false;
            }
            const source = nodes.find(other => other.id === edge.source);
            return !!source && isMenu(source);
        });
        const parent = parentEdge ? nodes.find(other => other.id === parentEdge.source) : undefined;
        const data = node.data;

        const menu: Record<string, any> = {
            title: label(data),
            perm: data.perm || undefined,
            icon: iconOf(data),
            parent: parent ? parent.data.menuKey || parent.id : undefined,
            message: data.message || undefined,
            scriptId: data.scriptId || undefined,
            cmd: (data.scriptId && data.cmd) || undefined,
            imageDatapoint: data.imageDatapoint || undefined,
            ...globalSettings(data),
            trigger: data.triggerDatapoint
                ? { datapoint: data.triggerDatapoint, value: data.triggerValue || '', ackOnly: !!data.triggerAckOnly }
                : undefined,
        };
        const key = data.menuKey || node.id;

        if (node.type === 'auto') {
            const isRange = data.source === 'percentRange' || data.source === 'numberRange';
            registry[key] = {
                ...menu,
                source: data.source || 'users',
                ...(isRange
                    ? {
                          datapoint: data.datapoint || undefined,
                          min: toNumber(data.min),
                          max: toNumber(data.max),
                          step: toNumber(data.step),
                          unit: data.unit || undefined,
                          rowLength: toNumber(data.rowLength),
                          confirmMessage: data.confirmMessage || undefined,
                      }
                    : {}),
            };
            continue;
        }

        const buttons = edges
            .filter(edge => edge.source === node.id)
            .map(edge => nodes.find(other => other.id === edge.target))
            .filter((target): target is EditorNode => !!target)
            .sort((a, b) => a.position.y - b.position.y)
            .map(buttonOf);

        const rows: Record<string, any>[][] = [];
        let row: Record<string, any>[] = [];
        for (const button of buttons) {
            if (button.__pair) {
                if (row.length) {
                    rows.push(row);
                    row = [];
                }
                rows.push(button.__pair);
                continue;
            }
            row.push(button);
            if (row.length >= buttonsPerRow) {
                rows.push(row);
                row = [];
            }
        }
        if (row.length) {
            rows.push(row);
        }
        registry[key] = { ...menu, rows };
    }
    return registry;
}

/** Layout key of every node: menus by their key, buttons by the menu they hang on and their command */
export function buildLayout(
    nodes: EditorNode[],
    edges: EditorEdge[],
    layoutKey: (menuKey: string, button: any) => string,
) {
    const layout: Record<string, { x: number; y: number }> = {};
    for (const node of nodes) {
        if (isMenu(node)) {
            layout[node.data.menuKey || node.id] = { x: node.position.x, y: node.position.y };
            continue;
        }
        const parentEdge = edges.find(edge => edge.target === node.id);
        const parent = parentEdge && nodes.find(other => other.id === parentEdge.source);
        const cmd =
            node.type === 'nav'
                ? node.data.action === 'back'
                    ? 'TG:NAV:BACK'
                    : node.data.action === 'main'
                      ? 'TG:NAV:MAIN'
                      : node.data.action === 'backmain'
                        ? 'TG:NAV:BACK+MAIN'
                        : 'TG:NAV:CANCEL'
                : node.data.cmd;
        const key = layoutKey(parent ? parent.data.menuKey || parent.id : 'orphan', { cmd, text: label(node.data) });
        layout[key] = { x: node.position.x, y: node.position.y };
    }
    return layout;
}
