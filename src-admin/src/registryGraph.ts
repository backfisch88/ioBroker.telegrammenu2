import type { Edge, Node } from '@xyflow/react';

import { t } from './i18n';

/** Per-node settings of the editor. The kind of node decides which of them are used. */
export type NodeData = Record<string, any>;
export type EditorNode = Node<NodeData>;
export type EditorEdge = Edge;
export type Layout = Record<string, { x: number; y: number }>;

/** The registry as the adapter stores it: menu key -> menu definition */
export type Registry = Record<string, any>;

/** Splits "🏠 Main menu" into the emoji and the text */
export function splitTitle(title?: string): { emoji: string; text: string } {
    if (!title) {
        return { emoji: '', text: '' };
    }
    const trimmed = title.trim();
    const space = trimmed.indexOf(' ');
    return space === -1
        ? { emoji: trimmed, text: '' }
        : { emoji: trimmed.slice(0, space), text: trimmed.slice(space + 1) };
}

/** Layout key of a button node, which has no menu key of its own */
export function buttonLayoutKey(menuKey: string, button: { cmd?: string; action?: string; text?: string }): string {
    return `${menuKey}::${button.cmd || button.action || button.text || ''}`;
}

/** Notify area of the adapter as the editor's text fields show it */
export function areaToFields(
    area: string,
    info: any,
): {
    area: string;
    typesStr: string;
    areaLabel: string;
    overrideStr: string;
    labelsStr: string;
} {
    const types: string[] = info.types || [];
    const labels: Record<string, string> = info.labels || {};
    return {
        area,
        typesStr: types.join(','),
        areaLabel: info.areaLabel || '',
        overrideStr: (info.override || []).join(','),
        labelsStr: types.map(type => labels[type] || '').join(','),
    };
}

/** Distance between two columns of the graph and between two rows in them */
const COLUMN_WIDTH = 360;
const MENU_ROW_HEIGHT = 150;
const BUTTON_ROW_HEIGHT = 80;

/**
 * Turns the registry of the adapter into nodes and edges. A saved layout wins over the
 * automatic position, which puts every menu into a column by its depth below the main menu.
 */
