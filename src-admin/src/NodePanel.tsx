import { Copy, Download, Plus, Smile, Trash2, X, Braces } from 'lucide-react';
import React, { useRef, useState } from 'react';

import type { MenuApi } from './api';
import { AUTO_SOURCES } from './autoSources';
import { t } from './i18n';
import { useEditorContext } from './editorContext';
import { ObjectIdInput } from './ObjectIdInput';
import { SelectIdDialog } from './SelectIdDialog';
import { NODE_TYPES } from './nodes';
import { NotifyAreasEditor } from './NotifyAreasEditor';
import type { EditorNode } from './registryGraph';
import { StatusRules } from './StatusRules';

interface NodePanelProps {
    node: EditorNode;
    onChange: (key: string, value: any) => void;
    onDelete: () => void;
    onDeleteWithChildren: () => void;
    onDuplicate: () => void;
    onDuplicateWithChildren: () => void;
    api: MenuApi;
}

export function NodePanel({
    node,
    onChange,
    onDelete,
    onDeleteWithChildren,
    onDuplicate,
    onDuplicateWithChildren,
    api,
}: NodePanelProps) {
    let typeInfo = NODE_TYPES[node.type!],
        replyTextRef = useRef<HTMLTextAreaElement>(null);
    // Where the placeholder goes while the object browser is open
    const [pickerRange, setPickerRange] = useState<{ start: number; end: number } | null>(null);
    const canPick = !!useEditorContext()?.theme;

    /** Puts `snippet` into the reply text at `range`; the cursor ends up before the closing braces if `cursorInside` */
    const insertIntoMessage = (snippet: string, range: { start: number; end: number }, cursorInside: boolean): void => {
        const message: string = node.data.message || '';
        onChange('message', message.slice(0, range.start) + snippet + message.slice(range.end));
        requestAnimationFrame(() => {
            const textarea = replyTextRef.current;
            if (textarea) {
                textarea.focus();
                const cursor = range.start + snippet.length - (cursorInside ? 2 : 0);
                textarea.setSelectionRange(cursor, cursor);
            }
        });
    };

    return (
        <div>
            <div
                className="panel-type"
                style={{
                    color: typeInfo.accent,
                }}
            >
                <typeInfo.icon size={13} />
                {typeInfo.label}
            </div>
            <div className="field-label-row">
                <label
                    className="field-label"
                    style={{
                        margin: 0,
                    }}
                >
                    Emoji
                </label>
                <label className="toggle-inline">
                    <input
                        type="checkbox"
                        checked={node.data.emojiMode === 'dynamic'}
                        onChange={event => onChange('emojiMode', event.target.checked ? 'dynamic' : 'static')}
                    />
                    {t('menuPanel.statusAbhaengig')}
                </label>
            </div>
            {node.data.emojiMode === 'dynamic' ? (
                <StatusRules
                    node={node}
                    onChange={onChange}
                />
            ) : (
                <div className="field-row">
                    <Smile
                        size={14}
                        color="var(--text-3)"
                    />
                    <input
                        value={node.data.emoji || ''}
                        onChange={event => onChange('emoji', event.target.value)}
                        className="field-input"
                        style={{
                            width: 60,
                        }}
                    />
                </div>
            )}
            <label className="field-label">{t('menuPanel.titleLabel')}</label>
            <input
                value={node.data.title || ''}
                onChange={event => onChange('title', event.target.value)}
                className="field-input"
            />
            {(node.type === 'menu' || node.type === 'auto') && (
                <>
                    <label className="field-label">{t('menuPanel.menuKey')}</label>
                    <input
                        value={node.data.menuKey || ''}
                        onChange={event => onChange('menuKey', event.target.value)}
                        placeholder={t('menuPanel.menuKeyPlaceholder')}
                        className="field-input mono"
                    />
                    <div className="field-hint">
                        {t('menuPanel.menuKeyHint1')}
                        <code>main</code>
                        {t('menuPanel.menuKeyHint2')}
                    </div>
                    {node.data.menuKey === 'main' && (
                        <div
                            className="rule-block"
                            style={{
                                marginTop: 10,
                                paddingTop: 10,
                                borderTop: '1px dashed var(--line)',
                            }}
                        >
                            <div
                                className="field-label"
                                style={{
                                    marginBottom: 6,
                                }}
                            >
                                {t('menuPanel.globalSettings')}
                            </div>
                            <label className="field-label">{t('menuPanel.buttonsPerRowGlobal')}</label>
                            <input
                                type="number"
                                min={1}
                                max={6}
                                value={node.data.buttonsPerRow || ''}
                                onChange={event => onChange('buttonsPerRow', event.target.value)}
                                placeholder="2"
                                className="field-input mono"
                                style={{
                                    marginBottom: 12,
                                }}
                            />
                            <label
                                className="toggle-inline"
                                style={{
                                    marginBottom: 10,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={node.data.groupingEnabled !== false}
                                    onChange={event => onChange('groupingEnabled', event.target.checked)}
                                />
                                {t('menuPanel.groupingEnabled')}
                            </label>
                            {node.data.groupingEnabled !== false && (
                                <>
                                    <label className="field-label">{t('menuPanel.excludeTypes')}</label>
                                    <input
                                        value={node.data.groupableExcludeTypesStr || ''}
                                        onChange={event => onChange('groupableExcludeTypesStr', event.target.value)}
                                        placeholder="warn,error"
                                        className="field-input mono"
                                    />
                                    <div className="field-hint">{t('menuPanel.bundlingHint')}</div>
                                </>
                            )}
                            <label
                                className="toggle-inline"
                                style={{
                                    marginTop: 14,
                                    marginBottom: 10,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={node.data.boolTranslateEnabled !== false}
                                    onChange={event => onChange('boolTranslateEnabled', event.target.checked)}
                                />
                                {t('menuPanel.boolTranslate')}
                            </label>
                            {node.data.boolTranslateEnabled !== false && (
                                <div
                                    className="field-row"
                                    style={{
                                        marginBottom: 6,
                                    }}
                                >
                                    <div
                                        style={{
                                            flex: 1,
                                        }}
                                    >
                                        <label className="field-label">{t('menuPanel.textForOn')}</label>
                                        <input
                                            value={node.data.boolTrueText || ''}
                                            onChange={event => onChange('boolTrueText', event.target.value)}
                                            placeholder={t('tab.exampleOn')}
                                            className="field-input mono"
                                        />
                                    </div>
                                    <div
                                        style={{
                                            flex: 1,
                                        }}
                                    >
                                        <label className="field-label">{t('menuPanel.textForOff')}</label>
                                        <input
                                            value={node.data.boolFalseText || ''}
                                            onChange={event => onChange('boolFalseText', event.target.value)}
                                            placeholder={t('tab.exampleOff')}
                                            className="field-input mono"
                                        />
                                    </div>
                                </div>
                            )}
                            <div className="field-hint">
                                {t('menuPanel.boolHint1')}
                                {'{{...}}'}
                                {t('menuPanel.boolHint2')}
                            </div>
                            <label
                                className="toggle-inline"
                                style={{
                                    marginTop: 14,
                                    marginBottom: 10,
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={node.data.dateTranslateEnabled !== false}
                                    onChange={event => onChange('dateTranslateEnabled', event.target.checked)}
                                />
                                {t('menuPanel.dateTranslate')}
                            </label>
                            {node.data.dateTranslateEnabled !== false && (
                                <div
                                    className="field-row"
                                    style={{
                                        marginBottom: 6,
                                    }}
                                >
                                    <div
                                        style={{
                                            flex: 1,
                                        }}
                                    >
                                        <label className="field-label">{t('menuPanel.dateFormatOnly')}</label>
                                        <input
                                            value={node.data.dateFormat || ''}
                                            onChange={event => onChange('dateFormat', event.target.value)}
                                            placeholder="DD.MM.YYYY"
                                            className="field-input mono"
                                        />
                                    </div>
                                    <div
                                        style={{
                                            flex: 1,
                                        }}
                                    >
                                        <label className="field-label">{t('menuPanel.dateFormatTime')}</label>
                                        <input
                                            value={node.data.dateTimeFormat || ''}
                                            onChange={event => onChange('dateTimeFormat', event.target.value)}
                                            placeholder="DD.MM.YYYY HH:mm"
                                            className="field-input mono"
                                        />
                                    </div>
                                </div>
                            )}
                            <div className="field-hint">
                                {t('menuPanel.dateHint1')}
                                {'{{...}}'}
                                {t('menuPanel.dateHint2')}
                            </div>
                        </div>
                    )}
                    <label className="field-label">{t('menuPanel.replyText')}</label>
                    <textarea
                        value={node.data.message || ''}
                        onChange={event => onChange('message', event.target.value)}
                        placeholder={t('menuPanel.replyTextPlaceholder')}
                        className="field-input mono"
                        rows={4}
                    />
                    <div className="field-hint">
                        {t('menuPanel.replyTextHint1')}
                        {'{{datenpunkt.id}}'}
                        {t('menuPanel.replyTextHint2')}
                        {'{{datenpunkt.id / 60}}'}
                        {t('menuPanel.replyTextHint3')}
                        {'{{... / 1000 / 60}}'}
                        {t('menuPanel.replyTextHint4')}
                    </div>
                    <label className="field-label">{t('menuPanel.orScript')}</label>
                    <div className="field-row">
                        <input
                            value={node.data.scriptId || ''}
                            onChange={event => onChange('scriptId', event.target.value)}
                            placeholder={t('menuPanel.scriptIdPlaceholder')}
                            className="field-input mono"
                        />
                        <input
                            value={node.data.cmd || ''}
                            onChange={event => onChange('cmd', event.target.value)}
                            placeholder={t('tab.cmdPlaceholder')}
                            className="field-input mono"
                        />
                    </div>
                    <div className="field-hint">{t('menuPanel.scriptOverridesHint')}</div>
                    <label className="field-label">{t('menuPanel.imageDatapointOptional')}</label>
                    <ObjectIdInput
                        value={node.data.imageDatapoint || ''}
                        onChange={value => onChange('imageDatapoint', value)}
                        placeholder="0_userdata.0.example_state"
                    />
                    <div className="field-hint">{t('menuPanel.imageReplyHint')}</div>
                </>
            )}
            {node.type === 'nav' ? (
                <>
                    <label className="field-label">{t('menuPanel.actionLabel')}</label>
                    <select
                        value={node.data.action || 'back'}
                        onChange={event => {
                            let action = event.target.value as 'back' | 'main' | 'backmain',
                                defaults = {
                                    back: {
                                        emoji: '\u2B05\uFE0F',
                                        title: t('canvas.defaultBackTitle'),
                                    },
                                    main: {
                                        emoji: '\u{1F3E0}',
                                        title: t('demo.mainMenuTitle'),
                                    },
                                    backmain: {
                                        emoji: '\u2B05\uFE0F\u{1F3E0}',
                                        title: t('menuPanel.backAndMain'),
                                    },
                                };
                            (onChange('action', action),
                                onChange('emoji', defaults[action].emoji),
                                onChange('title', defaults[action].title));
                        }}
                        className="field-input"
                    >
                        <option value="back">{t('canvas.defaultBackTitle')}</option>
                        <option value="main">{t('demo.mainMenuTitle')}</option>
                        <option value="backmain">{t('menuPanel.backAndMain')}</option>
                    </select>
                    {node.data.action === 'backmain' && <div className="field-hint">{t('menuPanel.backMainHint')}</div>}
                </>
            ) : node.type === 'auto' ? (
                <>
                    <label className="field-label">{t('menuPanel.sourceLabel')}</label>
                    <select
                        value={node.data.source || 'users'}
                        onChange={event => onChange('source', event.target.value)}
                        className="field-input"
                    >
                        {Object.entries(AUTO_SOURCES).map(([source, info]) => (
                            <option
                                value={source}
                                key={source}
                            >
                                {info.label}
                            </option>
                        ))}
                    </select>
                    <div className="field-hint">{AUTO_SOURCES[node.data.source || 'users'].hint}</div>
                    <label className="field-label">{t('menuPanel.permission')}</label>
                    <input
                        value={node.data.perm || ''}
                        onChange={event => onChange('perm', event.target.value)}
                        placeholder={t('tab.permExample')}
                        className="field-input mono"
                    />
                    {(node.data.source || 'users') === 'notifyPrefs' && (
                        <NotifyAreasEditor
                            node={node}
                            onChange={onChange}
                            api={api}
                        />
                    )}
                    {(node.data.source === 'percentRange' || node.data.source === 'numberRange') && (
                        <>
                            <label className="field-label">{t('menuPanel.datapointLabel')}</label>
                            <ObjectIdInput
                                value={node.data.datapoint || ''}
                                onChange={value => onChange('datapoint', value)}
                                placeholder="0_userdata.0.example_state"
                            />
                            <div
                                className="field-row"
                                style={{
                                    marginTop: 6,
                                    marginBottom: 6,
                                }}
                            >
                                <div
                                    style={{
                                        flex: 1,
                                    }}
                                >
                                    <label className="field-label">Min</label>
                                    <input
                                        type="number"
                                        value={node.data.min ?? ''}
                                        onChange={event => onChange('min', event.target.value)}
                                        className="field-input mono"
                                    />
                                </div>
                                <div
                                    style={{
                                        flex: 1,
                                    }}
                                >
                                    <label className="field-label">Max</label>
                                    <input
                                        type="number"
                                        value={node.data.max ?? ''}
                                        onChange={event => onChange('max', event.target.value)}
                                        className="field-input mono"
                                    />
                                </div>
                                <div
                                    style={{
                                        flex: 1,
                                    }}
                                >
                                    <label className="field-label">{t('tab.step')}</label>
                                    <input
                                        type="number"
                                        value={node.data.step ?? ''}
                                        onChange={event => onChange('step', event.target.value)}
                                        className="field-input mono"
                                    />
                                </div>
                            </div>
                            <label className="field-label">{t('tab.unit')}</label>
                            <input
                                value={node.data.unit || ''}
                                onChange={event => onChange('unit', event.target.value)}
                                placeholder={node.data.source === 'percentRange' ? '%' : '\xB0C'}
                                className="field-input mono"
                            />
                            <label className="field-label">{t('menuPanel.buttonsPerRow')}</label>
                            <input
                                type="number"
                                value={node.data.rowLength ?? ''}
                                onChange={event => onChange('rowLength', event.target.value)}
                                placeholder="5"
                                className="field-input mono"
                            />
                            <div className="field-hint">{t('menuPanel.percentHintVariant')}</div>
                            <label
                                className="field-label"
                                style={{
                                    marginTop: 12,
                                }}
                            >
                                {t('menuPanel.confirmAfterValue')}
                            </label>
                            <textarea
                                value={node.data.confirmMessage || ''}
                                onChange={event => onChange('confirmMessage', event.target.value)}
                                placeholder={t('menuPanel.confirmMessagePlaceholder')}
                                className="field-input"
                                rows={2}
                            />
                            <div className="field-hint">{t('menuPanel.confirmValueHint')}</div>
                        </>
                    )}
                    <div
                        style={{
                            borderTop: '1px solid var(--line-strong)',
                            marginTop: 14,
                            paddingTop: 12,
                        }}
                    >
                        <label className="field-label">{t('menuPanel.autoOpenOnEvent')}</label>
                        <ObjectIdInput
                            value={node.data.triggerDatapoint || ''}
                            onChange={value => onChange('triggerDatapoint', value)}
                            placeholder={t('menuPanel.datapointExamplePlaceholder')}
                        />
                        <input
                            value={node.data.triggerValue || ''}
                            onChange={event => onChange('triggerValue', event.target.value)}
                            placeholder={t('menuPanel.valueExamplePlaceholder')}
                            className="field-input mono"
                            style={{
                                marginTop: 6,
                            }}
                        />
                        <label
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginTop: 8,
                                fontSize: 13,
                                color: 'var(--text-2)',
                                cursor: 'pointer',
                            }}
                        >
                            <input
                                type="checkbox"
                                checked={!!node.data.triggerAckOnly}
                                onChange={event => onChange('triggerAckOnly', event.target.checked)}
                            />
                            {t('menuPanel.ackOnly')}
                        </label>
                        <div className="field-hint">{t('menuPanel.eventTriggerHint')}</div>
                    </div>
                </>
            ) : (
                <>
                    <label className="field-label">{t('menuPanel.permission')}</label>
                    <input
                        value={node.data.perm || ''}
                        onChange={event => onChange('perm', event.target.value)}
                        placeholder={t('tab.permExample')}
                        className="field-input mono"
                    />
                    {node.type === 'menu' && (
                        <div
                            style={{
                                borderTop: '1px solid var(--line-strong)',
                                marginTop: 14,
                                paddingTop: 12,
                            }}
                        >
                            <label className="field-label">{t('menuPanel.autoOpenOnEvent')}</label>
                            <ObjectIdInput
                                value={node.data.triggerDatapoint || ''}
                                onChange={value => onChange('triggerDatapoint', value)}
                                placeholder={t('menuPanel.datapointExamplePlaceholder')}
                            />
                            <input
                                value={node.data.triggerValue || ''}
                                onChange={event => onChange('triggerValue', event.target.value)}
                                placeholder={t('menuPanel.valueExamplePlaceholder')}
                                className="field-input mono"
                                style={{
                                    marginTop: 6,
                                }}
                            />
                            <label
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginTop: 8,
                                    fontSize: 13,
                                    color: 'var(--text-2)',
                                    cursor: 'pointer',
                                }}
                            >
                                <input
                                    type="checkbox"
                                    checked={!!node.data.triggerAckOnly}
                                    onChange={event => onChange('triggerAckOnly', event.target.checked)}
                                />
                                {t('menuPanel.ackOnly')}
                            </label>
                            <div className="field-hint">{t('menuPanel.eventTriggerHintShort')}</div>
                        </div>
                    )}
                    {node.type !== 'menu' && (
                        <>
                            {(node.type === 'command' || node.type === 'toggle') && (
                                <>
                                    <label className="field-label">{t('menuPanel.imageInsteadOfText')}</label>
                                    <ObjectIdInput
                                        value={node.data.imageDatapoint || ''}
                                        onChange={value => onChange('imageDatapoint', value)}
                                        placeholder="0_userdata.0.example_state"
                                    />
                                    <div className="field-hint">{t('menuPanel.imageCommandHint')}</div>
                                </>
                            )}
                            {(node.type === 'toggle' ||
                                node.type === 'command' ||
                                node.type === 'number' ||
                                node.type === 'text') && (
                                <>
                                    <label className="field-label">{t('menuPanel.datapointDirect')}</label>
                                    <ObjectIdInput
                                        value={node.data.datapoint || ''}
                                        onChange={value => onChange('datapoint', value)}
                                        placeholder="0_userdata.0.example_state"
                                    />
                                    {node.data.datapoint && node.type === 'toggle' && (
                                        <div
                                            className="field-row"
                                            style={{
                                                marginTop: 6,
                                                marginBottom: 6,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    flex: 1,
                                                }}
                                            >
                                                <label className="field-label">{t('menuPanel.onValue')}</label>
                                                <input
                                                    value={node.data.onValue || ''}
                                                    onChange={event => onChange('onValue', event.target.value)}
                                                    placeholder="true"
                                                    className="field-input mono"
                                                />
                                            </div>
                                            <div
                                                style={{
                                                    flex: 1,
                                                }}
                                            >
                                                <label className="field-label">{t('menuPanel.offValue')}</label>
                                                <input
                                                    value={node.data.offValue || ''}
                                                    onChange={event => onChange('offValue', event.target.value)}
                                                    placeholder="false"
                                                    className="field-input mono"
                                                />
                                            </div>
                                        </div>
                                    )}
                                    {node.data.datapoint && node.type === 'command' && (
                                        <>
                                            <label className="field-label">{t('menuPanel.fixedValue')}</label>
                                            <input
                                                value={node.data.fixedValue || ''}
                                                onChange={event => onChange('fixedValue', event.target.value)}
                                                placeholder={t('tab.fixedValueExample')}
                                                className="field-input mono"
                                            />
                                        </>
                                    )}
                                    {node.data.datapoint && (node.type === 'number' || node.type === 'text') && (
                                        <>
                                            <label className="field-label">{t('menuPanel.questionBeforeInput')}</label>
                                            <input
                                                value={node.data.prompt || ''}
                                                onChange={event => onChange('prompt', event.target.value)}
                                                placeholder={
                                                    node.type === 'number'
                                                        ? t('menuPanel.enterNumber')
                                                        : t('menuPanel.enterText')
                                                }
                                                className="field-input mono"
                                            />
                                        </>
                                    )}
                                    <div className="field-hint">
                                        {node.type === 'toggle'
                                            ? t('menuPanel.toggleHint')
                                            : node.type === 'command'
                                              ? t('menuPanel.fixedValueHint')
                                              : t('menuPanel.askValueHint')}
                                        {node.data.emojiMode === 'dynamic' ? t('menuPanel.statusAbhaengigExtra') : ''}
                                    </div>
                                </>
                            )}
                            <label className="field-label">Command</label>
                            <input
                                value={node.data.cmd || ''}
                                onChange={event => onChange('cmd', event.target.value)}
                                placeholder="TG:BEREICH:AKTION"
                                className="field-input mono"
                            />
                            <label className="field-label">{t('menuPanel.scriptOptional')}</label>
                            <input
                                value={node.data.scriptId || ''}
                                onChange={event => onChange('scriptId', event.target.value)}
                                placeholder="meinSkript"
                                className="field-input mono"
                            />
                            <div className="field-hint">
                                {t('menuPanel.scriptHint1')}
                                <code>script.js.Ordner.name</code>
                                {t('menuPanel.scriptHint2')}
                                <code>onMessage('{'{Command}'}', ...)</code>
                                {t('menuPanel.scriptHint3')}
                                <code>
                                    {'onMessage(cmd, (data, callback) => callback('}
                                    {'{text: ...}'}))
                                </code>
                                {t('menuPanel.scriptHint4')}
                            </div>
                            {node.type === 'command' && (
                                <div
                                    style={{
                                        borderTop: '1px solid var(--line-strong)',
                                        marginTop: 14,
                                        paddingTop: 12,
                                    }}
                                >
                                    <label className="field-label">{t('menuPanel.httpRequest')}</label>
                                    <input
                                        value={node.data.httpUrl || ''}
                                        onChange={event => onChange('httpUrl', event.target.value)}
                                        placeholder="https://example.com/webhook"
                                        className="field-input mono"
                                    />
                                    <div
                                        className="field-row"
                                        style={{
                                            marginTop: 6,
                                            marginBottom: 6,
                                        }}
                                    >
                                        <div
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <label className="field-label">{t('tab.method')}</label>
                                            <select
                                                value={node.data.httpMethod || 'GET'}
                                                onChange={event => onChange('httpMethod', event.target.value)}
                                                className="field-input"
                                            >
                                                <option value="GET">GET</option>
                                                <option value="POST">POST</option>
                                                <option value="PUT">PUT</option>
                                                <option value="DELETE">DELETE</option>
                                            </select>
                                        </div>
                                        <div
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <label className="field-label">{t('menuPanel.basicAuthUser')}</label>
                                            <input
                                                value={node.data.httpAuthUser || ''}
                                                onChange={event => onChange('httpAuthUser', event.target.value)}
                                                className="field-input mono"
                                            />
                                        </div>
                                        <div
                                            style={{
                                                flex: 1,
                                            }}
                                        >
                                            <label className="field-label">{t('menuPanel.basicAuthPass')}</label>
                                            <input
                                                type="password"
                                                value={node.data.httpAuthPass || ''}
                                                onChange={event => onChange('httpAuthPass', event.target.value)}
                                                className="field-input mono"
                                            />
                                        </div>
                                    </div>
                                    {node.data.httpMethod && node.data.httpMethod !== 'GET' && (
                                        <>
                                            <label className="field-label">{t('menuPanel.bodyJson')}</label>
                                            <input
                                                value={node.data.httpBody || ''}
                                                onChange={event => onChange('httpBody', event.target.value)}
                                                placeholder={'{"key":"value"}'}
                                                className="field-input mono"
                                            />
                                        </>
                                    )}
                                    <div className="field-hint">{t('menuPanel.httpConfirmHint')}</div>
                                </div>
                            )}
                            <div className="field-label-row">
                                <label
                                    className="field-label"
                                    style={{
                                        margin: 0,
                                    }}
                                >
                                    {t('menuPanel.messageLabel')}
                                </label>
                                <button
                                    type="button"
                                    className="placeholder-btn"
                                    onClick={() => {
                                        const textarea = replyTextRef.current;
                                        const message: string = node.data.message || '';
                                        const range = {
                                            start: textarea?.selectionStart ?? message.length,
                                            end: textarea?.selectionEnd ?? message.length,
                                        };
                                        if (canPick) {
                                            setPickerRange(range);
                                        } else {
                                            insertIntoMessage('{{0_userdata.0.}}', range, true);
                                        }
                                    }}
                                >
                                    <Braces size={11} />
                                    {t('tab.placeholderBtn')}
                                </button>
                            </div>
                            <textarea
                                ref={replyTextRef}
                                value={node.data.message || ''}
                                onChange={event => onChange('message', event.target.value)}
                                placeholder={t('menuPanel.messagePlaceholder')}
                                className="field-input mono"
                                rows={7}
                            />
                            {pickerRange && (
                                <SelectIdDialog
                                    onSelect={id => {
                                        insertIntoMessage(`{{${id}}}`, pickerRange, false);
                                        setPickerRange(null);
                                    }}
                                    onClose={() => setPickerRange(null)}
                                />
                            )}
                            <div className="field-hint">
                                {t('menuPanel.httpBodyHint1')}
                                {'{{datapunkt.id}}'}
                                {t('menuPanel.httpBodyHint2')}
                                {node.data.emojiMode === 'dynamic' ? t('menuPanel.httpBodyHintStatus') : ''}
                                {node.data.datapoint ? t('menuPanel.httpBodyHintDatapoint') : ''}
                                {node.data.scriptId ? t('menuPanel.httpBodyHintScript') : ''}
                            </div>
                        </>
                    )}
                    {node.type === 'number' && (
                        <div className="field-row">
                            <div
                                style={{
                                    flex: 1,
                                }}
                            >
                                <label className="field-label">Min</label>
                                <input
                                    type="number"
                                    value={node.data.min ?? ''}
                                    onChange={event => onChange('min', event.target.value)}
                                    className="field-input"
                                />
                            </div>
                            <div
                                style={{
                                    flex: 1,
                                }}
                            >
                                <label className="field-label">Max</label>
                                <input
                                    type="number"
                                    value={node.data.max ?? ''}
                                    onChange={event => onChange('max', event.target.value)}
                                    className="field-input"
                                />
                            </div>
                        </div>
                    )}
                </>
            )}
            <button
                className="duplicate-btn"
                onClick={onDuplicate}
            >
                <Copy size={13} />
                {t('menuPanel.duplicateSimple')}
            </button>
            <button
                className="duplicate-btn"
                onClick={onDuplicateWithChildren}
            >
                <Copy size={13} />
                {t('menuPanel.duplicateWithChildren')}
            </button>
            <button
                className="delete-btn"
                onClick={onDelete}
            >
                <Trash2 size={13} />
                {t('menuPanel.deleteNode')}
            </button>
            <button
                className="delete-btn"
                onClick={onDeleteWithChildren}
            >
                <Trash2 size={13} />
                {t('menuPanel.deleteWithChildren')}
            </button>
        </div>
    );
}
