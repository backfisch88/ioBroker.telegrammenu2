import React from 'react';

import { ConfigGeneric, type ConfigGenericProps, type ConfigGenericState } from '@iobroker/json-config';
import flowCss from '@xyflow/react/dist/style.css?inline';

import Editor from './Editor';
import editorCss from './editor.css?inline';

/**
 * The custom item of admin/jsonTab.json. It only hands the Admin socket and theme to the editor,
 * the editor itself is the same on every Admin that supports GUI API 2.
 */
export default class TelegramMenu2Tab extends ConfigGeneric<ConfigGenericProps, ConfigGenericState> {
    renderItem(): React.JSX.Element {
        const theme = this.props.oContext.themeType === 'light' ? 'light' : 'dark';
        return (
            <div
                className="tm2"
                data-theme={theme}
                style={{ height: 'calc(100vh - 130px)', minHeight: 480 }}
            >
                <style>{flowCss}</style>
                <style>{editorCss}</style>
                <Editor
                    socket={this.props.oContext.socket}
                    themeType={theme}
                    theme={this.props.oContext.theme}
                    imagePrefix={this.props.oContext.imagePrefix}
                />
            </div>
        );
    }
}
