// Tests for the bulk-export hardening helpers in chrome/utils.js.
//
// browse.js and content.js are classic scripts with top-level DOM access and no
// module.exports guard, so they cannot be imported here. The logic they depend
// on lives in utils.js and is tested directly; what remains untested is the glue
// that calls it, which is covered by review rather than by these tests.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import JSZip from '../chrome/jszip.min.js';

const {
  EXPORT_MANIFEST_BASENAME,
  EXPORT_MANIFEST_FILENAME,
  dedupeConversationNames,
  computeRetryDelay,
  createPacer,
  fetchWithBackoff,
  addZipFile,
  reconcileManifest,
  exportedUuids,
} = require('../chrome/utils.js');

const conv = (uuid, name) => ({ uuid, name });

describe('dedupeConversationNames', () => {
  it('leaves distinct names alone', () => {
    const names = dedupeConversationNames([conv('u1', 'Alpha'), conv('u2', 'Beta')]);
    expect(names.get('u1')).toBe('Alpha');
    expect(names.get('u2')).toBe('Beta');
  });

  it('suffixes duplicates in input order', () => {
    const names = dedupeConversationNames([
      conv('u1', 'Recipe'), conv('u2', 'Recipe'), conv('u3', 'Recipe'),
    ]);
    expect([names.get('u1'), names.get('u2'), names.get('u3')])
      .toEqual(['Recipe', 'Recipe_1', 'Recipe_2']);
  });

  it('does not let a real doc_1 be stolen by a deduplicated doc', () => {
    // 'doc' takes 'doc'; the genuine 'doc_1' takes 'doc_1'; the second 'doc'
    // must skip past the taken slot to 'doc_2'.
    const names = dedupeConversationNames([
      conv('u1', 'doc'), conv('u2', 'doc_1'), conv('u3', 'doc'),
    ]);
    expect(names.get('u1')).toBe('doc');
    expect(names.get('u2')).toBe('doc_1');
    expect(names.get('u3')).toBe('doc_2');
    expect(new Set(names.values()).size).toBe(3);
  });

  it('treats case variants as colliding', () => {
    // A ZIP holds both, but extracting on Windows or macOS loses one.
    const names = dedupeConversationNames([conv('u1', 'Recipe'), conv('u2', 'recipe')]);
    expect(names.get('u1')).toBe('Recipe');
    expect(names.get('u2')).toBe('recipe_1');
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('falls back to the UUID for a %s title', (_label, title) => {
    const names = dedupeConversationNames([conv('uuid-abc', title)]);
    expect(names.get('uuid-abc')).toBe('uuid-abc');
  });

  it('strips the <>:"/\\|?* character set', () => {
    const names = dedupeConversationNames([conv('u1', 'a/b:c*d?e"f<g>h|i')]);
    expect(names.get('u1')).toBe('a_b_c_d_e_f_g_h_i');
  });

  it('collides sanitized names that differ only in stripped characters', () => {
    const names = dedupeConversationNames([conv('u1', 'a/b'), conv('u2', 'a:b')]);
    expect(names.get('u1')).toBe('a_b');
    expect(names.get('u2')).toBe('a_b_1');
  });

  it('honours reserved names so the manifest cannot be claimed', () => {
    const names = dedupeConversationNames(
      [conv('u1', EXPORT_MANIFEST_BASENAME)], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1')).not.toBe(EXPORT_MANIFEST_BASENAME);
  });

  it('compares reserved names case-insensitively', () => {
    // A conversation titled "Export-Manifest" would otherwise keep that name
    // and collide with export-manifest.json when extracted.
    const names = dedupeConversationNames(
      [conv('u1', 'Export-Manifest')], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1').toLowerCase()).not.toBe(EXPORT_MANIFEST_BASENAME);
  });

  it('folds the case of caller-supplied reserved names too', () => {
    const names = dedupeConversationNames([conv('u1', 'export-manifest')], ['EXPORT-MANIFEST']);
    expect(names.get('u1')).not.toBe('export-manifest');
  });

  it('reserves the full manifest filename, not just its basename', () => {
    // In nested mode this title becomes a folder, which collides on disk with
    // the root export-manifest.json file.
    const names = dedupeConversationNames(
      [conv('u1', EXPORT_MANIFEST_FILENAME)], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1')).not.toBe(EXPORT_MANIFEST_FILENAME);
  });

  it('protects a real doc_1 regardless of input order', () => {
    // The favourable order is doc, doc_1, doc. In this adversarial order the
    // duplicate reaches doc_1 before its rightful owner does.
    const names = dedupeConversationNames([
      conv('u1', 'doc'), conv('u2', 'doc'), conv('u3', 'doc_1'),
    ]);
    expect(names.get('u3')).toBe('doc_1');
    expect(names.get('u2')).toBe('doc_2');
    expect(new Set(names.values()).size).toBe(3);
  });

  it('assigns exactly one unique name per conversation at scale', () => {
    // The invariant that actually matters for a 1,000-conversation export.
    const conversations = Array.from({ length: 1000 }, (_, i) =>
      conv(`u${i}`, ['same', 'SAME', '', null, `doc_${i % 7}`][i % 5]));
    const names = dedupeConversationNames(conversations);
    expect(names.size).toBe(conversations.length);
    const lowered = [...names.values()].map(n => n.toLowerCase());
    expect(new Set(lowered).size).toBe(conversations.length);
  });
});

describe('computeRetryDelay', () => {
  it('honours an integer Retry-After', () => {
    expect(computeRetryDelay(429, '5', 0)).toBe(5000);
  });

  it('honours Retry-After: 0', () => {
    expect(computeRetryDelay(429, '0', 0)).toBe(0);
  });

  it('falls back to exponential growth when Retry-After is absent', () => {
    expect(computeRetryDelay(429, null, 0)).toBe(1000);
    expect(computeRetryDelay(429, null, 1)).toBe(2000);
    expect(computeRetryDelay(429, null, 2)).toBe(4000);
  });

  it('falls back to exponential growth for an HTTP-date Retry-After', () => {
    // The date form is legal but not parsed; it must not become NaN or 0.
    expect(computeRetryDelay(429, 'Wed, 21 Oct 2026 07:28:00 GMT', 0)).toBe(1000);
  });

  it('does not treat an absent header as zero delay', () => {
    // Number(null) is 0, which would make the retry immediate.
    expect(computeRetryDelay(429, null, 0)).toBeGreaterThan(0);
    expect(computeRetryDelay(429, '', 0)).toBeGreaterThan(0);
  });

  it('caps a very large Retry-After', () => {
    expect(computeRetryDelay(429, '99999', 0)).toBe(60000);
  });

  it('reaches its largest exponential delay on the last permitted attempt', () => {
    // The attempt ceiling binds before the 60s cap does, so the exponential
    // fallback tops out here rather than at MAX_RETRY_DELAY_MS.
    expect(computeRetryDelay(429, null, 5)).toBe(32000);
  });

  it('never backs off on 403', () => {
    // A 403 from claude.ai is commonly a VPN artifact, not throttling.
    expect(computeRetryDelay(403, null, 0)).toBeNull();
    expect(computeRetryDelay(403, '5', 0)).toBeNull();
  });

  it('never backs off on other statuses', () => {
    for (const status of [200, 401, 404, 500, 503]) {
      expect(computeRetryDelay(status, '5', 0)).toBeNull();
    }
  });

  it('gives up once the attempt ceiling is reached', () => {
    expect(computeRetryDelay(429, '5', 5)).not.toBeNull();
    expect(computeRetryDelay(429, '5', 6)).toBeNull();
    expect(computeRetryDelay(429, '5', 99)).toBeNull();
  });
});

describe('fetchWithBackoff', () => {
  const response = (status, retryAfter = null) => ({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'retry-after' ? retryAfter : null) },
  });

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // Runs a fetchWithBackoff call to completion under fake timers.
  const run = async (promise) => {
    const settled = promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };

  it('returns a successful response without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(200);
  });

  it('keeps retrying repeated 429s instead of giving up after one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValue(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(result.status).toBe(200);
  });

  it('stops at the attempt ceiling and hands back the 429', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429, '1'));
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(fetchWithBackoff('u', {}, createPacer(200)));

    // 6 retries plus the initial attempt.
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(result.status).toBe(429);
    expect(result.ok).toBe(false);
  });

  it('keeps the slowdown after the 429 clears', async () => {
    const pacer = createPacer(200);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValue(response(200));
    vi.stubGlobal('fetch', fetchMock);

    await run(fetchWithBackoff('u', {}, pacer));

    // The interval the 429 forced must outlive the request that hit it, or the
    // loop walks straight back into the limiter on the next conversation.
    expect(pacer.intervalMs).toBeGreaterThan(200);
  });

  it('widens the interval further on each additional 429', async () => {
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValue(response(200)));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.intervalMs).toBe(800);
  });

  it('does not retry a 403', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(403));
    vi.stubGlobal('fetch', fetchMock);

    const result = await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.status).toBe(403);
  });

  it('leaves the interval untouched when a 403 comes back', async () => {
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(403)));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.intervalMs).toBe(200);
  });

  it('waits for the pacer before sending', async () => {
    const pacer = createPacer(200);
    pacer.notBefore = Date.now() + 5000;
    let sentAt = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      sentAt = Date.now();
      return Promise.resolve(response(200));
    }));

    const startedAt = Date.now();
    await run(fetchWithBackoff('u', {}, pacer));

    expect(sentAt - startedAt).toBeGreaterThanOrEqual(5000);
  });

  it('paces the next request from the last one by exactly the interval', async () => {
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200)));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.notBefore).toBe(Date.now() + 200);
  });

  // Records the faked wall-clock time of each request, so the tests below can
  // assert that a computed delay is actually WAITED rather than merely returned.
  const recordingFetch = (...responses) => {
    const sentAt = [];
    const queue = [...responses];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      sentAt.push(Date.now());
      return Promise.resolve(queue.length > 1 ? queue.shift() : queue[0]);
    }));
    return sentAt;
  };

  it('actually waits the Retry-After it was given', async () => {
    const sentAt = recordingFetch(response(429, '10'), response(200));

    await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(sentAt).toHaveLength(2);
    expect(sentAt[1] - sentAt[0]).toBe(10000);
  });

  it('reads the delay from the Retry-After header, not from the fallback', async () => {
    // Guards the header wiring: without it this gap would be the 1000ms
    // exponential fallback.
    const sentAt = recordingFetch(response(429, '7'), response(200));

    await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(sentAt[1] - sentAt[0]).toBe(7000);
  });

  it('waits the exponential fallback when no Retry-After is present', async () => {
    const sentAt = recordingFetch(response(429), response(200));

    await run(fetchWithBackoff('u', {}, createPacer(200)));

    expect(sentAt[1] - sentAt[0]).toBe(1000);
  });

  it('does not send immediately when Retry-After is 0', async () => {
    // Retry-After: 0 must not undo the interval the 429 just widened.
    const pacer = createPacer(200);
    const sentAt = recordingFetch(response(429, '0'), response(200));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(sentAt[1] - sentAt[0]).toBe(400);
  });

  it('caps how far the interval can widen', async () => {
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(429, '0')));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.intervalMs).toBe(5000);
  });

  it('carries the slowdown into the next conversation', async () => {
    // The requirement is that the widened interval survives the request that
    // hit the limit, so the NEXT conversation is paced too.
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(429, '1'))
      .mockResolvedValue(response(200)));
    await run(fetchWithBackoff('first', {}, pacer));

    const sentAt = recordingFetch(response(200));
    const startedAt = Date.now();
    await run(fetchWithBackoff('second', {}, pacer));

    expect(sentAt[0] - startedAt).toBe(400);
  });

  it('still paces after fetch rejects', async () => {
    // A run that loses connectivity must not sprint through every remaining
    // conversation as fast as fetch can reject.
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    await expect(run(fetchWithBackoff('u', {}, pacer))).rejects.toThrow('Failed to fetch');

    expect(pacer.notBefore).toBe(Date.now() + 200);
  });
});

