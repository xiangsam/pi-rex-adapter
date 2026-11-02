import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CONFIG = Object.freeze({ language: 'en', panesPerTab: 2 });

// Separate extension settings: never rewrite Pi's settings.json or create files
// on startup. Read once per session/reload; project fields override global ones.
export async function loadConfig(cwd, { env = process.env, home = homedir() } = {}) {
  const configuredDir = env.PI_CODING_AGENT_DIR;
  const agentDir = configuredDir
    ? configuredDir.replace(/^~(?=$|\/)/, home) : join(home, '.pi', 'agent');
  const files = [join(agentDir, 'rex.json'), ...(cwd ? [join(cwd, '.pi', 'rex.json')] : [])];
  const config = { ...DEFAULT_CONFIG }, errors = [];
  for (const file of new Set(files)) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
      for (const [key, item] of Object.entries(value)) {
        if (key === 'language' && ['en', 'zh'].includes(item)) config.language = item;
        else if (key === 'panesPerTab' && Number.isSafeInteger(item) && item >= 1) config.panesPerTab = item;
        else errors.push(`${file}: ${key === 'language' ? 'language must be "en" or "zh"' : key === 'panesPerTab' ? 'panesPerTab must be a positive integer' : `Unknown setting: ${key}`}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') errors.push(`${file}: ${error.message}`); }
  }
  return { config, errors };
}
