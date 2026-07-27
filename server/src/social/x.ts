import crypto from 'node:crypto';
import { config } from '../config.js';
import type { World } from '../sim/world.js';

/**
 * The world's connection to X (Twitter). Two directions:
 *   OUT — the maze's utterances (and anything we choose) get posted to our
 *         account so the outside world can read the archive live.
 *   IN  — we poll for mentions/replies to our account; each new one is fed into
 *         the world (agents "hear" it) and shown in the spectator LOG.
 *
 * All of this is gated by X_MODE. In 'mock' mode nothing touches the network:
 * incoming tweets come only from the admin panel, and posts just log. Flip
 * X_MODE=live once real keys are set and the exact same code paths go live.
 */

const API = 'https://api.twitter.com';

function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** OAuth 1.0a user-context Authorization header for posting as our account. */
function oauth1Header(method: string, url: string, bodyParams: Record<string, string> = {}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: config.X_APP_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: config.X_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  // NOTE: for the JSON /2/tweets endpoint the body is NOT form-encoded, so it is
  // excluded from the signature base (only query + oauth params are signed).
  const allParams: Record<string, string> = { ...oauth, ...bodyParams };
  const paramString = Object.keys(allParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(allParams[k]!)}`)
    .join('&');
  const base = [method.toUpperCase(), pctEncode(url), pctEncode(paramString)].join('&');
  const signingKey = `${pctEncode(config.X_APP_SECRET)}&${pctEncode(config.X_ACCESS_SECRET)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(base).digest('base64');
  oauth.oauth_signature = signature;
  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k]!)}"`)
      .join(', ')
  );
}

export class XClient {
  private sinceId: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;

  get live(): boolean {
    return config.X_MODE === 'live';
  }

  /** Post a tweet as our account. Returns the new tweet id (or null on failure/mock). */
  async postTweet(text: string): Promise<string | null> {
    const body = text.slice(0, 280);
    if (!this.live) {
      console.log(`[x:mock] would post: "${body}"`);
      return null;
    }
    if (!config.X_APP_KEY || !config.X_ACCESS_TOKEN) {
      console.warn('[x] live mode but OAuth1 keys missing — cannot post');
      return null;
    }
    try {
      const url = `${API}/2/tweets`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: oauth1Header('POST', url),
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: body }),
      });
      if (!res.ok) {
        console.warn(`[x] post failed ${res.status}: ${await res.text()}`);
        return null;
      }
      const json = (await res.json()) as { data?: { id?: string } };
      return json.data?.id ?? null;
    } catch (err) {
      console.warn('[x] post error:', err);
      return null;
    }
  }

  /** Begin polling mentions and (optionally) posting maze utterances. */
  start(world: World) {
    if (config.X_POST_MAZE_TWEETS) {
      world.bus.on((e) => {
        if (e.type === 'maze_tweet') {
          const text = String((e.payload as { text?: unknown }).text ?? '');
          if (text) void this.postTweet(text);
        }
      });
    }
    if (!this.live) {
      console.log('[x] mock mode — mentions come from the admin panel only');
      return;
    }
    if (!config.X_USER_ID || !config.X_BEARER_TOKEN) {
      console.warn('[x] live mode but X_USER_ID / X_BEARER_TOKEN missing — mentions polling disabled');
      return;
    }
    const tick = () => void this.pollMentions(world);
    this.timer = setInterval(tick, Math.max(15000, config.X_POLL_MS));
    tick();
    console.log(`[x] live — polling mentions of @${config.X_HANDLE} every ${config.X_POLL_MS}ms`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Pull tweets that mention us (includes replies to our posts) and feed them in. */
  private async pollMentions(world: World) {
    if (this.polling) return;
    this.polling = true;
    try {
      const params = new URLSearchParams({
        max_results: '20',
        expansions: 'author_id',
        'tweet.fields': 'created_at',
        'user.fields': 'username',
      });
      if (this.sinceId) params.set('since_id', this.sinceId);
      const url = `${API}/2/users/${config.X_USER_ID}/mentions?${params.toString()}`;
      const res = await fetch(url, {
        headers: { authorization: `Bearer ${config.X_BEARER_TOKEN}` },
      });
      if (!res.ok) {
        console.warn(`[x] mentions poll failed ${res.status}: ${await res.text()}`);
        return;
      }
      const json = (await res.json()) as {
        data?: { id: string; text: string; author_id: string }[];
        includes?: { users?: { id: string; username: string }[] };
        meta?: { newest_id?: string };
      };
      const users = new Map((json.includes?.users ?? []).map((u) => [u.id, u.username]));
      const tweets = json.data ?? [];
      // API returns newest-first; announce oldest-first so the LOG reads in order
      for (const t of [...tweets].reverse()) {
        const handle = users.get(t.author_id) ?? 'someone';
        if (handle.toLowerCase() === config.X_HANDLE.toLowerCase()) continue; // ignore ourselves
        world.announceTweet(handle, t.text);
      }
      if (json.meta?.newest_id) this.sinceId = json.meta.newest_id;
    } catch (err) {
      console.warn('[x] mentions poll error:', err);
    } finally {
      this.polling = false;
    }
  }
}
