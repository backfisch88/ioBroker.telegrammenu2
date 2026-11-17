import type { AdminConnection, IobTheme, ThemeType } from '@iobroker/gui-components';
import { createContext, useContext } from 'react';

/** What the object picker needs from Admin: the connection and the theme of Admin */
export interface EditorContextValue {
    socket: AdminConnection;
    theme?: IobTheme;
    themeType: ThemeType;
    /** Path prefix of the icons in the object browser */
    imagePrefix: string;
}

export const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditorContext(): EditorContextValue | null {
    return useContext(EditorContext);
}
