import {
    addEdge,
    Background,
    type Connection,
    Controls,
    MiniMap,
    ReactFlow,
    useEdgesState,
    useNodesState,
} from '@xyflow/react';
import { CircleCheck, CloudUpload, Download, Plus, Trash2, TriangleAlert, X } from 'lucide-react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AdminConnection, IobTheme } from '@iobroker/gui-components';

import { MenuApi } from './api';
import { createDemoGraph, newId } from './demoGraph';
import { EditorContext } from './editorContext';
import { t } from './i18n';
import { NodePanel } from './NodePanel';
import { NODE_TYPES, nodeTypes } from './nodes';
import { buildRegistry } from './registryExport';
import { areaToFields, buildGraph, type EditorEdge, type EditorNode, type NodeData } from './registryGraph';
import { saveToAdapter } from './saveToAdapter';

interface Status {
    kind: 'saving' | 'ok' | 'error';
    text: string;
}

const DEFAULT_INSTANCE = 'telegrammenu2.0';
const EDGE_STYLE = { stroke: 'var(--edge)', strokeWidth: 1.5 };

const isMenu = (node: EditorNode): boolean => node.type === 'menu' || node.type === 'auto';
const isNotifyMenu = (node: EditorNode): boolean =>
    node.type === 'auto' && (node.data.source || 'users') === 'notifyPrefs';

/** Every node that hangs below `rootId`, following the connections */
function descendantsOf(rootId: string, edges: EditorEdge[]): string[] {
    const found = new Set<string>();
    const queue = [rootId];
    while (queue.length) {
        const current = queue.shift()!;
        for (const edge of edges) {
            if (edge.source === current && !found.has(edge.target) && edge.target !== rootId) {
                found.add(edge.target);
                queue.push(edge.target);
            }
        }
    }
    return [...found];
}

/** A copy of a node, moved a bit so it does not lie on top of the original */
function copyOf(node: EditorNode, id: string): EditorNode {
    return {
        ...node,
        id,
        position: { x: node.position.x + 40, y: node.position.y + 60 },
        data: { ...node.data, menuKey: node.data.menuKey ? `${node.data.menuKey}_kopie` : undefined },
    };
}

