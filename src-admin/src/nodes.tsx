import { Handle, type NodeProps, Position } from '@xyflow/react';
import { CornerUpLeft, Hash, LayoutGrid, Sparkles, Terminal, ToggleLeft, Type } from 'lucide-react';
import React from 'react';

import { t } from './i18n';
import type { NodeData } from './registryGraph';

/** The kinds of node the editor knows, with the color and icon of each */
export const NODE_TYPES: Record<
    string,
    { label: string; accent: string; icon: React.ComponentType<{ size?: number }> }
> = {
    menu: {
        get label(): string {
            return t('nodeType.menu');
        },
        accent: 'var(--t-menu)',
        icon: LayoutGrid,
    },
    toggle: {
        get label(): string {
            return t('nodeType.toggle');
        },
        accent: 'var(--t-toggle)',
        icon: ToggleLeft,
    },
    number: {
        get label(): string {
            return t('nodeType.number');
        },
        accent: 'var(--t-number)',
        icon: Hash,
    },
    text: {
        get label(): string {
            return t('nodeType.text');
        },
        accent: 'var(--t-number)',
        icon: Type,
    },
    nav: {
        get label(): string {
            return t('nodeType.nav');
        },
        accent: 'var(--t-nav)',
        icon: CornerUpLeft,
    },
    command: {
        get label(): string {
            return t('nodeType.command');
        },
        accent: 'var(--t-command)',
        icon: Terminal,
    },
    auto: {
        get label(): string {
            return t('nodeType.auto');
        },
        accent: 'var(--t-auto)',
        icon: Sparkles,
    },
};

export function MenuNodeView({ data, selected, type }: { data: NodeData; selected?: boolean; type: string }) {
    let config = NODE_TYPES[type],
        Icon = config.icon;
    return (
        <div
            style={{
                width: 190,
                background: 'var(--node)',
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--node-line)'}`,
                borderLeft: `3px solid ${config.accent}`,
                borderRadius: 8,
                boxShadow: 'var(--node-shadow)',
                transition: 'border-color .14s cubic-bezier(.23,1,.32,1)',
            }}
        >
            <Handle
                type="target"
                position={Position.Left}
                style={{
                    width: 10,
                    height: 10,
                    background: 'var(--edge)',
                    border: '2px solid var(--bg)',
                }}
            />
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '9px 12px',
                }}
            >
                <span
                    style={{
                        fontSize: 18,
                        lineHeight: 1,
                    }}
                >
                    {data.emoji || '·'}
                </span>
                <div
                    style={{
                        minWidth: 0,
                        flex: 1,
                    }}
                >
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 500,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                        }}
                    >
                        {data.title || config.label}
                    </div>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            fontSize: 10,
                            color: 'var(--text-3)',
                        }}
                    >
                        <Icon size={10} />
                        <span>{config.label}</span>
                    </div>
                </div>
            </div>
            <Handle
                type="source"
                position={Position.Right}
                style={{
                    width: 10,
                    height: 10,
                    background: config.accent,
                    border: '2px solid var(--bg)',
                }}
            />
        </div>
    );
}

/** One node component per kind, so React Flow can tell them apart */
export const nodeTypes = Object.fromEntries(
    Object.keys(NODE_TYPES).map(kind => [
        kind,
        (props: NodeProps) => (
            <MenuNodeView
                data={props.data as NodeData}
                selected={props.selected}
                type={kind}
            />
        ),
    ]),
);