describe('addZipFile', () => {
  it('writes a file that is not already present', async () => {
    const zip = new JSZip();
    addZipFile(zip, 'a.md', 'hello');
    expect(await zip.file('a.md').async('string')).toBe('hello');
  });

  it('throws rather than letting JSZip replace an entry', () => {
    // JSZip keys by name, so the second write would win silently and the first
    // conversation would vanish from the archive with no error anywhere.
    const zip = new JSZip();
    addZipFile(zip, 'a.md', 'first');
    expect(() => addZipFile(zip, 'a.md', 'second')).toThrow(/Duplicate ZIP entry/);
  });

  it('leaves the original content intact after a refused write', async () => {
    const zip = new JSZip();
    addZipFile(zip, 'a.md', 'first');
    expect(() => addZipFile(zip, 'a.md', 'second')).toThrow();
    expect(await zip.file('a.md').async('string')).toBe('first');
  });

  it('detects a duplicate nested path', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Chats/a.md', 'first');
    expect(() => addZipFile(zip, 'Chats/a.md', 'second')).toThrow(/Duplicate ZIP entry/);
  });

  it('does not confuse distinct paths that share a basename', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Chats/a.md', 'one');
    expect(() => addZipFile(zip, 'Artifacts/a.md', 'two')).not.toThrow();
  });

  it('refuses a duplicate that differs only in case', () => {
    // JSZip compares case-sensitively; Windows and macOS filesystems do not, so
    // without this both entries are written and one is lost on extraction.
    const zip = new JSZip();
    addZipFile(zip, 'Main.py', 'first');
    expect(() => addZipFile(zip, 'main.py', 'second')).toThrow(/Duplicate ZIP entry/);
  });

  it('refuses a case-variant duplicate on a nested path', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Chats/Recipe.md', 'first');
    expect(() => addZipFile(zip, 'chats/recipe.md', 'second')).toThrow(/Duplicate ZIP entry/);
  });

  it('flags the error so callers need not parse its message', () => {
    const zip = new JSZip();
    addZipFile(zip, 'a.md', 'first');
    try {
      addZipFile(zip, 'a.md', 'second');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.duplicateZipEntry).toBe(true);
    }
  });

  it('keeps its written-path index per ZIP, not globally', () => {
    const first = new JSZip();
    const second = new JSZip();
    addZipFile(first, 'a.md', 'x');
    expect(() => addZipFile(second, 'a.md', 'y')).not.toThrow();
  });

  it('does not treat a name with regex metacharacters as a pattern', () => {
    const zip = new JSZip();
    addZipFile(zip, 'A+B (v2) [draft].md', 'one');
    expect(() => addZipFile(zip, 'AxB (v2) xdraftx.md', 'two')).not.toThrow();
  });
});

