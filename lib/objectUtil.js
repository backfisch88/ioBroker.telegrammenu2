'use strict';

/**
 * True if another adapter (History, InfluxDB, SQL, ...) stored settings on the object.
 *
 * @param {object | null | undefined} obj object
 */
function hasCustom(obj) {
    const custom = obj?.common?.custom;
    return !!custom && typeof custom === 'object' && Object.keys(custom).length > 0;
}

/**
 * Deletes an object unless it carries common.custom settings of other adapters.
 * Those would be lost for good, so the object is kept and a warning is logged.
 *
 * @param {object} adapter adapter instance
 * @param {string} id object id (without namespace)
 * @param {object} [options] passed to delObject, e.g. { recursive: true }
 * @returns {Promise<boolean>} true if deleted (or already gone), false if kept
 */
async function delObjectKeepCustom(adapter, id, options) {
    const obj = await adapter.getObjectAsync(id);
    if (!obj) {
        return true;
    }
    if (hasCustom(obj)) {
        adapter.log.warn(
            `Keeping ${id}: custom settings present - remove them manually if the object is no longer needed.`,
        );
        return false;
    }
    await (options ? adapter.delObjectAsync(id, options) : adapter.delObjectAsync(id));
    return true;
}

module.exports = { hasCustom, delObjectKeepCustom };
