'use strict';

const crypto = require('node:crypto');

/**
 * Transliterate a free-form name to an ASCII-only object id segment.
 * Only [A-Za-z0-9_-] survive, everything else (including dots) becomes "_".
 * The function is idempotent: slug(slug(x)) === slug(x).
 *
 * @param {string} name free-form name (e.g. a permission, area or menu key)
 * @returns {string} id-safe segment
 */
function asciiSlug(name) {
    const slug = String(name === undefined || name === null ? '' : name)
        .replace(/[äÄ]/g, 'ae')
        .replace(/[öÖ]/g, 'oe')
        .replace(/[üÜ]/g, 'ue')
        .replace(/ß/g, 'ss')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-zA-Z0-9_-]/g, '_');
    return slug || '_';
}

/**
 * Id segment for permissions and notification areas (case is kept).
 *
 * @param {string} name permission or area name
 * @returns {string} id-safe segment
 */
function toPermId(name) {
    return asciiSlug(name);
}

/**
 * Id segment for menu keys (registry / runtime.lastRows). Lower case only, so
 * ids never differ just by case. If the key had to be changed in any way, a
 * short hash of the original key is appended, so two different keys can never
 * end up on the same id. Idempotent.
 *
 * @param {string} menuKey menu key as used in the editor
 * @returns {string} id-safe, unique segment
 */
function toMenuId(menuKey) {
    const original = String(menuKey === undefined || menuKey === null ? '' : menuKey);
    const slug = asciiSlug(original).toLowerCase();
    if (slug === original) {
        return slug;
    }
    const hash = crypto.createHash('sha1').update(original).digest('hex').slice(0, 6);
    return `${slug}_${hash}`;
}

/**
 * Id derivation used before the ASCII-only rule - only needed to find and move
 * old objects during migration.
 *
 * @param {string} menuKey menu key
 * @returns {string} legacy id segment
 */
function legacyMenuId(menuKey) {
    return String(menuKey || '')
        .replace(/[[\]*,;'"`<>\\?]/g, '_')
        .replace(/\s+/g, '_');
}

module.exports = { asciiSlug, toPermId, toMenuId, legacyMenuId };