describe('reconcileManifest', () => {
  const entry = (over) => ({ uuid: 'u1', title: 'T', status: 'exported', files: [], ...over });

  it('passes when every claimed file is present', () => {
    const zip = new JSZip();
    zip.file('a.md', 'x');
    const result = reconcileManifest([entry({ files: ['a.md'] })], zip);
    expect(result).toEqual({ ok: true, missing: [] });
  });

  it('fires when a claimed file is absent from the archive', () => {
    // The safety net's whole point: deliberately break what it guards.
    const zip = new JSZip();
    const result = reconcileManifest([entry({ files: ['a.md'] })], zip);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(1);
    expect(result.missing[0].uuid).toBe('u1');
  });

  it('cannot detect an overwrite on its own — addZipFile is that defence', () => {
    // Documents a real blind spot rather than covering it: if two entries claim
    // the same path, the archive genuinely holds that path, so reconciliation
    // passes. Only addZipFile can catch this, at the moment of the second write.
    const zip = new JSZip();
    zip.file('Recipe.md', 'second wins');
    const entries = [
      entry({ uuid: 'u1', files: ['Recipe.md'] }),
      entry({ uuid: 'u2', files: ['Recipe.md'] }),
    ];
    expect(reconcileManifest(entries, zip).ok).toBe(true);
  });

  it('fires when an entry claims success but recorded no files', () => {
    const result = reconcileManifest([entry({ files: [] })], new JSZip());
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toMatch(/wrote no files/);
  });

  it('reports only the absent paths of a partially written entry', () => {
    const zip = new JSZip();
    zip.file('a.md', 'x');
    const result = reconcileManifest([entry({ files: ['a.md', 'b.py'] })], zip);
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toContain('b.py');
    expect(result.missing[0].reason).not.toContain('a.md');
  });

  it('ignores skipped and failed entries', () => {
    const entries = [
      entry({ uuid: 'u1', status: 'skipped', files: [] }),
      entry({ uuid: 'u2', status: 'failed', files: [] }),
    ];
    expect(reconcileManifest(entries, new JSZip()).ok).toBe(true);
  });

  it('does not accept a folder entry as the claimed file', () => {
    // Claims the folder's own key, so a presence check reading zip.files
    // directly would wrongly pass; zip.file() correctly returns null for it.
    const zip = new JSZip();
    zip.folder('Chats');
    expect(reconcileManifest([entry({ files: ['Chats/'] })], zip).ok).toBe(false);
    expect(reconcileManifest([entry({ files: ['Chats/a.md'] })], zip).ok).toBe(false);
  });

  it('ignores cancelled entries', () => {
    const entries = [entry({ status: 'cancelled', files: [] })];
    expect(reconcileManifest(entries, new JSZip()).ok).toBe(true);
  });
});

