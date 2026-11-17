import { t } from './i18n';

/** The menus the adapter builds by itself */
export const AUTO_SOURCES: Record<string, { label: string; hint: string }> = {
    users: {
        get label(): string {
            return t('autoMenu.usersLabel');
        },
        get hint(): string {
            return t('autoMenu.usersHint');
        },
    },
    notifyPrefs: {
        get label(): string {
            return t('autoMenu.notifyLabel');
        },
        get hint(): string {
            return t('autoMenu.notifyHint');
        },
    },
    percentRange: {
        get label(): string {
            return t('autoMenu.percentRangeLabel');
        },
        get hint(): string {
            return t('menuPanel.percentHint');
        },
    },
    numberRange: {
        get label(): string {
            return t('autoMenu.numberRangeLabel');
        },
        get hint(): string {
            return t('menuPanel.numberRangeHint');
        },
    },
};
