import { Database } from 'lucide-react';
import React, { useState } from 'react';

import { useEditorContext } from './editorContext';
import { t } from './i18n';
import { SelectIdDialog } from './SelectIdDialog';

interface Props {
    value: string;
    onChange: (value: string) => void;
    placeholder?: string;
    fontSize?: number;
}

/** A text field for an object id with a button that opens the object browser of Admin */
export function ObjectIdInput({ value, onChange, placeholder, fontSize }: Props): React.JSX.Element {
    const [open, setOpen] = useState(false);
    const canPick = !!useEditorContext()?.theme;

    return (
        <div className="id-input">
            <input
                value={value}
                onChange={event => onChange(event.target.value)}
                placeholder={placeholder}
                className="field-input mono"
                style={fontSize ? { fontSize } : undefined}
            />
            {canPick && (
                <button
                    type="button"
                    className="id-pick-btn"
                    title={t('tab.pickObject')}
                    aria-label={t('tab.pickObject')}
                    onClick={() => setOpen(true)}
                >
                    <Database size={14} />
                </button>
            )}
            {open && (
                <SelectIdDialog
                    selected={value}
                    onSelect={id => {
                        onChange(id);
                        setOpen(false);
                    }}
                    onClose={() => setOpen(false)}
                />
            )}
        </div>
    );
}