describe('exportedUuids', () => {
  const clean = { ok: true, missing: [] };

  it('returns exported entries', () => {
    const entries = [{ uuid: 'u1', status: 'exported', files: ['a.md'] }];
    expect(exportedUuids(entries, clean)).toEqual(['u1']);
  });

  it('does not record a NAMED conversation that failed as exported', () => {
    // The confirmed data-loss bug: failures were stored as
    // `${conv.name || conv.uuid}: ${message}` and then matched by asking
    // whether any error string contained the UUID. For a named conversation it
    // never does, so the failure was written down as a success and the "New /
    // Updated" filter hid it on the next run.
    const entries = [
      { uuid: 'uuid-1', title: 'My Chat', status: 'failed', reason: 'HTTP 500', files: [] },
      { uuid: 'uuid-2', title: 'Other', status: 'exported', files: ['Other.md'] },
    ];
    expect(exportedUuids(entries, clean)).toEqual(['uuid-2']);
    expect(exportedUuids(entries, clean)).not.toContain('uuid-1');
  });

  it('does not record an unnamed conversation that failed as exported', () => {
    const entries = [{ uuid: 'uuid-1', title: null, status: 'failed', reason: 'HTTP 500', files: [] }];
    expect(exportedUuids(entries, clean)).toEqual([]);
  });

  it('does not record a skipped conversation as exported', () => {
    const entries = [{ uuid: 'u1', status: 'skipped', files: [] }];
    expect(exportedUuids(entries, clean)).toEqual([]);
  });

  it('does not record a conversation that failed reconciliation', () => {
    const entries = [
      { uuid: 'u1', status: 'exported', files: ['a.md'] },
      { uuid: 'u2', status: 'exported', files: ['b.md'] },
    ];
    const reconciliation = { ok: false, missing: [{ uuid: 'u2', reason: 'missing' }] };
    expect(exportedUuids(entries, reconciliation)).toEqual(['u1']);
  });

  it('distinguishes the three terminal statuses from each other', () => {
    const entries = [
      { uuid: 'e', status: 'exported', files: ['e.md'] },
      { uuid: 's', status: 'skipped', files: [] },
      { uuid: 'f', status: 'failed', files: [] },
    ];
    expect(exportedUuids(entries, clean)).toEqual(['e']);
  });
});

