import crypto from 'node:crypto';
import { config } from '../config.js';
import { kv } from '../db/repo.js';
import type { World } from '../sim/world.js';

/**
 * X (Twitter) integration — ported from the universe project's proven, deployed
 * setup. Two independent halves, each lighting up only when X_MODE=live AND its
 * keys exist:
 *
 *   READER — polls @X_HANDLE mentions via the official API with a Bearer token
 *     and feeds each mention into the maze as a voice from beyond the walls.
 *     Mentions drip in spaced across the poll window rather than all at once.
 *
 *   POSTER — posts the maze's own utterances to the account via the OFFICIAL X
 *     API v2 with OAuth 1.0a user context. Requires X_POST=on and the four OAuth
 *     keys. Official only, deliberately (session-hack posting gets accounts
 *     suspended).
 *
 * X_MODE=mock keeps everything offline: mentions come only from the admin panel
 * and postTweet just logs. Flip X_MODE=live to go real.
 */

const HANDLE = () => config.X_HANDLE.trim().replace(/^@/, '');
const isLive = () => config.X_MODE === 'live';

export class XClient {
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;

  get postReady(): boolean {
    return !!(
      config.X_CONSUMER_KEY &&
      config.X_CONSUMER_SECRET &&
      config.X_ACCESS_TOKEN &&
      config.X_ACCESS_SECRET
    );
  }

  start(world: World) {
    if (!isLive()) {
      console.log('[x] mock mode — mentions come only from the admin panel; posts just log');
      return;
    }
    // OUT: post the maze's utterances as they are composed
    if (config.X_POST === 'on') {
      if (!this.postReady) {
        console.warn('[x] X_POST=on but OAuth keys are missing — not posting');
      } else {
        world.bus.on((e) => {
          if (e.type === 'maze_tweet') {
            const text = String((e.payload as { text?: unknown }).text ?? '');
            if (text) void this.postTweet(text);
          }
        });
        console.log(`[x] posting as @${HANDLE()} via the official API`);
      }
    }
    // IN: poll mentions via the official API
    if (config.X_BEARER_TOKEN) {
      console.log(`[x] reading mentions of @${HANDLE()} via the official API`);
      const tick = async () => {
        if (this.stopped) return;
        try {
          await this.pollMentionsOfficial(world);
        } catch (e) {
          console.warn('[x] mentions:', String(e).slice(0, 140));
        }
        this.timers.push(setTimeout(tick, Math.max(1, config.X_READ_POLL_MIN) * 60_000));
      };
      this.timers.push(setTimeout(tick, 20_000));
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** Post a tweet as our account. Returns the id (or null on mock/failure). */
  async postTweet(text: string, inReplyTo?: string): Promise<string | null> {
    if (!isLive() || config.X_POST !== 'on') {
      console.log(`[x:mock] would post: "${text.slice(0, 80)}"`);
      return null;
    }
    if (!this.postReady) return null;
    const url = 'https://api.x.com/2/tweets';
    const body: { text: string; reply?: { in_reply_to_tweet_id: string } } = { text: trimForX(text) };
    if (inReplyTo) body.reply = { in_reply_to_tweet_id: inReplyTo };
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { authorization: oauthHeader('POST', url), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.warn(`[x] post http ${res.status}: ${(await res.text()).slice(0, 140)}`);
        return null;
      }
      const data = (await res.json()) as { data?: { id?: string } };
      const id = data.data?.id ?? null;
      if (id) console.log(`[x] posted ${id}`);
      return id;
    } catch (e) {
      console.warn('[x] post error:', String(e).slice(0, 140));
      return null;
    }
  }

  // ---- readers --------------------------------------------------------------

  /** official reader: GET /2/users/:id/mentions with the app Bearer token */
  private async pollMentionsOfficial(world: World) {
    let uid = config.X_USER_ID || kv.get('xSelfId') || '';
    if (!uid) {
      const r = await fetch(`https://api.x.com/2/users/by/username/${HANDLE()}`, {
        headers: { authorization: `Bearer ${config.X_BEARER_TOKEN}` },
      });
      if (!r.ok) {
        console.warn(`[x] user lookup http ${r.status}`);
        return;
      }
      uid = ((await r.json()) as { data?: { id?: string } }).data?.id ?? '';
      if (!uid) return;
      kv.set('xSelfId', uid);
    }
    const since = kv.get('xSinceId');
    const url =
      `https://api.x.com/2/users/${uid}/mentions?max_results=25` +
      `&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username` +
      (since ? `&since_id=${since}` : '');
    const res = await fetch(url, { headers: { authorization: `Bearer ${config.X_BEARER_TOKEN}` } });
    if (!res.ok) {
      console.warn(`[x] mentions http ${res.status}: ${(await res.text()).slice(0, 120)}`);
      return;
    }
    const data = (await res.json()) as {
      data?: { id: string; text: string; author_id?: string }[];
      includes?: { users?: { id: string; username: string }[] };
      meta?: { newest_id?: string };
    };
    const users = new Map((data.includes?.users ?? []).map((u) => [u.id, u.username]));
    const batch: { text: string; author: string | null }[] = [];
    // oldest first, the order they were spoken
    for (const t of (data.data ?? []).slice().reverse()) {
      const author = t.author_id ? (users.get(t.author_id) ?? null) : null;
      if (author && author.toLowerCase() === HANDLE().toLowerCase()) continue;
      const text = cleanTweet(t.text);
      if (text.length < 2) continue;
      batch.push({ text, author });
    }
    this.drip(world, batch);
    if (data.meta?.newest_id) kv.set('xSinceId', data.meta.newest_id);
  }

  /** a poll returning many mentions must not dump them at once — space them out */
  private drip(world: World, items: { text: string; author: string | null }[]) {
    if (!items.length) return;
    const windowMs = Math.max(1, config.X_READ_POLL_MIN) * 60_000 * 0.9;
    const gap = windowMs / items.length;
    items.forEach((w, i) => {
      this.timers.push(
        setTimeout(
          () => {
            world.announceTweet(w.author ?? 'someone', w.text);
            console.log(`[x] mention from ${w.author ?? '?'}: ${w.text.slice(0, 60)}`);
          },
          Math.round(i * gap + Math.random() * gap * 0.25),
        ),
      );
    });
  }
}

// ---- helpers ----------------------------------------------------------------

function cleanTweet(s: string): string {
  // the maze receives the WORDS, not the plumbing
  return (s ?? '').replace(/@\w+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

function trimForX(text: string): string {
  const max = config.X_MAX_POST_LEN;
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return stop > 60 ? cut.slice(0, stop + 1) : cut.slice(0, max - 1).trimEnd() + '…';
}

function pct(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** OAuth 1.0a HMAC-SHA1, user context. For a JSON body only the oauth params
 *  enter the signature base string. */
function oauthHeader(method: string, url: string): string {
  const p: Record<string, string> = {
    oauth_consumer_key: config.X_CONSUMER_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: config.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  const base = [
    method,
    pct(url),
    pct(Object.keys(p).sort().map((k) => `${pct(k)}=${pct(p[k]!)}`).join('&')),
  ].join('&');
  const key = `${pct(config.X_CONSUMER_SECRET)}&${pct(config.X_ACCESS_SECRET)}`;
  p.oauth_signature = crypto.createHmac('sha1', key).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.keys(p).sort().map((k) => `${pct(k)}="${pct(p[k]!)}"`).join(', ')
  );
}
