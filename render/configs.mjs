/* =============================================================================
 * configs.mjs — saved reel configurations (name + clip sequence + order + toggles).
 * One JSON file per config in render/configs/ (gitignored, local user data), keyed
 * by an opaque random id so renaming a config never changes its overlay URL — that
 * URL is what gets pasted into an OBS Browser Source.
 * ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './json-store.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONFIGS_DIR = path.join(DIR, 'configs');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const genId = () => crypto.randomBytes(5).toString('hex');
const fileFor = (id) => path.join(CONFIGS_DIR, `${id}.json`);

/**
 * @typedef {object} ReelConfig
 * @property {string} id - Opaque random id (also the overlay URL's `?config=`).
 * @property {string} name
 * @property {string[]} sequence - Included clip ids, in play order (for `order:'custom'`).
 * @property {'random'|'views'|'recent'|'oldest'|'custom'} order
 * @property {boolean} showTitle
 * @property {boolean} showBroadcaster
 * @property {boolean} showGame
 * @property {string} createdAt - ISO timestamp.
 * @property {string} updatedAt - ISO timestamp.
 */

function ensureDir() { fs.mkdirSync(CONFIGS_DIR, { recursive: true }); }

/** All saved configurations, most recently updated first. */
export function listConfigs() {
  ensureDir();
  return fs.readdirSync(CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => readJson(path.join(CONFIGS_DIR, f)))
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

/**
 * Load a single configuration by id.
 *
 * @param {string} id
 * @returns {?ReelConfig} `null` if the id is malformed or unknown.
 */
export function getConfig(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  return readJson(fileFor(id));
}

/**
 * Create (no `id`) or update (`id` given) a configuration.
 *
 * @param {object} fields
 * @param {string} [fields.id] - Existing config id to update; omitted to create new.
 * @param {string} fields.name
 * @param {string[]} fields.sequence
 * @param {ReelConfig['order']} [fields.order]
 * @param {boolean} [fields.showTitle]
 * @param {boolean} [fields.showBroadcaster]
 * @param {boolean} [fields.showGame]
 * @returns {ReelConfig} The saved configuration.
 * @throws {Error} On a missing name, a malformed `sequence`, or an unknown `id`.
 */
export function saveConfig({ id, name, sequence, order, showTitle, showBroadcaster, showGame } = {}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('Name required');
  if (!Array.isArray(sequence) || sequence.some(x => typeof x !== 'string')) throw new Error('sequence must be a string array');
  const now = new Date().toISOString();
  ensureDir();

  let cfg;
  if (id) {
    const existing = getConfig(id);
    if (!existing) throw new Error('Config not found');
    cfg = {
      ...existing,
      name: cleanName, sequence, order: order || existing.order,
      showTitle: showTitle !== false, showBroadcaster: showBroadcaster !== false, showGame: showGame !== false,
      updatedAt: now,
    };
  } else {
    cfg = {
      id: genId(), name: cleanName, sequence, order: order || 'random',
      showTitle: showTitle !== false, showBroadcaster: showBroadcaster !== false, showGame: showGame !== false,
      createdAt: now, updatedAt: now,
    };
  }
  writeJson(fileFor(cfg.id), cfg);
  return cfg;
}

/**
 * Delete a configuration.
 *
 * @param {string} id
 * @returns {boolean} Whether a configuration was actually removed.
 */
export function deleteConfig(id) {
  const cfg = getConfig(id);
  if (!cfg) return false;
  fs.unlinkSync(fileFor(id));
  return true;
}

/**
 * Config ids whose sequence references any of the given clip ids (e.g. to know
 * which live overlays to notify when a clip is downloaded/deleted).
 *
 * @param {string[]} clipIds
 * @returns {string[]} Matching config ids.
 */
export function configsReferencing(clipIds) {
  const ids = new Set(clipIds);
  return listConfigs().filter(c => (c.sequence || []).some(id => ids.has(id))).map(c => c.id);
}