export function buildGraph(
    registry: Registry,
    layout: Layout = {},
): { nodes: EditorNode[]; edges: EditorEdge[] } | null {
    const keys = Object.keys(registry || {});
    if (!keys.length) {
        return null;
    }

    const childrenOf: Record<string, string[]> = {};
    for (const key of keys) {
        const parent = registry[key].parent;
        if (parent) {
            childrenOf[parent] = childrenOf[parent] || [];
            childrenOf[parent].push(key);
        }
    }

    // Depth of every menu below the main menu (breadth first), unreachable menus stay in column 0
    const depthOf: Record<string, number> = {};
    const queue: [string, number][] = [[registry.main ? 'main' : keys[0], 0]];
    const visited = new Set<string>();
    while (queue.length) {
        const [key, depth] = queue.shift()!;
        if (visited.has(key) || !registry[key]) {
            continue;
        }
        visited.add(key);
        depthOf[key] = depth;
        for (const child of childrenOf[key] || []) {
            queue.push([child, depth + 1]);
        }
    }
    for (const key of keys) {
        if (!(key in depthOf)) {
            depthOf[key] = 0;
        }
    }

    const nodes: EditorNode[] = [];
    const edges: EditorEdge[] = [];
    const rowsInColumn: Record<number, number> = {};
    const nodeIdOf: Record<string, string> = {};

    for (const key of keys) {
        const menu = registry[key];
        const column = depthOf[key];
        rowsInColumn[column] = rowsInColumn[column] || 0;
        const y = 40 + rowsInColumn[column] * MENU_ROW_HEIGHT;
        rowsInColumn[column]++;
        const nodeId = `m_${key}`;
        nodeIdOf[key] = nodeId;
        const { emoji, text } = splitTitle(menu.title);
        const saved = layout[key];
        nodes.push({
            id: nodeId,
            type: menu.source ? 'auto' : 'menu',
            position: saved ? { x: saved.x, y: saved.y } : { x: 40 + column * COLUMN_WIDTH, y },
            data: {
                emoji,
                title: text,
                menuKey: key,
                perm: menu.perm || '',
                source: menu.source,
                emojiMode: menu.icon ? 'dynamic' : undefined,
                statusDatapoint: menu.icon?.datapoint,
                statusRules: menu.icon?.rules,
                message: menu.message || '',
                scriptId: menu.scriptId || '',
                cmd: menu.cmd || '',
                imageDatapoint: menu.imageDatapoint || '',
                groupingEnabled: menu.groupingEnabled !== false,
                groupableExcludeTypesStr: Array.isArray(menu.groupableExcludeTypes)
                    ? menu.groupableExcludeTypes.join(',')
                    : '',
                boolTranslateEnabled: menu.boolTranslateEnabled !== false,
                boolTrueText: menu.boolTrueText || '',
                boolFalseText: menu.boolFalseText || '',
                dateTranslateEnabled: menu.dateTranslateEnabled !== false,
                dateFormat: menu.dateFormat || '',
                dateTimeFormat: menu.dateTimeFormat || '',
                buttonsPerRow: menu.buttonsPerRow || '',
                datapoint: menu.datapoint || '',
                min: menu.min === undefined ? '' : menu.min,
                max: menu.max === undefined ? '' : menu.max,
                step: menu.step === undefined ? '' : menu.step,
                unit: menu.unit || '',
                rowLength: menu.rowLength === undefined ? '' : menu.rowLength,
                confirmMessage: menu.confirmMessage || '',
                triggerDatapoint: menu.trigger?.datapoint || '',
                triggerValue: menu.trigger?.value || '',
                triggerAckOnly: !!menu.trigger?.ackOnly,
            },
        });
    }

    let counter = 0;
    for (const key of keys) {
        const menu = registry[key];
        const column = depthOf[key];
        for (const row of menu.rows || []) {
            for (let index = 0; index < row.length; index++) {
                const button = row[index];

                if (button.nextMenu) {
                    if (nodeIdOf[button.nextMenu]) {
                        edges.push({
                            id: `e_${key}_${button.nextMenu}_${counter++}`,
                            source: nodeIdOf[key],
                            target: nodeIdOf[button.nextMenu],
                        });
                    }
                    continue;
                }

                // "Back" directly followed by "Main menu" is one node, as the editor saves it
                const next = row[index + 1];
                if (button.navpair && button.cmd === 'TG:NAV:BACK' && next?.navpair && next.cmd === 'TG:NAV:MAIN') {
                    const targetColumn = column + 1;
                    rowsInColumn[targetColumn] = rowsInColumn[targetColumn] || 0;
                    const y = 40 + rowsInColumn[targetColumn] * BUTTON_ROW_HEIGHT;
                    rowsInColumn[targetColumn]++;
                    const nodeId = `a_${counter++}`;
                    const saved = layout[buttonLayoutKey(key, { cmd: 'TG:NAV:BACK+MAIN' })];
                    nodes.push({
                        id: nodeId,
                        type: 'nav',
                        position: saved ? { x: saved.x, y: saved.y } : { x: 40 + targetColumn * COLUMN_WIDTH, y },
                        data: { emoji: '⬅️\u{1F3E0}', title: t('menuPanel.backAndMain'), action: 'backmain' },
                    });
                    edges.push({ id: `e_${nodeId}`, source: nodeIdOf[key], target: nodeId });
                    index++;
                    continue;
                }

                const targetColumn = column + 1;
                rowsInColumn[targetColumn] = rowsInColumn[targetColumn] || 0;
                const y = 40 + rowsInColumn[targetColumn] * BUTTON_ROW_HEIGHT;
                rowsInColumn[targetColumn]++;
                const nodeId = `a_${counter++}`;
                const { emoji, text } = splitTitle(button.text);
                const saved = layout[buttonLayoutKey(key, button)];
                const position = saved ? { x: saved.x, y: saved.y } : { x: 40 + targetColumn * COLUMN_WIDTH, y };

                if (button.cmd === 'TG:NAV:BACK' || button.cmd === 'TG:NAV:MAIN' || button.cmd === 'TG:NAV:CANCEL') {
                    const action =
                        button.cmd === 'TG:NAV:BACK' ? 'back' : button.cmd === 'TG:NAV:MAIN' ? 'main' : 'cancel';
                    nodes.push({ id: nodeId, type: 'nav', position, data: { emoji, title: text, action } });
                } else {
                    const type =
                        button.nodeType ||
                        (button.inputType === 'number' ? 'number' : button.inputType === 'text' ? 'text' : 'command');
                    nodes.push({
                        id: nodeId,
                        type,
                        position,
                        data: {
                            emoji,
                            title: text,
                            perm: button.perm || '',
                            cmd: button.cmd || '',
                            scriptId: button.scriptId || '',
                            datapoint: button.datapoint || '',
                            imageDatapoint: button.imageDatapoint || '',
                            fixedValue: button.fixedValue === undefined ? '' : String(button.fixedValue),
                            prompt: button.prompt || '',
                            onValue: button.onValue === undefined ? '' : String(button.onValue),
                            offValue: button.offValue === undefined ? '' : String(button.offValue),
                            min: button.min === undefined ? '' : button.min,
                            max: button.max === undefined ? '' : button.max,
                            message: button.message,
                            emojiMode: button.icon ? 'dynamic' : undefined,
                            statusDatapoint: button.icon?.datapoint,
                            statusRules: button.icon?.rules,
                            httpUrl: button.httpUrl || '',
                            httpMethod: button.httpMethod || 'GET',
                            httpAuthUser: button.httpAuthUser || '',
                            httpAuthPass: button.httpAuthPass || '',
                            httpBody: button.httpBody || '',
                        },
                    });
                }
                edges.push({ id: `e_${nodeId}`, source: nodeIdOf[key], target: nodeId });
            }
        }
    }

    return { nodes, edges };
}
