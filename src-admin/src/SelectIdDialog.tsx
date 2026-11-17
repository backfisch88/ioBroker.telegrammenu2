import { DialogSelectID } from '@iobroker/gui-components';
import React from 'react';

import { useEditorContext } from './editorContext';

interface Props {
    /** The id that is selected when the dialog opens */
    selected?: string;
    /** `state` for datapoints (default), `script` for scripts of the JavaScript adapter */
    type?: 'state' | 'script';
    onSelect: (id: string) => void;
    onClose: () => void;
}

/** The object browser of Admin, the same dialog the JSON config uses for its object id fields */
export function SelectIdDialog({ selected, type, onSelect, onClose }: Props): React.JSX.Element | null {
    const context = useEditorContext();
    if (!context?.theme) {
        return null;
    }
    return (
        <DialogSelectID
            imagePrefix={context.imagePrefix}
            dialogName="admin.telegrammenu2"
            themeType={context.themeType}
            theme={context.theme}
            socket={context.socket}
            types={type ? [type] : undefined}
            selected={selected}
            onClose={onClose}
            onOk={selectedId => {
                const id = Array.isArray(selectedId) ? selectedId[0] : selectedId;
                if (id) {
                    onSelect(id);
                }
            }}
        />
    );
}
