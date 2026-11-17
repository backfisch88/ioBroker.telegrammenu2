import { t } from './i18n';
import type { EditorEdge, EditorNode } from './registryGraph';

/** Shown while the adapter has no menus yet, so the editor is not an empty page */
export function createDemoGraph(): { nodes: EditorNode[]; edges: EditorEdge[] } {
    const nodes: EditorNode[] = [
        {
            id: 'n1',
            type: 'menu',
            position: {
                x: 40,
                y: 300,
            },
            data: {
                emoji: '\u{1F3E0}',
                title: t('demo.mainMenuTitle'),
                menuKey: 'main',
            },
        },
        {
            id: 'n2',
            type: 'menu',
            position: {
                x: 420,
                y: 60,
            },
            data: {
                emoji: '\u{1F9EA}',
                title: t('demo.testMenuTitle'),
                menuKey: 'test_menu',
            },
        },
        {
            id: 'n3',
            type: 'menu',
            position: {
                x: 420,
                y: 200,
            },
            data: {
                emoji: '\u{1F3A8}',
                title: t('demo.demoMenuTitle'),
                menuKey: 'demo_menu',
                emojiMode: 'dynamic',
                statusDatapoint: '0_userdata.0.example_state',
                statusRules: [
                    {
                        value: 'ok',
                        emoji: '\u{1F7E2}',
                    },
                    {
                        value: 'warn',
                        emoji: '\u{1F7E1}',
                    },
                    {
                        value: 'error',
                        emoji: '\u{1F534}',
                    },
                ],
            },
        },
        {
            id: 'n4',
            type: 'auto',
            position: {
                x: 760,
                y: 340,
            },
            data: {
                emoji: '\u{1F464}',
                title: t('demo.usersTitle'),
                menuKey: 'admin_main',
                source: 'users',
            },
        },
        {
            id: 'n5',
            type: 'auto',
            position: {
                x: 760,
                y: 460,
            },
            data: {
                emoji: '\u{1F514}',
                title: t('demo.notifyTitle'),
                menuKey: 'settings_notify',
                source: 'notifyPrefs',
                notifyAreas: [
                    {
                        area: 'example',
                        typesStr: 'info',
                        areaLabel: t('demo.exampleAreaLabel'),
                    },
                ],
            },
        },
        {
            id: 'n6',
            type: 'menu',
            position: {
                x: 420,
                y: 340,
            },
            data: {
                emoji: '\u2699\uFE0F',
                title: t('demo.settingsTitle'),
                menuKey: 'settings_main',
            },
        },
        {
            id: 'n20',
            type: 'nav',
            position: {
                x: 760,
                y: 580,
            },
            data: {
                emoji: '\u2B05\uFE0F',
                title: t('canvas.defaultBackTitle'),
                action: 'back',
            },
        },
        {
            id: 'n21',
            type: 'nav',
            position: {
                x: 760,
                y: 640,
            },
            data: {
                emoji: '\u{1F3E0}',
                title: t('demo.mainMenuTitle'),
                action: 'main',
            },
        },
        {
            id: 'n7',
            type: 'command',
            position: {
                x: 760,
                y: 60,
            },
            data: {
                emoji: '\u{1F44B}',
                title: t('demo.pingTitle'),
                cmd: 'TG:EXAMPLE:PING',
            },
        },
        {
            id: 'n8',
            type: 'nav',
            position: {
                x: 760,
                y: 130,
            },
            data: {
                emoji: '\u2B05\uFE0F',
                title: t('canvas.defaultBackTitle'),
                action: 'back',
            },
        },
        {
            id: 'n9',
            type: 'nav',
            position: {
                x: 760,
                y: 190,
            },
            data: {
                emoji: '\u{1F3E0}',
                title: t('demo.mainMenuTitle'),
                action: 'main',
            },
        },
        {
            id: 'n10',
            type: 'command',
            position: {
                x: 760,
                y: 280,
            },
            data: {
                emoji: '\u{1F4AC}',
                title: t('demo.placeholderMsgTitle'),
                cmd: 'TG:DEMO:MESSAGE',
                message: t('demo.placeholderMsgBody', {
                    chatIdVar: '{{telegrammenu2.0.runtime.lastChatId}}',
                    cmdIdVar: '{{telegrammenu2.0.cmd.id}}',
                    dpVar: '{{datapunkt.id}}',
                }),
            },
        },
        {
            id: 'n11',
            type: 'command',
            position: {
                x: 760,
                y: 400,
            },
            data: {
                emoji: '\u2705',
                title: t('demo.statusOkTitle'),
                cmd: 'TG:DEMO:STATUS:OK',
            },
        },
        {
            id: 'n12',
            type: 'command',
            position: {
                x: 760,
                y: 460,
            },
            data: {
                emoji: '\u26A0\uFE0F',
                title: t('demo.statusWarnTitle'),
                cmd: 'TG:DEMO:STATUS:WARN',
            },
        },
        {
            id: 'n13',
            type: 'command',
            position: {
                x: 760,
                y: 520,
            },
            data: {
                emoji: '\u{1F6A8}',
                title: t('demo.statusErrorTitle'),
                cmd: 'TG:DEMO:STATUS:ERROR',
            },
        },
        {
            id: 'n18',
            type: 'command',
            position: {
                x: 760,
                y: 580,
            },
            data: {
                emoji: '\u{1F44B}',
                title: t('demo.greetingTitle'),
                cmd: 'TG:GREETING:HELLO',
            },
        },
        {
            id: 'n19',
            type: 'command',
            position: {
                x: 760,
                y: 640,
            },
            data: {
                emoji: '\u{1F9E9}',
                title: t('demo.scriptBridgeTitle'),
                cmd: 'TG:TESTSCRIPT:SHOW',
            },
        },
        {
            id: 'n17',
            type: 'nav',
            position: {
                x: 760,
                y: 700,
            },
            data: {
                emoji: '\u2B05\uFE0F',
                title: t('canvas.defaultBackTitle'),
                action: 'back',
            },
        },
    ];
    const edges: EditorEdge[] = [
        {
            id: 'e1',
            source: 'n1',
            target: 'n2',
        },
        {
            id: 'e2',
            source: 'n1',
            target: 'n3',
        },
        {
            id: 'e5',
            source: 'n1',
            target: 'n6',
        },
        {
            id: 'e3',
            source: 'n6',
            target: 'n4',
        },
        {
            id: 'e4',
            source: 'n6',
            target: 'n5',
        },
        {
            id: 'e16',
            source: 'n6',
            target: 'n20',
        },
        {
            id: 'e17',
            source: 'n6',
            target: 'n21',
        },
        {
            id: 'e6',
            source: 'n2',
            target: 'n7',
        },
        {
            id: 'e7',
            source: 'n2',
            target: 'n8',
        },
        {
            id: 'e8',
            source: 'n2',
            target: 'n9',
        },
        {
            id: 'e9',
            source: 'n3',
            target: 'n10',
        },
        {
            id: 'e10',
            source: 'n3',
            target: 'n11',
        },
        {
            id: 'e11',
            source: 'n3',
            target: 'n12',
        },
        {
            id: 'e12',
            source: 'n3',
            target: 'n13',
        },
        {
            id: 'e13',
            source: 'n3',
            target: 'n17',
        },
        {
            id: 'e14',
            source: 'n3',
            target: 'n18',
        },
        {
            id: 'e15',
            source: 'n3',
            target: 'n19',
        },
    ].map(n => ({
        ...n,
        style: {
            stroke: 'var(--edge)',
            strokeWidth: 1.5,
        },
    }));
    return { nodes, edges };
}

let idCounter = 100;

/** Id for a node the user adds or duplicates, `prefix` tells menus (m) from buttons (n, a) */
export function newId(prefix: string): string {
    return `${prefix}${idCounter++}`;
}
