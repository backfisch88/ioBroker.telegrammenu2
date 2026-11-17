import { Plus, X } from 'lucide-react';
import React, { useEffect, useState } from 'react';

import type { MenuApi } from './api';
import { t } from './i18n';
import { areaToFields, type EditorNode } from './registryGraph';

/** One notification area as the text fields of the panel show it */
interface AreaFields {
    area: string;
    typesStr: string;
    areaLabel?: string;
    overrideStr?: string;
    labelsStr?: string;
}

interface Props {
    node: EditorNode;
    onChange: (key: string, value: unknown) => void;
    api: MenuApi;
}

const errorText = (message: string | undefined): string => t('tab.errorMsg', { msg: message || t('tab.unknown') });

/** The areas of the notification menu: edit them here, load the live ones and approve new ones */
export function NotifyAreasEditor({ node, onChange, api }: Props): React.JSX.Element {
    const areas: AreaFields[] = node.data.notifyAreas || [];
    const [loadMessage, setLoadMessage] = useState<string | null>(null);
    const [pending, setPending] = useState<Record<string, string[]> | null>(null);
    const [pendingError, setPendingError] = useState<string | null>(null);

    const setAreas = (next: AreaFields[]): void => onChange('notifyAreas', next);
    const addArea = (): void => setAreas([...areas, { area: '', typesStr: '' }]);
    const updateArea = (index: number, key: keyof AreaFields, value: string): void =>
        setAreas(areas.map((area, position) => (position === index ? { ...area, [key]: value } : area)));
    const removeArea = (index: number): void => setAreas(areas.filter((_area, position) => position !== index));

    // Areas that scripts announced but nobody approved yet
    const loadPending = async (): Promise<void> => {
        setPendingError(null);
        try {
            const response = await api.getPendingNotifyAreas();
            if (!response || response.ok === false) {
                setPendingError(errorText(response?.error));
                return;
            }
            setPending(response.areas || {});
        } catch (error) {
            setPendingError(errorText((error as Error).message));
        }
    };

    const approve = async (area: string): Promise<void> => {
        try {
            await api.approveNotifyArea(area);
            setPending(current => {
                const rest = { ...current };
                delete rest[area];
                return rest;
            });
        } catch (error) {
            setPendingError(t('tab.approveError', { msg: (error as Error).message }));
        }
    };

    // Replaces the local list by the areas the adapter has right now
    const liveLoad = async (): Promise<void> => {
        setLoadMessage('loading');
        try {
            const response = await api.getNotifyAreasFull();
            if (!response || response.ok === false) {
                setLoadMessage(errorText(response?.error));
                return;
            }
            const live: Record<string, any> = response.areas || {};
            const fields = Object.entries(live).map(([area, info]) => areaToFields(area, info));
            setAreas(fields);
            onChange('_notifyAreasSnapshot', Object.keys(live));
            setLoadMessage(t('tab.areasLoadedMsg', { n: fields.length }));
        } catch (error) {
            setLoadMessage(errorText((error as Error).message));
        }
    };

    useEffect(() => {
        void loadPending();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div className="status-rules">
            <div
                className="field-label-row"
                style={{ marginTop: 0 }}
            >
                <label
                    className="field-label"
                    style={{ margin: 0 }}
                >
                    {t('tab.areasHeading')}
                </label>
                <button
                    type="button"
                    className="placeholder-btn"
                    onClick={() => void liveLoad()}
                >
                    {t('tab.liveLoad')}
                </button>
            </div>
            {loadMessage && (
                <div
                    className="field-hint"
                    style={{ marginBottom: 6 }}
                >
                    {loadMessage}
                </div>
            )}
            <div
                className="field-hint"
                style={{ marginBottom: 6 }}
            >
                {t('menuPanel.liveLoadHint')}
            </div>
            {pendingError && (
                <div
                    className="field-hint"
                    style={{ marginBottom: 6 }}
                >
                    {pendingError}
                </div>
            )}
            {pending && Object.keys(pending).length > 0 && (
                <div className="pending-box">
                    <div
                        className="field-label"
                        style={{ margin: '0 0 6px 0', color: 'var(--warn)' }}
                    >
                        {t('autoMenu.pendingLabel')}
                    </div>
                    {Object.entries(pending).map(([area, types]) => (
                        <div
                            className="rule-row"
                            key={area}
                        >
                            <span className="pending-name">
                                {area}{' '}
                                <span
                                    className="field-hint"
                                    style={{ display: 'inline' }}
                                >
                                    ({(types || []).join(', ')})
                                </span>
                            </span>
                            <button
                                type="button"
                                className="approve-btn"
                                onClick={() => void approve(area)}
                            >
                                {t('tab.approveBtn')}
                            </button>
                        </div>
                    ))}
                </div>
            )}
            {areas.map((area, index) => (
                <div key={index}>
                    <div className="rule-row">
                        <input
                            value={area.area}
                            onChange={event => updateArea(index, 'area', event.target.value)}
                            placeholder={t('autoMenu.areaTechPlaceholder')}
                            className="field-input rule-value mono"
                        />
                        <input
                            value={area.typesStr}
                            onChange={event => updateArea(index, 'typesStr', event.target.value)}
                            placeholder={t('autoMenu.typesPlaceholder')}
                            className="field-input mono"
                            style={{ flex: 1.4 }}
                        />
                        <button
                            type="button"
                            className="rule-remove"
                            onClick={() => removeArea(index)}
                        >
                            <X size={12} />
                        </button>
                    </div>
                    <input
                        value={area.areaLabel || ''}
                        onChange={event => updateArea(index, 'areaLabel', event.target.value)}
                        placeholder={t('autoMenu.areaLabelPlaceholder')}
                        className="field-input mono"
                        style={{ marginBottom: 4, fontSize: 10 }}
                    />
                    <input
                        value={area.overrideStr || ''}
                        onChange={event => updateArea(index, 'overrideStr', event.target.value)}
                        placeholder={t('autoMenu.overrideTypesPlaceholder')}
                        className="field-input mono"
                        style={{ marginBottom: 4, fontSize: 10 }}
                    />
                    <input
                        value={area.labelsStr || ''}
                        onChange={event => updateArea(index, 'labelsStr', event.target.value)}
                        placeholder={t('autoMenu.typeLabelsPlaceholder')}
                        className="field-input mono"
                        style={{ marginBottom: 8, fontSize: 10 }}
                    />
                </div>
            ))}
            <button
                type="button"
                className="add-rule-btn"
                onClick={addArea}
            >
                <Plus size={11} />
                {t('autoMenu.addArea')}
            </button>
        </div>
    );
}
