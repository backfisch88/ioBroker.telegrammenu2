import { I18n } from '@iobroker/gui-components';

import de from './i18n/de.json';
import en from './i18n/en.json';
import es from './i18n/es.json';
import fr from './i18n/fr.json';
import it from './i18n/it.json';
import nl from './i18n/nl.json';
import pl from './i18n/pl.json';
import pt from './i18n/pt.json';
import ru from './i18n/ru.json';
import uk from './i18n/uk.json';
import zhCn from './i18n/zh-cn.json';

const DICTIONARIES: Record<string, Record<string, string>> = {
    en,
    de,
    ru,
    pt,
    nl,
    fr,
    it,
    es,
    pl,
    uk,
    'zh-cn': zhCn,
};

/** The language Admin is set to, English if the editor has no text for it */
function currentLanguage(): string {
    const language = (I18n.getLanguage() || 'en').toLowerCase();
    return language in DICTIONARIES ? language : 'en';
}

/** Translate a key, `{name}` placeholders are replaced from `vars` */
export function t(key: string, vars?: Record<string, string | number>): string {
    let text = DICTIONARIES[currentLanguage()]?.[key] ?? DICTIONARIES.en[key] ?? key;
    if (vars) {
        for (const name of Object.keys(vars)) {
            text = text.split(`{${name}}`).join(String(vars[name]));
        }
    }
    return text;
}
