import { Plus, Smile, X } from 'lucide-react';
import React from 'react';

import { t } from './i18n';
import { ObjectIdInput } from './ObjectIdInput';
import type { EditorNode } from './registryGraph';

/** One status of a node: the value of the datapoint, the emoji for it and, for buttons, what pressing it does */
interface StatusRule {
    value: string;
    emoji: string;
    label?: string;
    writeDatapoint?: string;
    writeValue?: string;
    statusText?: string;
}

export function StatusRules({ node, onChange }: { node: EditorNode; onChange: (key: string, value: any) => void }) {
    let rules: StatusRule[] = node.data.statusRules || [],
        isButton = node.type !== 'menu' && node.type !== 'auto',
        setRules = (next: StatusRule[]) => onChange('statusRules', next),
        addRule = () =>
            setRules([
                ...rules,
                {
                    value: '',
                    emoji: '',
                },
            ]),
        updateRule = (index: number, key: keyof StatusRule, value: string) =>
            setRules(rules.map((rule, position) => (position === index ? { ...rule, [key]: value } : rule))),
        removeRule = (index: number) => setRules(rules.filter((_rule, position) => position !== index));
    return (
        <div className="status-rules">
            <label className="field-label">{t('menuPanel.statusDatapoint')}</label>
            <ObjectIdInput
                value={node.data.statusDatapoint || ''}
                onChange={value => onChange('statusDatapoint', value)}
                placeholder="0_userdata.0.example_state"
            />
            {isButton && (
                <div
                    className="field-hint"
                    style={{
                        marginBottom: 6,
                    }}
                >
                    {t('menuPanel.multiStatusHint')}
                </div>
            )}
            {rules.map((rule, index) => (
                <div
                    className="rule-block"
                    key={index}
                >
                    <div className="rule-row">
                        <input
                            value={rule.value}
                            onChange={event => updateRule(index, 'value', event.target.value)}
                            placeholder={t('menuPanel.statusValuePlaceholder')}
                            className="field-input rule-value mono"
                        />
                        <input
                            value={rule.emoji}
                            onChange={event => updateRule(index, 'emoji', event.target.value)}
                            placeholder="🚨"
                            className="field-input rule-emoji"
                        />
                        <button
                            type="button"
                            className="rule-remove"
                            onClick={() => removeRule(index)}
                        >
                            <X size={12} />
                        </button>
                    </div>
                    {isButton && (
                        <>
                            <input
                                value={rule.label || ''}
                                onChange={event => updateRule(index, 'label', event.target.value)}
                                placeholder={t('menuPanel.statusLabelPlaceholder')}
                                className="field-input mono"
                                style={{
                                    marginTop: 4,
                                    fontSize: 11,
                                }}
                            />
                            <label
                                className="field-label"
                                style={{
                                    fontSize: 10,
                                    marginTop: 4,
                                    marginBottom: 2,
                                }}
                            >
                                {t('menuPanel.targetDatapoint')}
                            </label>
                            <ObjectIdInput
                                value={rule.writeDatapoint || ''}
                                onChange={value => updateRule(index, 'writeDatapoint', value)}
                                placeholder="0_userdata.0.example_state"
                                fontSize={11}
                            />
                            <label
                                className="field-label"
                                style={{
                                    fontSize: 10,
                                    marginTop: 4,
                                    marginBottom: 2,
                                }}
                            >
                                {t('menuPanel.targetValueLabel')}
                            </label>
                            <input
                                value={rule.writeValue || ''}
                                onChange={event => updateRule(index, 'writeValue', event.target.value)}
                                placeholder="true"
                                className="field-input mono"
                                style={{
                                    fontSize: 11,
                                }}
                            />
                            <label
                                className="field-label"
                                style={{
                                    fontSize: 10,
                                    marginTop: 4,
                                    marginBottom: 2,
                                }}
                            >
                                {t('menuPanel.statusTextLabel1')}
                                {'{status}'}
                                {t('menuPanel.statusTextLabel2')}
                            </label>
                            <input
                                value={rule.statusText || ''}
                                onChange={event => updateRule(index, 'statusText', event.target.value)}
                                placeholder={t('tab.statusTextExample')}
                                className="field-input mono"
                                style={{
                                    fontSize: 11,
                                }}
                            />
                        </>
                    )}
                </div>
            ))}
            <button
                type="button"
                className="add-rule-btn"
                onClick={addRule}
            >
                <Plus size={11} />
                {t('menuPanel.addStatus')}
            </button>
            <label className="field-label">{t('menuPanel.defaultEmojiFallback')}</label>
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
        </div>
    );
}