describe('helpers composed as the export loops use them', () => {
  // Not a test of browse.js or content.js — those are not importable. This
  // checks that the pieces fit together to preserve two same-titled
  // conversations, which is the failure that motivated the work.
  it('keeps two conversations that share a title', async () => {
    const conversations = [conv('u1', 'Recipe'), conv('u2', 'Recipe')];
    const safeNames = dedupeConversationNames(conversations, [
      EXPORT_MANIFEST_FILENAME.replace(/\.json$/, ''),
    ]);
    const entries = conversations.map(c => ({
      uuid: c.uuid, title: c.name, status: 'pending', files: [],
    }));
    const zip = new JSZip();

    entries.forEach((entry, i) => {
      const path = `${safeNames.get(entry.uuid)}.md`;
      addZipFile(zip, path, `body ${i}`);
      entry.files.push(path);
      entry.status = 'exported';
    });

    const reconciliation = reconcileManifest(entries, zip);
    expect(reconciliation.ok).toBe(true);
    expect(exportedUuids(entries, reconciliation)).toEqual(['u1', 'u2']);

    // Both bodies survive, distinctly.
    expect(await zip.file('Recipe.md').async('string')).toBe('body 0');
    expect(await zip.file('Recipe_1.md').async('string')).toBe('body 1');

    // The manifest records the name actually written, not the original title.
    expect(entries.map(e => e.files)).toEqual([['Recipe.md'], ['Recipe_1.md']]);
  });

  it('catches the flat-mode artifact path ambiguity the dedup cannot remove', () => {
    // Unique conversation names are not enough: conversation "A" with artifact
    // "B_c.md" and conversation "A_B" with artifact "c.md" both resolve to
    // Artifacts/A_B_c.md. addZipFile is what stops one silently replacing the
    // other; the loser is recorded failed and left flagged as new.
    const zip = new JSZip();
    addZipFile(zip, 'Artifacts/A_B_c.md', 'from A');
    let thrown = null;
    try {
      addZipFile(zip, 'Artifacts/A_B_c.md', 'from A_B');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).not.toBeNull();
    expect(thrown.duplicateZipEntry).toBe(true);
  });

  it('reserves the manifest filename against a conversation of that name', () => {
    const reserved = EXPORT_MANIFEST_FILENAME.replace(/\.json$/, '');
    const conversations = [conv('u1', reserved)];
    const safeNames = dedupeConversationNames(conversations, [reserved]);
    const zip = new JSZip();

    addZipFile(zip, `${safeNames.get('u1')}.json`, 'conversation body');
    // The manifest write must not collide with it.
    expect(() => addZipFile(zip, EXPORT_MANIFEST_FILENAME, '{}')).not.toThrow();
  });
});
