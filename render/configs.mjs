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

const DIR = path.dirname(fileURLToPath(import.meta.url));
export const CONFIGS_DIR = path.join(DIR, 'configs');

const ID_RE = /^[A-Za-z0-9_-]+$/;
const genId = () => crypto.randomBytes(5).toString('hex');
const fileFor = (id) => path.join(CONFIGS_DIR, `${id}.json`);

function ensureDir() { fs.mkdirSync(CONFIGS_DIR, { recursive: true }); }

export function listConfigs() {
  ensureDir();
  return fs.readdirSync(CONFIGS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

export function getConfig(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const f = fileFor(id);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

/** Create (no id) or update (id given) a config. Throws on bad input. */
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
  fs.writeFileSync(fileFor(cfg.id), JSON.stringify(cfg, null, 2));
  return cfg;
}

export function deleteConfig(id) {
  const cfg = getConfig(id);
  if (!cfg) return false;
  fs.unlinkSync(fileFor(id));
  return true;
}

/** Config ids whose sequence references any of the given clip ids (e.g. to know
 *  which live overlays to notify when a clip is downloaded/deleted). */
export function configsReferencing(clipIds) {
  const ids = new Set(clipIds);
  return listConfigs().filter(c => (c.sequence || []).some(id => ids.has(id))).map(c => c.id);
}
