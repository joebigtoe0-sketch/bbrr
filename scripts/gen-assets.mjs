#!/usr/bin/env node
/**
 * Batch sprite generator: iterates the asset manifest and calls the OpenAI
 * Images API (gpt-image-1) once per asset, saving transparent PNGs.
 *
 *   node scripts/gen-assets.mjs                # all missing assets
 *   node scripts/gen-assets.mjs crt printer    # only these keys
 *   node scripts/gen-assets.mjs --force        # regenerate even if file exists
 *   node scripts/gen-assets.mjs --list         # print the manifest and exit
 *
 * The API key is read from process.env.OPENAI_API_KEY, or from the root .env
 * (gitignored). It is NEVER printed or written anywhere by this script.
 *
 * Reality check: gpt-image-1 outputs high-res stylized art, not pixel-perfect
 * game sheets. Great for props/tiles/concept frames; walk cycles still need a
 * sprite tool or hand cleanup. Each high-quality image costs money on your
 * OpenAI account — this runs sequentially so you can watch the spend.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STYLE_BLOCK, ASSETS } from './asset-manifest.mjs';

const root = resolve(fileURLToPath(import.meta.url), '../..');

function loadKey() {
  const fromEnv = process.env.OPENAI_API_KEY;
  if (fromEnv && fromEnv.startsWith('sk-')) return fromEnv;
  const envPath = resolve(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*OPENAI_API_KEY\s*=\s*(.+?)\s*$/);
      if (m) {
        const v = m[1].replace(/^["']|["']$/g, '').trim();
        if (v.startsWith('sk-')) return v;
      }
    }
  }
  return null;
}

const args = process.argv.slice(2);
if (args.includes('--list')) {
  for (const a of ASSETS) console.log(`${a.key.padEnd(18)} -> ${a.file}  [${a.size}]`);
  process.exit(0);
}

const force = args.includes('--force');
const only = args.filter((a) => !a.startsWith('--'));

const KEY = loadKey();
if (!KEY) {
  console.error('No OPENAI_API_KEY found. Put your key in the root .env as OPENAI_API_KEY=sk-...');
  process.exit(1);
}

const outDir = resolve(root, 'client/public/sprites/generated');
mkdirSync(outDir, { recursive: true });

const targets = ASSETS.filter((a) => only.length === 0 || only.includes(a.key));
if (targets.length === 0) {
  console.error(`No matching assets. Known keys: ${ASSETS.map((a) => a.key).join(', ')}`);
  process.exit(1);
}

let ok = 0;
let failed = 0;
for (const a of targets) {
  const outPath = resolve(outDir, a.file);
  if (existsSync(outPath) && !force) {
    console.log(`skip (exists): ${a.file}`);
    continue;
  }
  process.stdout.write(`generating ${a.file} (${a.size}) ... `);
  try {
    const res = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-image-1',
        prompt: `${STYLE_BLOCK}\n\n${a.prompt}`,
        size: a.size ?? '1024x1024',
        background: 'transparent',
        quality: a.quality ?? 'high',
        output_format: 'png',
        n: 1,
      }),
    });
    if (!res.ok) {
      failed++;
      console.log(`FAIL ${res.status}`);
      console.log('  ', (await res.text()).slice(0, 400));
      continue;
    }
    const json = await res.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) {
      failed++;
      console.log('FAIL (no image in response)');
      continue;
    }
    writeFileSync(outPath, Buffer.from(b64, 'base64'));
    ok++;
    console.log('ok');
  } catch (e) {
    failed++;
    console.log(`ERROR ${e.message}`);
  }
}

console.log(`\ndone: ${ok} generated, ${failed} failed -> ${outDir}`);