export default function Editor(props: {
    socket: AdminConnection;
    themeType?: string;
    theme?: IobTheme;
    imagePrefix?: string;
}): React.JSX.Element {
    const initial = useMemo(() => createDemoGraph(), []);
    const [nodes, setNodes, onNodesChange] = useNodesState<EditorNode>(initial.nodes);
    const [edges, setEdges, onEdgesChange] = useEdgesState<EditorEdge>(initial.edges);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
    const [panelOpen, setPanelOpen] = useState(false);
    const [exportOpen, setExportOpen] = useState(false);
    const [instance, setInstance] = useState(DEFAULT_INSTANCE);
    const [status, setStatus] = useState<Status | null>(null);
    const [loadedFromAdapter, setLoadedFromAdapter] = useState(false);
    const [savedKeys, setSavedKeys] = useState<string[] | null>(null);

    const instanceRef = useRef(instance);
    instanceRef.current = instance;
    const api = useMemo(() => new MenuApi(props.socket, () => instanceRef.current), [props.socket]);

    const selectedNode = nodes.find(node => node.id === selectedId);
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches;

    // Load the menus, the layout and the notification areas the adapter already has
    useEffect(() => {
        void (async () => {
            try {
                const response = await api.getRegistry();
                if (!response?.ok || !response.registry || !Object.keys(response.registry).length) {
                    return;
                }
                let layout = {};
                try {
                    const layoutResponse = await api.getLayout();
                    if (layoutResponse?.ok) {
                        layout = layoutResponse.layout || {};
                    }
                } catch {
                    // Without a saved layout the nodes are placed automatically
                }
                const graph = buildGraph(response.registry, layout);
                if (!graph?.nodes.length) {
                    return;
                }
                let loadedNodes = graph.nodes;
                try {
                    const areasResponse = await api.getNotifyAreasFull();
                    if (areasResponse?.ok && areasResponse.areas) {
                        const areaFields = Object.entries(areasResponse.areas).map(([area, info]) =>
                            areaToFields(area, info),
                        );
                        const areaNames = Object.keys(areasResponse.areas);
                        loadedNodes = loadedNodes.map(node =>
                            isNotifyMenu(node)
                                ? {
                                      ...node,
                                      data: { ...node.data, notifyAreas: areaFields, _notifyAreasSnapshot: areaNames },
                                  }
                                : node,
                        );
                    }
                } catch {
                    // The notification menu then starts without areas
                }
                setNodes(loadedNodes);
                setEdges(graph.edges);
                setLoadedFromAdapter(true);
                setSavedKeys(Object.keys(response.registry));
            } catch {
                // The demo graph stays, the adapter may not be running
            }
        })();
    }, [api, setNodes, setEdges]);

    const resetAll = async (): Promise<void> => {
        if (!window.confirm(t('tab.confirmDeleteAll'))) {
            return;
        }
        setStatus({ kind: 'saving', text: t('toolbar.resettingRegistry') });
        try {
            const response = await api.resetRegistry();
            if (response?.ok) {
                setNodes([]);
                setEdges([]);
                setLoadedFromAdapter(false);
                setSavedKeys([]);
                setStatus({ kind: 'ok', text: t('toolbar.resetDoneMsg', { n: response.removed.length }) });
            } else {
                setStatus({ kind: 'error', text: t('tab.errorMsg', { msg: response?.error || t('tab.unknown') }) });
            }
        } catch (error) {
            setStatus({ kind: 'error', text: t('tab.errorMsg', { msg: (error as Error).message }) });
        }
    };

    const save = async (): Promise<void> => {
        setStatus({ kind: 'saving', text: t('tab.saving') });
        try {
            const result = await saveToAdapter(api, nodes, edges, savedKeys);
            if (!result.ok) {
                setStatus({ kind: 'error', text: result.error });
                return;
            }
            setSavedKeys(result.keys);
            if (result.areaSnapshot) {
                const { nodeId, areas } = result.areaSnapshot;
                setNodes(current =>
                    current.map(node =>
                        node.id === nodeId ? { ...node, data: { ...node.data, _notifyAreasSnapshot: areas } } : node,
                    ),
                );
            }
            setStatus({ kind: 'ok', text: t('toolbar.importSavedMsg', { n: result.importedCount }) });
        } catch (error) {
            setStatus({ kind: 'error', text: t('tab.errorMsg', { msg: (error as Error).message }) });
        }
    };

    const onConnect = useCallback(
        (connection: Connection) => setEdges(current => addEdge({ ...connection, style: EDGE_STYLE }, current)),
        [setEdges],
    );
    const onNodeClick = useCallback((_event: React.MouseEvent, node: EditorNode) => {
        setSelectedId(node.id);
        setSelectedEdgeId(null);
        setPanelOpen(true);
    }, []);
    const onEdgeClick = useCallback((_event: React.MouseEvent, edge: EditorEdge) => {
        setSelectedEdgeId(edge.id);
        setSelectedId(null);
        setPanelOpen(true);
    }, []);
    const onPaneClick = useCallback(() => {
        setSelectedId(null);
        setSelectedEdgeId(null);
        setPanelOpen(false);
    }, []);

    const deleteSelectedEdge = (): void => {
        setEdges(current => current.filter(edge => edge.id !== selectedEdgeId));
        setSelectedEdgeId(null);
        setPanelOpen(false);
    };

    const changeSelectedNode = (key: string, value: unknown): void => {
        setNodes(current =>
            current.map(node => (node.id === selectedId ? { ...node, data: { ...node.data, [key]: value } } : node)),
        );
    };

    const addNode = (type: string): void => {
        const id = newId('n');
        setNodes(current => {
            const data: NodeData = {
                emoji: type === 'nav' ? '⬅️' : '✨',
                title: type === 'nav' ? t('canvas.defaultBackTitle') : NODE_TYPES[type].label,
                ...(type === 'nav'
                    ? { action: 'back' }
                    : type === 'auto'
                      ? { perm: '', source: 'users' }
                      : { perm: '', cmd: '' }),
            };
            return [
                ...current,
                {
                    id,
                    type,
                    position: { x: 60 + ((current.length * 35) % 400), y: 40 + ((current.length * 28) % 200) },
                    data,
                },
            ];
        });
        setSelectedId(id);
        setPanelOpen(true);
    };

    const removeNodes = (ids: Set<string>): void => {
        setNodes(current => current.filter(node => !ids.has(node.id)));
        setEdges(current => current.filter(edge => !ids.has(edge.source) && !ids.has(edge.target)));
        setSelectedId(null);
        setPanelOpen(false);
    };
    const deleteNode = (): void => removeNodes(new Set([selectedId!]));
    const deleteNodeWithChildren = (): void =>
        removeNodes(new Set([selectedId!, ...descendantsOf(selectedId!, edges)]));

    const idPrefixOf = (node: EditorNode): string => (isMenu(node) ? 'm' : 'a');

    const duplicateNode = (): void => {
        const original = nodes.find(node => node.id === selectedId);
        if (!original) {
            return;
        }
        const id = newId(idPrefixOf(original));
        setNodes(current => [...current, copyOf(original, id)]);
        const parentEdge = edges.find(edge => edge.target === selectedId);
        if (parentEdge) {
            setEdges(current => [...current, { id: `e_${id}`, source: parentEdge.source, target: id }]);
        }
        setSelectedId(id);
        setPanelOpen(true);
    };

    const duplicateWithChildren = (): void => {
        const ids = [selectedId!, ...descendantsOf(selectedId!, edges)];
        const newIds: Record<string, string> = {};
        for (const id of ids) {
            const node = nodes.find(other => other.id === id);
            if (node) {
                newIds[id] = newId(idPrefixOf(node));
            }
        }
        const copies = ids.flatMap(id => {
            const node = nodes.find(other => other.id === id);
            return node ? [copyOf(node, newIds[id])] : [];
        });
        const copiedEdges: EditorEdge[] = edges
            .filter(edge => newIds[edge.source] && newIds[edge.target])
            .map(edge => ({
                id: `e_${newIds[edge.source]}_${newIds[edge.target]}`,
                source: newIds[edge.source],
                target: newIds[edge.target],
            }));
        const parentEdge = edges.find(edge => edge.target === selectedId);
        if (parentEdge) {
            copiedEdges.push({
                id: `e_${newIds[selectedId!]}_parent`,
                source: parentEdge.source,
                target: newIds[selectedId!],
            });
        }
        setNodes(current => [...current, ...copies]);
        setEdges(current => [...current, ...copiedEdges]);
        setSelectedId(newIds[selectedId!]);
        setPanelOpen(true);
    };

    const registryJson = (): string => JSON.stringify(buildRegistry(nodes, edges), null, 2);

    const downloadRegistry = (): void => {
        const blob = new Blob([registryJson()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `telegrammenu2_registry_export_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    };

    const busy = status?.kind === 'saving';
    const context = useMemo(
        () => ({
            socket: props.socket,
            theme: props.theme,
            themeType: props.themeType === 'light' ? ('light' as const) : ('dark' as const),
            imagePrefix: props.imagePrefix ?? '../..',
        }),
        [props.socket, props.theme, props.themeType, props.imagePrefix],
    );

    return (
        <EditorContext.Provider value={context}>
            <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
                <div className="toolbar">
                    <span className="toolbar-title">telegramMenu2 · Editor</span>
                    <span className="load-badge">
                        {loadedFromAdapter ? t('tab.loadedFromAdapter') : t('tab.demoGraph')}
                    </span>
                    <div className="toolbar-buttons">
                        {Object.entries(NODE_TYPES).map(([type, info]) => (
                            <button
                                key={type}
                                className="tool-btn"
                                onClick={() => addNode(type)}
                            >
                                <Plus size={12} />
                                <info.icon size={13} />
                                <span className="tool-btn-label">{info.label}</span>
                            </button>
                        ))}
                    </div>
                    <div style={{ flex: 1 }} />
                    <input
                        value={instance}
                        onChange={event => setInstance(event.target.value)}
                        className="instance-input"
                        title="ioBroker-Instanz"
                    />
                    <button
                        className="save-btn"
                        onClick={() => void save()}
                        disabled={busy}
                    >
                        <CloudUpload size={13} />
                        {t('tab.saveToIoBroker')}
                    </button>
                    <button
                        className="reset-btn"
                        onClick={() => void resetAll()}
                        disabled={busy}
                    >
                        <Trash2 size={13} />
                        {t('tab.resetRegistry')}
                    </button>
                    <button
                        className="export-btn"
                        onClick={() => setExportOpen(true)}
                    >
                        <Download size={13} />
                        {t('tab.export')}
                    </button>
                </div>
                {status && (
                    <div className={`save-status ${status.kind}`}>
                        {status.kind === 'ok' && <CircleCheck size={13} />}
                        {status.kind === 'error' && <TriangleAlert size={13} />}
                        {status.text}
                    </div>
                )}
                <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <ReactFlow
                            nodes={nodes}
                            edges={edges.map(edge =>
                                edge.id === selectedEdgeId
                                    ? { ...edge, style: { stroke: 'var(--accent)', strokeWidth: 2 } }
                                    : edge,
                            )}
                            onNodesChange={onNodesChange}
                            onEdgesChange={onEdgesChange}
                            onConnect={onConnect}
                            onNodeClick={onNodeClick}
                            onEdgeClick={onEdgeClick}
                            onPaneClick={onPaneClick}
                            nodeTypes={nodeTypes}
                            colorMode={props.themeType === 'light' ? 'light' : 'dark'}
                            fitView
                            panOnScroll={false}
                            zoomOnPinch
                            minZoom={0.3}
                            panOnDrag={coarsePointer ? true : [2]}
                            selectionOnDrag={!coarsePointer}
                        >
                            <Background
                                gap={22}
                                color="var(--dots)"
                            />
                            <Controls />
                            <MiniMap
                                style={{ background: 'var(--surface)' }}
                                maskColor="var(--minimap-mask)"
                                nodeColor={node => NODE_TYPES[node.type || '']?.accent || '#666'}
                            />
                        </ReactFlow>
                    </div>
                    <div className={`side-panel ${panelOpen ? 'open' : ''}`}>
                        <button
                            className="panel-close"
                            onClick={() => setPanelOpen(false)}
                        >
                            <X size={16} />
                        </button>
                        {selectedNode ? (
                            <NodePanel
                                node={selectedNode}
                                onChange={changeSelectedNode}
                                onDelete={deleteNode}
                                onDeleteWithChildren={deleteNodeWithChildren}
                                onDuplicate={duplicateNode}
                                onDuplicateWithChildren={duplicateWithChildren}
                                api={api}
                            />
                        ) : selectedEdgeId ? (
                            <div>
                                <div
                                    className="panel-type"
                                    style={{ color: 'var(--text-2)' }}
                                >
                                    {t('canvas.connectionLabel')}
                                </div>
                                <div
                                    className="field-hint"
                                    style={{ marginBottom: 10 }}
                                >
                                    {t('canvas.removeConnectionHint')}
                                </div>
                                <button
                                    className="delete-btn"
                                    onClick={deleteSelectedEdge}
                                >
                                    <Trash2 size={13} />
                                    {t('canvas.deleteConnection')}
                                </button>
                            </div>
                        ) : (
                            <div className="panel-hint">{t('canvas.usageHint')}</div>
                        )}
                    </div>
                </div>
                {exportOpen && (
                    <div
                        className="modal-backdrop"
                        onClick={() => setExportOpen(false)}
                    >
                        <div
                            className="modal"
                            onClick={event => event.stopPropagation()}
                        >
                            <div className="modal-header">
                                <span>{t('tab.registryPreviewTitle')}</span>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <button
                                        className="export-btn"
                                        onClick={downloadRegistry}
                                    >
                                        <Download size={13} />
                                        {t('tab.downloadJson')}
                                    </button>
                                    <button onClick={() => setExportOpen(false)}>
                                        <X size={16} />
                                    </button>
                                </div>
                            </div>
                            <pre className="modal-body">{registryJson()}</pre>
                        </div>
                    </div>
                )}
            </div>
        </EditorContext.Provider>
    );
}
