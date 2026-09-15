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
  toZipBytes,
  collectArtifactMeta,
  artifactFromToolInput,
  uniqueZipPath,
  extractArtifactFiles,
  filenameKey,
  safeConversationName,
  assertConversationShape,
  getCurrentBranch,
  getFileExtension,
  isProgrammingLanguage,
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

  it.each(['.', '..', '...'])('falls back to the UUID for the path-segment name %s', (title) => {
    // As a nested-export folder these produce "./x" or "../x", which collide
    // with a root entry or escape the extraction directory once normalized.
    const names = dedupeConversationNames([conv('uuid-abc', title)]);
    expect(names.get('uuid-abc')).toBe('uuid-abc');
  });

  it('protects a real Doc_1 whose case differs from the duplicate', () => {
    // The lowercase-only variant of this test passes even if the literals pass
    // forgets to case-fold, so it never exercised that folding.
    const names = dedupeConversationNames([
      conv('u1', 'doc'), conv('u2', 'doc'), conv('u3', 'Doc_1'),
    ]);
    expect(names.get('u3')).toBe('Doc_1');
    expect(names.get('u2')).toBe('doc_2');
  });

  it('protects a real doc_1 when the case variance is on the duplicate side', () => {
    const names = dedupeConversationNames([
      conv('u1', 'Doc'), conv('u2', 'Doc'), conv('u3', 'doc_1'),
    ]);
    expect(names.get('u3')).toBe('doc_1');
    expect(names.get('u2')).toBe('Doc_2');
  });

  it('protects an owner whose title only matches after sanitizing', () => {
    // The literals pass must use the sanitized name, or the two passes are
    // working in different namespaces.
    const names = dedupeConversationNames([
      conv('u1', 'doc'), conv('u2', 'doc'), conv('u3', 'doc/1'),
    ]);
    expect(names.get('u3')).toBe('doc_1');
    expect(names.get('u2')).toBe('doc_2');
  });

  it('protects an owner whose name comes from the UUID fallback', () => {
    const names = dedupeConversationNames([
      conv('u1', 'doc'), conv('u2', 'doc'), conv('doc_1', null),
    ]);
    expect(names.get('doc_1')).toBe('doc_1');
    expect(names.get('u2')).toBe('doc_2');
  });

  it('renames rather than failing when folding merges two distinct names', () => {
    // Upper-casing merges the fi ligature with "fi". Over-merging is safe
    // precisely because the dedup renames; nothing is refused later.
    const ligature = String.fromCharCode(0xfb01);
    const names = dedupeConversationNames([conv('u1', ligature + 'le'), conv('u2', 'file')]);
    expect(names.get('u1')).not.toBe(names.get('u2'));
    const zip = new JSZip();
    addZipFile(zip, `${names.get('u1')}.md`, 'a');
    expect(() => addZipFile(zip, `${names.get('u2')}.md`, 'b')).not.toThrow();
  });

  it('is not defeated by Final_Sigma when an extension is appended', () => {
    // toLowerCase keys a trailing sigma differently from the same sigma
    // followed by ".md", so the dedup (bare name) and the ZIP guard (full path)
    // disagreed and the loser failed on every run forever.
    const capitalSigma = String.fromCharCode(0x3a3);
    const smallSigma = String.fromCharCode(0x3c3);
    const stem = 'O' + String.fromCharCode(0x394) + 'O';
    const names = dedupeConversationNames([
      conv('u1', stem + capitalSigma), conv('u2', stem + smallSigma),
    ]);
    const zip = new JSZip();
    addZipFile(zip, `${names.get('u1')}.md`, 'a');
    expect(() => addZipFile(zip, `${names.get('u2')}.md`, 'b')).not.toThrow();
  });

  it.each([
    ['capital I with dot', String.fromCharCode(0x130), 'i' + String.fromCharCode(0x307)],
    ['iota with dialytika tonos', String.fromCharCode(0x390),
      String.fromCharCode(0x399, 0x308, 0x301)],
    ['upsilon with dialytika tonos', String.fromCharCode(0x3b0),
      String.fromCharCode(0x3a5, 0x308, 0x301)],
    ['sharp s', String.fromCharCode(0xdf), String.fromCharCode(0x1e9e)],
    ['theta', String.fromCharCode(0x398), String.fromCharCode(0x3f4)],
    ['theta symbol', String.fromCharCode(0x3b8), String.fromCharCode(0x3d1)],
    ['long s', 's', String.fromCharCode(0x17f)],
    ['micro sign', String.fromCharCode(0xb5), String.fromCharCode(0x3bc)],
    ['final sigma', String.fromCharCode(0x3c3), String.fromCharCode(0x3c2)],
    ['beta symbol', String.fromCharCode(0x3b2), String.fromCharCode(0x3d0)],
    ['st ligature', String.fromCharCode(0xfb05), String.fromCharCode(0xfb06)],
  ])('folds %s variants together, as the filesystem does', (_label, a, b) => {
    // Asserting only that the two names differ would be vacuous: the dedup
    // always produces distinct names. The property is that these two are
    // treated as the SAME name, so one of them gets renamed.
    expect(filenameKey(a)).toBe(filenameKey(b));
    const names = dedupeConversationNames([conv('u1', a), conv('u2', b)]);
    expect(names.get('u2')).toMatch(/_1$/);
  });

  it('caps a name so one long title cannot abort the whole extraction', () => {
    const names = dedupeConversationNames([conv('u1', 'x'.repeat(400))]);
    expect([...names.get('u1')].length).toBeLessThanOrEqual(100);
  });

  it('does not split a surrogate pair when capping', () => {
    // The cut must land MID-pair to test anything: one leading ASCII character
    // makes code-point 100 fall inside an astral character. Asserting
    // `capped === [...capped].join('')` would be a tautology, so check for an
    // unpaired surrogate directly.
    const names = dedupeConversationNames([conv('u1', 'a' + String.fromCodePoint(0x1f600).repeat(200))]);
    const capped = names.get('u1');
    const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(loneSurrogate.test(capped)).toBe(false);
    expect(capped.length).toBeLessThanOrEqual(100);
  });

  it('caps by UTF-8 bytes, the stricter of the two filesystem rules', () => {
    // An astral character is 4 bytes and 2 UTF-16 units; a CJK character is
    // 3 bytes and 1 unit. Counting units let a CJK title reach 300 bytes
    // against ext4's 255-byte component limit.
    const bytes = (s) => new TextEncoder().encode(s).length;

    const astral = dedupeConversationNames([conv('u1', String.fromCodePoint(0x1f600).repeat(200))]).get('u1');
    expect(bytes(astral)).toBeLessThanOrEqual(100);
    expect([...astral].length).toBe(25);

    const cjk = dedupeConversationNames([conv('u1', '\u4e2d'.repeat(200))]).get('u1');
    expect(bytes(cjk)).toBeLessThanOrEqual(100);
    expect([...cjk].length).toBe(33);

    // 2 bytes, 1 unit — accented Latin, Greek, Cyrillic, Hebrew, Arabic.
    const latin1 = dedupeConversationNames([conv('u1', '\u00e9'.repeat(200))]).get('u1');
    expect(bytes(latin1)).toBeLessThanOrEqual(100);
    expect([...latin1].length).toBe(50);
  });

  it('keeps a CJK flat-mode composite inside ext4\'s byte limit', () => {
    const bytes = (s) => new TextEncoder().encode(s).length;
    const name = dedupeConversationNames([conv('u1', '\u4e2d'.repeat(200))]).get('u1');
    const artifact = dedupeConversationNames([conv('u2', '\u4e2d'.repeat(200))]).get('u2');
    expect(bytes(`Artifacts/${name}_2725_${artifact}_99.dockerfile`)).toBeLessThan(255);
  });

  it('keeps an astral flat-mode composite inside the filesystem limit', () => {
    const astral = String.fromCodePoint(0x1f600).repeat(200);
    const name = dedupeConversationNames([conv('u1', astral)]).get('u1');
    const artifact = `${'x'.repeat(100)}.dockerfile`;
    const composite = `Artifacts/${name}_2725_${artifact}`;
    expect(composite.length).toBeLessThan(255);                              // APFS / NTFS
    expect(new TextEncoder().encode(composite).length).toBeLessThan(255);     // ext4
  });

  it('caps to exactly the limit, pinning the lower bound too', () => {
    const names = dedupeConversationNames([conv('u1', 'x'.repeat(400))]);
    expect([...names.get('u1')].length).toBe(100);
  });

  it('leaves a name of exactly the limit untouched', () => {
    const exact = 'y'.repeat(100);
    expect(dedupeConversationNames([conv('u1', exact)]).get('u1')).toBe(exact);
  });

  it('replaces unassigned code points and noncharacters', () => {
    // APFS rejects these outright, so the entry sits in the archive but no file
    // is ever written and nothing downstream notices.
    for (const codePoint of [0x378, 0xfdd0, 0xfffe]) {
      const title = 'Plan ' + String.fromCodePoint(codePoint) + ' review';
      expect(dedupeConversationNames([conv('u1', title)]).get('u1')).toBe('Plan _ review');
    }
  });

  it('separates titles differing only in an unpaired surrogate', async () => {
    // JSZip encodes entry names as UTF-8 and maps every surrogate to U+FFFD,
    // so these produced byte-identical archive entries while remaining
    // distinct JS strings — invisible to the dedup, the guard and
    // reconciliation alike.
    const titles = [0xd83d, 0xd83c, 0xdc00].map(c => 'Report ' + String.fromCharCode(c) + ' end');
    const names = dedupeConversationNames(titles.map((name, i) => conv(`u${i}`, name)));
    const zip = new JSZip();
    for (const name of names.values()) addZipFile(zip, `${name}.md`, 'x');

    // Generated and reloaded on purpose: the collapse happens when JSZip
    // encodes names as UTF-8, not when it stores the JS-string key, so counting
    // zip.files would check the wrong thing.
    const reloaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(Object.keys(reloaded.files)).toHaveLength(3);
  });

  it('keeps artifact filenames free of unsafe code points too', () => {
    const names = namesForArtifacts('we' + String.fromCharCode(0xd83d) + 'ird.py',
                                    'we' + String.fromCharCode(0xdc00) + 'ird.py');
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(/[\p{Cn}\p{Cs}]/u.test(name)).toBe(false);
    }
  });

  it('replaces every unsafe code point, not just the first', async () => {
    // With the regex's /g flag dropped, only the leading surrogate is replaced
    // and the trailing ones still collapse to one archive entry.
    const title = (tail) => 'R' + String.fromCharCode(0xd83d) + 'x' + String.fromCharCode(tail) + 'y';
    const names = dedupeConversationNames([
      conv('u1', title(0xd83d)), conv('u2', title(0xdc00)),
    ]);
    const zip = new JSZip();
    for (const name of names.values()) addZipFile(zip, `${name}.md`, 'x');
    const reloaded = await JSZip.loadAsync(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(Object.keys(reloaded.files)).toHaveLength(2);
  });

  it('keeps valid astral characters', () => {
    const emoji = String.fromCodePoint(0x1f600);
    expect(dedupeConversationNames([conv('u1', `a${emoji}b`)]).get('u1')).toBe(`a${emoji}b`);
  });

  it('strips DEL as well as the C0 controls', () => {
    const title = 'a' + String.fromCharCode(0x7f) + 'b';
    expect(dedupeConversationNames([conv('u1', title)]).get('u1')).toBe('a_b');
  });

  it('trims surrounding whitespace, so a padded title collides with the bare one', () => {
    const names = dedupeConversationNames([conv('u1', '  Report  '), conv('u2', 'Report')]);
    expect(names.get('u1')).toBe('Report');
    expect(names.get('u2')).toBe('Report_1');
  });

  it('still separates two over-long titles that share a prefix', () => {
    const names = dedupeConversationNames([
      conv('u1', 'y'.repeat(300) + 'A'), conv('u2', 'y'.repeat(300) + 'B'),
    ]);
    expect(names.get('u1')).not.toBe(names.get('u2'));
  });

  it('treats NFC and NFD spellings of a title as colliding', () => {
    // macOS normalizes filenames, so these are one file after extraction.
    const combiningAcute = String.fromCharCode(0x301);
    const base = 'Cafe' + combiningAcute + ' notes';
    const names = dedupeConversationNames([
      conv('u1', base.normalize('NFC')), conv('u2', base.normalize('NFD')),
    ]);
    expect(names.get('u1')).not.toBe(names.get('u2'));
  });

  it('strips control characters, which are not in the invalid-character class', () => {
    const title = 'bad' + String.fromCharCode(7) + 'title' + String.fromCharCode(10) + 'here';
    expect(dedupeConversationNames([conv('u1', title)]).get('u1')).toBe('bad_title_here');
  });

  it('keeps dots that are not at the end of the name', () => {
    const names = dedupeConversationNames([conv('u1', 'notes.v2'), conv('u2', '.hidden')]);
    expect(names.get('u1')).toBe('notes.v2');
    expect(names.get('u2')).toBe('.hidden');
  });

  it('strips trailing dots and spaces, which Windows drops on extraction', () => {
    const names = dedupeConversationNames([conv('u1', 'Report.'), conv('u2', 'Report')]);
    expect(names.get('u1')).toBe('Report');
    expect(names.get('u2')).toBe('Report_1');
  });

  it('falls back to the UUID when stripping leaves nothing', () => {
    const names = dedupeConversationNames([conv('uuid-abc', '.. .')]);
    expect(names.get('uuid-abc')).toBe('uuid-abc');
  });

  it('keeps a leading-dot name that still has content', () => {
    const names = dedupeConversationNames([conv('u1', '._..')]);
    expect(names.get('u1')).toBe('._');
  });

  it('does not leave a trailing dot behind after capping', () => {
    const names = dedupeConversationNames([conv('u1', 'B'.repeat(99) + '. tail')]);
    expect(names.get('u1')).not.toMatch(/[. ]$/);
  });

  it('strips the <>:"/\\|?* character set, backslash included', () => {
    const names = dedupeConversationNames([conv('u1', 'a/b:c*d?e"f<g>h|i\\j')]);
    expect(names.get('u1')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('strips a Windows path, which 7-Zip would otherwise treat as folders', () => {
    expect(safeConversationName('C:\\Users\\report', 'u')).toBe('C__Users_report');
  });

  it('collides sanitized names that differ only in stripped characters', () => {
    const names = dedupeConversationNames([conv('u1', 'a/b'), conv('u2', 'a:b')]);
    expect(names.get('u1')).toBe('a_b');
    expect(names.get('u2')).toBe('a_b_1');
  });

  it('honours reserved names so the manifest cannot be claimed', () => {
    const names = dedupeConversationNames(
      [conv('u1', EXPORT_MANIFEST_BASENAME)], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1')).toBe(`${EXPORT_MANIFEST_BASENAME}_1`);
  });

  it('compares reserved names case-insensitively', () => {
    // A conversation titled "Export-Manifest" would otherwise keep that name
    // and collide with export-manifest.json when extracted.
    const names = dedupeConversationNames(
      [conv('u1', 'Export-Manifest')], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1')).toBe('Export-Manifest_1');
  });

  it('folds the case of caller-supplied reserved names too', () => {
    const names = dedupeConversationNames([conv('u1', 'export-manifest')], ['EXPORT-MANIFEST']);
    expect(names.get('u1')).toBe('export-manifest_1');
  });

  it('reserves the full manifest filename, not just its basename', () => {
    // In nested mode this title becomes a folder, which collides on disk with
    // the root export-manifest.json file.
    const names = dedupeConversationNames(
      [conv('u1', EXPORT_MANIFEST_FILENAME)], [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    expect(names.get('u1')).toBe(`${EXPORT_MANIFEST_FILENAME}_1`);
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
    // names.size is tautological (the Map is keyed by distinct UUIDs); the
    // content is that no two assigned names collide on a folding filesystem.
    const keys = [...names.values()].map(filenameKey);
    expect(new Set(keys).size).toBe(conversations.length);
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
    expect(computeRetryDelay(429, null, 0)).toBe(1000);
    expect(computeRetryDelay(429, '', 0)).toBe(1000);
  });

  it('rejects a header with trailing junk rather than producing NaN', () => {
    // /^\d+/ instead of /^\d+$/ would match "5 seconds", and Number("5 seconds")
    // is NaN, which collapses the wait to nothing.
    expect(computeRetryDelay(429, '5 seconds', 0)).toBe(1000);
  });

  it('tolerates a padded header', () => {
    expect(computeRetryDelay(429, ' 5 ', 0)).toBe(5000);
  });

  it('ignores a non-string header rather than coercing it', () => {
    expect(computeRetryDelay(429, 5, 0)).toBe(1000);
    expect(computeRetryDelay(429, { toString: () => '30' }, 0)).toBe(1000);
  });

  it('rejects a negative header', () => {
    expect(computeRetryDelay(429, '-5', 0)).toBe(1000);
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

  it('still honours the final Retry-After after exhausting its retries', async () => {
    // Giving up on this conversation must not discard the server's cooldown for
    // the next one — that is precisely how a run walks back into the limiter.
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(429, '60')));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.notBefore - Date.now()).toBe(60000);
  });

  it('falls back to the interval when the exhausted response has no Retry-After', async () => {
    const pacer = createPacer(200);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(429)));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(pacer.notBefore - Date.now()).toBe(5000);
  });

  it('aborts a long backoff wait instead of sleeping it out', async () => {
    // The whole point: a 60s Retry-After must not keep a cancelled export
    // waiting minutes before it can package what it already has.
    const pacer = createPacer(200);
    let cancelled = false;
    const fetchMock = vi.fn().mockResolvedValue(response(429, '60'));
    vi.stubGlobal('fetch', fetchMock);

    const started = Date.now();
    const promise = fetchWithBackoff('u', {}, pacer, () => cancelled).then(
      () => ({ ok: true }), (error) => ({ error }));
    await vi.advanceTimersByTimeAsync(1000);
    cancelled = true;
    await vi.runAllTimersAsync();
    const outcome = await promise;

    expect(outcome.error?.exportCancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not start another attempt once cancelled', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(429, '0'));
    vi.stubGlobal('fetch', fetchMock);

    const outcome = await run(fetchWithBackoff('u', {}, createPacer(200), () => true)
      .then(() => ({ ok: true }), (error) => ({ error })));

    expect(outcome.error?.exportCancelled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not spin forever when the pacer deadline is NaN', async () => {
    // `NaN <= 0` is false, so a naive comparison never breaks out and
    // setTimeout(fn, NaN) fires immediately — a hot loop that never fetches.
    const fetchMock = vi.fn().mockResolvedValue(response(200));
    vi.stubGlobal('fetch', fetchMock);

    const res = await run(fetchWithBackoff('u', {}, { intervalMs: 200, notBefore: NaN }));

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns a 5xx immediately without entering the retry path', async () => {
    // Pins fetchWithBackoff's own status routing, not just computeRetryDelay:
    // a widened comparison would let a 500 into the retry block.
    const pacer = createPacer(200);
    const fetchMock = vi.fn().mockResolvedValue(response(503, '60'));
    vi.stubGlobal('fetch', fetchMock);

    const res = await run(fetchWithBackoff('u', {}, pacer));

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pacer.notBefore).toBe(Date.now() + 200);
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

  it('backs off even when the pacer started at zero', async () => {
    // A one-shot fetch has nothing to pace against, so its pacer starts at 0 —
    // but doubling zero is zero, so a server answering Retry-After: 0 used to
    // get all seven attempts back-to-back with no delay at all.
    const pacer = createPacer(0);
    const sentAt = recordingFetch(response(429, '0'), response(429, '0'), response(200));

    await run(fetchWithBackoff('u', {}, pacer));

    expect(sentAt[1] - sentAt[0]).toBeGreaterThanOrEqual(1000);
    expect(pacer.intervalMs).toBeGreaterThan(0);
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

describe('filenameKey', () => {
  const acute = String.fromCharCode(0x301);

  it('folds case', () => {
    expect(filenameKey('Recipe.md')).toBe(filenameKey('recipe.MD'));
  });

  it('folds canonical normalization', () => {
    expect(filenameKey(('Cafe' + acute).normalize('NFC'))).toBe(filenameKey(('Cafe' + acute).normalize('NFD')));
  });

  it('is compositional: appending an extension cannot change whether two names agree', () => {
    // The property toLowerCase lacks, via Final_Sigma.
    const a = 'O' + String.fromCharCode(0x394) + 'O' + String.fromCharCode(0x3a3);
    const b = 'O' + String.fromCharCode(0x394) + 'O' + String.fromCharCode(0x3c3);
    expect(filenameKey(a) === filenameKey(b)).toBe(filenameKey(a + '.md') === filenameKey(b + '.md'));
  });

  it('produces a concrete, composed key', () => {
    // The relational tests fix only the equivalence, so NFD would satisfy them
    // all. Pin one actual value.
    expect(filenameKey(('cafe' + acute).normalize('NFD'))).toBe('CAF\u00C9');
  });

  it('is idempotent', () => {
    for (const name of ['Recipe.md', 'Ca' + acute + 'fe', 'ΟΔΟΣ.md', 'a_1.py']) {
      expect(filenameKey(filenameKey(name))).toBe(filenameKey(name));
    }
  });

  it('does not merge compatibility equivalents that are distinct files', () => {
    // NFKC would fold these together; NFC must not.
    expect(filenameKey('\uFF41.md')).not.toBe(filenameKey('a.md'));
  });

  it('is the equivalence every consumer uses', () => {
    // If a consumer disagreed with this, a rename in one namespace could
    // collide in another — which is how the Main.py/main.py failure happened.
    const zip = new JSZip();
    addZipFile(zip, 'Note.md', 'x');
    expect(() => addZipFile(zip, 'note.MD', 'y')).toThrow();
    expect(uniqueZipPath(zip, 'note.MD')).not.toBe('note.MD');
    expect(dedupeConversationNames([conv('u1', 'Note'), conv('u2', 'note')]).get('u2')).toBe('note_1');
  });
});

describe('getCurrentBranch', () => {
  it('terminates on a cyclic parent chain', () => {
    // Malformed, but a hang here freezes the whole export inside the loop where
    // the cancel flag is never checked.
    //
    // The walk reads parent_message_uuid once per step, so a counting getter
    // bounds it: without the cycle guard this throws on the 50th read instead
    // of spinning forever. That matters — a synchronous infinite loop is not
    // something vitest's timeout can interrupt, so the unbounded version of
    // this test wedges the runner and pegs a core until killed by hand.
    let reads = 0;
    // Defined in the literal, not spread in: spreading would invoke the getter
    // once and copy a plain value, leaving nothing to count.
    const message = (uuid, sender, parent) => ({
      uuid,
      sender,
      content: [],
      get parent_message_uuid() {
        if (++reads > 50) throw new Error('getCurrentBranch did not terminate');
        return parent;
      },
    });
    const data = {
      current_leaf_message_uuid: 'b',
      chat_messages: [message('a', 'human', 'b'), message('b', 'assistant', 'a')],
    };

    expect(() => getCurrentBranch(data)).not.toThrow();
    expect(reads).toBeLessThanOrEqual(2);
  });

  it('still walks a normal chain to the root', () => {
    const data = {
      current_leaf_message_uuid: 'c',
      chat_messages: [
        { uuid: 'a', parent_message_uuid: null, sender: 'human', content: [] },
        { uuid: 'b', parent_message_uuid: 'a', sender: 'assistant', content: [] },
        { uuid: 'c', parent_message_uuid: 'b', sender: 'human', content: [] },
      ],
    };
    expect(getCurrentBranch(data).map(m => m.uuid)).toEqual(['a', 'b', 'c']);
  });
});

describe('safeConversationName', () => {
  // The single-conversation export paths build their own ZIPs and used the raw
  // title, so a slash wrote outside the intended folder and silently replaced
  // another entry. They share this with the bulk dedup now.
  it('replaces path separators', () => {
    expect(safeConversationName('artifacts/Q3 plan', 'uuid')).toBe('artifacts_Q3 plan');
  });

  it('caps an over-long title', () => {
    expect(safeConversationName('A'.repeat(300), 'uuid').length).toBe(100);
  });

  it('falls back when nothing survives sanitizing', () => {
    expect(safeConversationName('..', 'uuid-abc')).toBe('uuid-abc');
    expect(safeConversationName('', 'uuid-abc')).toBe('uuid-abc');
    expect(safeConversationName(null, 'uuid-abc')).toBe('uuid-abc');
  });

  it('does not throw on a non-string title', () => {
    // At one call site the throw would escape to a try/finally with no catch,
    // closing the modal with no error shown.
    expect(() => safeConversationName(42, 'uuid-abc')).not.toThrow();
    expect(safeConversationName(42, 'uuid-abc')).toBe('uuid-abc');
    expect(safeConversationName({}, 'uuid-abc')).toBe('uuid-abc');
  });

  it('has a last-resort fallback when there is no identifier either', () => {
    expect(safeConversationName(null, null)).toBe('conversation');
  });

  it('agrees with the bulk dedup for a conversation with no duplicates', () => {
    const title = 'Plan/2025: "final"';
    expect(dedupeConversationNames([conv('u1', title)]).get('u1'))
      .toBe(safeConversationName(title, 'u1'));
  });
});

describe('assertConversationShape', () => {
  it('accepts a real conversation, including an empty one', () => {
    expect(() => assertConversationShape({ uuid: 'u', chat_messages: [] })).not.toThrow();
    expect(() => assertConversationShape({ uuid: 'u', chat_messages: [{ uuid: 'm' }] })).not.toThrow();
  });

  it.each([
    ['an error object', { error: { message: 'boom' } }],
    ['a bare string', 'Internal Server Error'],
    ['a number', 42],
    ['an array', []],
    ['null', null],
    ['a conversation with no messages array', { uuid: 'u' }],
  ])('rejects %s, which a 200 can still carry', (_label, body) => {
    expect(() => assertConversationShape(body)).toThrow(/not a conversation/);
  });

  it('rejects a payload the API says is truncated', () => {
    expect(() => assertConversationShape({ uuid: 'u', chat_messages: [], truncated: true }))
      .toThrow(/truncated/);
  });
});

describe('toZipBytes', () => {
  it('encodes a string to UTF-8 bytes', () => {
    expect(Array.from(toZipBytes('A\u00e9'))).toEqual([0x41, 0xc3, 0xa9]);
  });

  it('passes bytes through untouched, so an already-encoded write is not re-encoded', () => {
    const bytes = new Uint8Array([0xf0, 0x9f, 0x90, 0x8e]);
    expect(toZipBytes(bytes)).toBe(bytes);
  });

  it('encodes an astral character as one four-byte sequence', () => {
    expect(Array.from(toZipBytes('\u{1F40E}'))).toEqual([0xf0, 0x9f, 0x90, 0x8e]);
  });
});

describe('addZipFile UTF-8 integrity', () => {
  // JSZip hands string content to its utf-8 encode worker in 16384-code-unit
  // chunks and keeps no leftover across them, so a surrogate pair split by a
  // boundary is encoded as two lone surrogates. Writing bytes ourselves avoids
  // that path entirely. Both boundaries are checked because the bug recurs at
  // every multiple of the chunk size, not just the first.
  const horse = '\u{1F40E}';

  for (const boundary of [16384, 32768]) {
    it(`round-trips an astral character straddling code unit ${boundary}`, async () => {
      // One 'a' short of the boundary, so the high surrogate is the chunk's
      // last code unit and its low surrogate opens the next chunk.
      const content = 'a'.repeat(boundary - 1) + horse + 'tail';
      const zip = new JSZip();
      addZipFile(zip, 'a.json', content);
      const bytes = await zip.file('a.json').async('uint8array');
      expect(Array.from(bytes.slice(boundary - 1, boundary + 3)))
        .toEqual([0xf0, 0x9f, 0x90, 0x8e]);
      expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(content);
    });
  }

  it('leaves an astral character away from a boundary correct too', async () => {
    const content = 'a'.repeat(100) + horse + 'tail';
    const zip = new JSZip();
    addZipFile(zip, 'a.json', content);
    const bytes = await zip.file('a.json').async('uint8array');
    expect(new TextDecoder('utf-8', { fatal: true }).decode(bytes)).toBe(content);
  });

  it('still reads back as a string, so existing consumers are unaffected', async () => {
    const zip = new JSZip();
    addZipFile(zip, 'a.json', 'plain');
    expect(await zip.file('a.json').async('string')).toBe('plain');
  });
});

describe('createPacer', () => {
  it('starts with no deadline, so the first request is not delayed', () => {
    expect(createPacer(200)).toEqual({ intervalMs: 200, notBefore: 0 });
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

  it('refuses a duplicate that differs only in Unicode normalization', () => {
    // macOS normalizes filenames, so NFC and NFD spellings are one file.
    const combiningAcute = String.fromCharCode(0x301);
    const name = 'cafe' + combiningAcute + '.py';
    const zip = new JSZip();
    addZipFile(zip, 'a/' + name.normalize('NFC'), 'first');
    expect(() => addZipFile(zip, 'a/' + name.normalize('NFD'), 'second'))
      .toThrow(/Duplicate ZIP entry/);
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

  it('catches a case variant of an entry written directly with zip.file', () => {
    const zip = new JSZip();
    zip.file('Chats/A.md', 'written outside the helper');
    expect(() => addZipFile(zip, 'Chats/a.md', 'x')).toThrow(/Duplicate ZIP entry/);
  });

  it('catches an exact duplicate of an entry written directly with zip.file', () => {
    const zip = new JSZip();
    zip.file('a.md', 'raw');
    expect(() => addZipFile(zip, 'a.md', 'x')).toThrow(/Duplicate ZIP entry/);
  });

  it('catches a raw write made after the index was seeded', () => {
    // The seed only runs once, so a later raw write — the manifest is one — is
    // covered by the exact-match cross-check and nothing else.
    const zip = new JSZip();
    addZipFile(zip, 'first.md', 'x');
    zip.file('export-manifest.json', '{}');
    expect(() => addZipFile(zip, 'export-manifest.json', 'y')).toThrow(/Duplicate ZIP entry/);
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

// Artifact filenames go through a second, separate sanitizer; several tests
// need to reach it from outside the artifact describe block.
const namesForArtifacts = (...filenames) => extractArtifactFiles({
  name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm2',
  chat_messages: [
    { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
    { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: filenames.map(filename => ({
      type: 'tool_use', name: 'artifacts',
      display_content: { type: 'code_block', code: 'print(1)', language: 'python', filename },
    })) },
  ],
}, 'original').map(a => a.filename);

describe('extractArtifactFiles robustness', () => {
  it('survives an artifact whose language is not a string', () => {
    // isProgrammingLanguage runs before getFileExtension matters, so coercing
    // only the latter left the conversation permanently unexportable.
    const data = {
      name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm2',
      chat_messages: [
        { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
        { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: [{
          type: 'tool_use', name: 'artifacts',
          display_content: { type: 'code_block', code: 'x', language: 42, filename: 'a' },
        }] },
      ],
    };
    expect(() => extractArtifactFiles(data, 'original')).not.toThrow();
  });
});

describe('artifact extraction from the tool call input', () => {
  // display_content is a rendering claude.ai attaches for the UI; it is absent on
  // some calls and truncated at 64 KiB on others. The body is in the call itself.
  const fromBlocks = (blocks) => extractArtifactFiles({
    name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm2',
    chat_messages: [
      { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
      { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: blocks },
    ],
  }, 'original');

  const call = (input, display_content) => ({
    type: 'tool_use', name: 'artifacts', input, ...(display_content ? { display_content } : {}),
  });

  it('writes an artifact whose call carries no display_content at all', () => {
    const files = fromBlocks([call({
      command: 'create', id: 'a1', title: 'Notes', type: 'text/markdown', content: '# hi',
    })]);
    expect(files).toEqual([{ filename: 'Notes.md', content: '# hi' }]);
  });

  it('writes an artifact whose json_block was truncated mid-string', () => {
    // A 64 KiB cut leaves unparseable JSON; previously this was warned about and
    // dropped, taking the artifact with it even though the body was right there.
    const truncated = '{"filename":"a.py","language":"python","code":"print(1';
    const files = fromBlocks([call(
      { command: 'create', id: 'a1', title: 'Script', type: 'application/vnd.ant.code', language: 'python', content: 'print(1)' },
      { type: 'json_block', json_block: truncated },
    )]);
    expect(files).toEqual([{ filename: 'Script.py', content: 'print(1)' }]);
  });

  it('prefers display_content and does not also write the input copy', () => {
    const files = fromBlocks([call(
      { command: 'create', id: 'a1', title: 'Ignored', type: 'text/markdown', content: 'from input' },
      { type: 'code_block', code: 'from display', language: 'python', filename: 'shown.py' },
    )]);
    expect(files).toEqual([{ filename: 'shown.py', content: 'from display' }]);
  });

  it('writes nothing for an update that carries only a patch', () => {
    // No body to write, and an artifact whose only calls are patches has no
    // rendered base to apply them to, so there is nothing to reconstruct.
    expect(fromBlocks([call({ command: 'update', id: 'a1', old_str: 'a', new_str: 'b' })])).toEqual([]);
  });

  it('gives a rewrite the title its create declared', () => {
    // A rewrite call carries only the new body and the id.
    const files = fromBlocks([
      call({ command: 'create', id: 'a1', title: 'Report', type: 'text/markdown', content: 'v1' }),
      call({ command: 'rewrite', id: 'a1', content: 'v2' }),
    ]);
    expect(files.map(f => f.filename)).toEqual(['Report.md', 'Report_1.md']);
    expect(files.map(f => f.content)).toEqual(['v1', 'v2']);
  });

  it('derives the extension from the type when no language is given', () => {
    const byType = (type) => fromBlocks([call({
      command: 'create', id: 'a1', title: 'T', type, content: 'x',
    })])[0].filename;
    expect(byType('text/markdown')).toBe('T.md');
    expect(byType('text/html')).toBe('T.html');
    expect(byType('image/svg+xml')).toBe('T.svg');
  });

  it('uses the explicit language for a code artifact, whose type implies none', () => {
    const files = fromBlocks([call({
      command: 'create', id: 'a1', title: 'T', type: 'application/vnd.ant.code',
      language: 'rust', content: 'fn main() {}',
    })]);
    expect(files[0].filename).toBe('T.rs');
  });

  it('falls back to .txt rather than producing an extensionless name', () => {
    const files = fromBlocks([call({ command: 'create', id: 'a1', title: 'T', content: 'x' })]);
    expect(files[0].filename).toBe('T.txt');
  });

  it('trims the body, matching the display_content path', () => {
    const files = fromBlocks([call({
      command: 'create', id: 'a1', title: 'T', type: 'text/markdown', content: '\n  body  \n',
    })]);
    expect(files[0].content).toBe('body');
  });
});

describe('artifactFromToolInput', () => {
  it('refuses a call with no body', () => {
    expect(artifactFromToolInput({ command: 'update', id: 'a', old_str: 'x', new_str: 'y' })).toBeNull();
    expect(artifactFromToolInput({ command: 'create', id: 'a', content: '' })).toBeNull();
    expect(artifactFromToolInput(null)).toBeNull();
    expect(artifactFromToolInput(undefined)).toBeNull();
  });

  it('refuses a body that is not a string', () => {
    expect(artifactFromToolInput({ command: 'create', id: 'a', content: { code: 'x' } })).toBeNull();
  });

  it('names an artifact Untitled only when no call ever declared a title', () => {
    expect(artifactFromToolInput({ command: 'rewrite', id: 'a', content: 'x' }).title).toBe('Untitled');
  });

  it('prefers the call\'s own language over the one its type implies', () => {
    const a = artifactFromToolInput({
      command: 'create', id: 'a', type: 'text/markdown', language: 'python', content: 'x',
    });
    expect(a.language).toBe('python');
  });

  it('classifies a markdown artifact as a document and a code one as code', () => {
    expect(artifactFromToolInput({ command: 'create', id: 'a', type: 'text/markdown', content: 'x' }).type)
      .toBe('document');
    expect(artifactFromToolInput({ command: 'create', id: 'a', type: 'application/vnd.ant.code', language: 'rust', content: 'x' }).type)
      .toBe('code');
  });
});

describe('collectArtifactMeta', () => {
  const msg = (blocks) => ({ content: blocks });
  const call = (input) => ({ type: 'tool_use', name: 'artifacts', input });

  it('keeps a title declared earlier when a later call omits it', () => {
    const meta = collectArtifactMeta([
      msg([call({ command: 'create', id: 'a1', title: 'Kept', type: 'text/markdown' })]),
      msg([call({ command: 'rewrite', id: 'a1' })]),
    ]);
    expect(meta.get('a1')).toEqual({ title: 'Kept', type: 'text/markdown' });
  });

  it('does not let a second artifact inherit the first one\'s title', () => {
    const meta = collectArtifactMeta([
      msg([call({ command: 'create', id: 'a1', title: 'One' })]),
      msg([call({ command: 'create', id: 'a2', content: 'x' })]),
    ]);
    expect(meta.get('a2')).toEqual({});
  });

  it('ignores tool calls that are not artifact producers', () => {
    const meta = collectArtifactMeta([
      msg([{ type: 'tool_use', name: 'web_search', input: { id: 'w1', title: 'Search' } }]),
    ]);
    expect(meta.has('w1')).toBe(false);
  });

  it('tolerates a message with no content array', () => {
    expect(() => collectArtifactMeta([{ uuid: 'm1' }])).not.toThrow();
  });
});

describe('language handling', () => {
  it('matches a capitalized language name', () => {
    expect(getFileExtension('Python')).toBe('.py');
    expect(isProgrammingLanguage('TypeScript')).toBe(true);
  });

  it('ignores a non-string language rather than throwing', () => {
    expect(() => getFileExtension(42)).not.toThrow();
    expect(() => isProgrammingLanguage(42)).not.toThrow();
    expect(getFileExtension(42)).toBe('.txt');
  });
});

describe('extractArtifactFiles via the antArtifact text path', () => {
  // display_content-based fixtures never exercise the artifact sanitizer's
  // path-separator handling, because extractArtifactsFromMessage already takes
  // a basename on that route. This one passes the title through verbatim.
  const fromTag = (attrs) => extractArtifactFiles({
    name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm2',
    chat_messages: [
      { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
      { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: [{
        type: 'text',
        text: `<antArtifact ${attrs}>print(1)</antArtifact>`,
      }] },
    ],
  }, 'original').map(a => a.filename);

  it('strips a path separator from a tag title', () => {
    expect(fromTag('title="a/b" language="python"')).toEqual(['a_b.py']);
  });

  it('strips a backslash from a tag title', () => {
    expect(fromTag('title="a\\b" language="python"')).toEqual(['a_b.py']);
  });

  it('does not produce an extension-only dotfile from an empty title', () => {
    const names = fromTag('title="" language="python"');
    expect(names[0]).not.toMatch(/^\./);
  });
});

describe('uniqueZipPath', () => {
  it('returns the path unchanged when it is free', () => {
    expect(uniqueZipPath(new JSZip(), 'Artifacts/a.md')).toBe('Artifacts/a.md');
  });

  it('suffixes before the extension when the path is taken', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Artifacts/a.md', 'x');
    expect(uniqueZipPath(zip, 'Artifacts/a.md')).toBe('Artifacts/a_1.md');
  });

  it('keeps suffixing until it finds a free path', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Artifacts/a.md', 'x');
    addZipFile(zip, 'Artifacts/a_1.md', 'y');
    expect(uniqueZipPath(zip, 'Artifacts/a.md')).toBe('Artifacts/a_2.md');
  });

  it('keeps suffixing past a second collision', () => {
    // Two bumps is the answer a non-looping implementation also reaches.
    const zip = new JSZip();
    for (const path of ['A/a.md', 'A/a_1.md', 'A/a_2.md']) addZipFile(zip, path, 'x');
    expect(uniqueZipPath(zip, 'A/a.md')).toBe('A/a_3.md');
  });

  it('respects filesystem folding, not just exact matches', () => {
    const zip = new JSZip();
    addZipFile(zip, 'Artifacts/A.MD', 'x');
    expect(uniqueZipPath(zip, 'Artifacts/a.md')).toBe('Artifacts/a_1.md');
  });

  it('resolves the flat-mode composite collision instead of failing it', () => {
    // "file_1" + "notes.md" and "file" + "1_notes.md" compose identically.
    const zip = new JSZip();
    const first = uniqueZipPath(zip, 'Artifacts/file_1_notes.md');
    addZipFile(zip, first, 'a');
    const second = uniqueZipPath(zip, 'Artifacts/file_1_notes.md');
    expect(second).not.toBe(first);
    expect(() => addZipFile(zip, second, 'b')).not.toThrow();
  });

  it('sees an archive entry that predates any guarded write', () => {
    const zip = new JSZip();
    zip.file('notes.md', 'raw');
    expect(uniqueZipPath(zip, 'notes.md')).toBe('notes_1.md');
  });

  it('sees a raw entry added after the index was seeded', () => {
    const zip = new JSZip();
    addZipFile(zip, 'a.md', 'x');
    zip.file('b.md', 'raw');
    expect(uniqueZipPath(zip, 'b.md')).toBe('b_1.md');
  });

  it('does not treat a dot inside a folder name as an extension', () => {
    const zip = new JSZip();
    addZipFile(zip, 'v1.2/a', 'x');
    expect(uniqueZipPath(zip, 'v1.2/a')).toBe('v1.2/a_1');
  });
});

describe('extractArtifactFiles filename dedup', () => {
  // The producer must agree with addZipFile's guard. When it did not, a
  // conversation holding both Main.py and main.py threw on every run and could
  // never be exported at all.
  const artifact = (filename) => ({
    type: 'tool_use', name: 'artifacts',
    display_content: { type: 'code_block', code: 'print(1)', language: 'python', filename },
  });
  const conversation = (...filenames) => ({
    name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm2',
    chat_messages: [
      { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
      { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: filenames.map(artifact) },
    ],
  });

  const namesFor = (...filenames) =>
    extractArtifactFiles(conversation(...filenames), 'original').map(a => a.filename);

  it('separates artifact filenames differing only in case', () => {
    const names = namesFor('Main.py', 'main.py');
    expect(names).toHaveLength(2);
    expect(new Set(names.map(filenameKey)).size).toBe(2);
  });

  it('separates artifact filenames differing only in normalization', () => {
    const combiningAcute = String.fromCharCode(0x301);
    const base = 'cafe' + combiningAcute + '.py';
    const names = namesFor(base.normalize('NFC'), base.normalize('NFD'));
    expect(names).toHaveLength(2);
    expect(new Set(names.map(filenameKey)).size).toBe(2);
  });

  it('assigns the exact deduplicated names, not merely distinct ones', () => {
    expect(namesFor('Main.py', 'main.py', 'MAIN.py')).toEqual(['Main.py', 'main_1.py', 'MAIN_2.py']);
  });

  it('keeps the original extension when deduplicating a dotted name', () => {
    expect(namesFor('My.Data.V2.py', 'my.data.v2.py')).toEqual(['My.Data.V2.py', 'my.data.v2_1.py']);
  });

  it('deduplicates across messages, not just within one', () => {
    const data = {
      name: 'Conv', uuid: 'u1', current_leaf_message_uuid: 'm3',
      chat_messages: [
        { uuid: 'm1', sender: 'human', parent_message_uuid: '00000000-0000-0000-0000-000000000000', content: [] },
        { uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', content: [artifact('Main.py')] },
        { uuid: 'm3', sender: 'assistant', parent_message_uuid: 'm2', content: [artifact('Main.py')] },
      ],
    };
    const names = extractArtifactFiles(data, 'original').map(a => a.filename);
    expect(names).toEqual(['Main.py', 'Main_1.py']);
  });

  it('starts each conversation with a clean namespace', () => {
    expect(namesFor('Main.py')).toEqual(['Main.py']);
    expect(namesFor('Main.py')).toEqual(['Main.py']);
  });

  it('produces names that addZipFile will accept together', () => {
    const zip = new JSZip();
    for (const name of namesFor('Main.py', 'main.py', 'MAIN.py')) {
      expect(() => addZipFile(zip, `Conv/artifacts/${name}`, 'x')).not.toThrow();
    }
  });

  it('caps an over-long artifact filename', () => {
    const names = namesFor('z'.repeat(400) + '.py');
    expect([...names[0]].length).toBeLessThanOrEqual(104);
  });

  it('strips control characters from artifact filenames', () => {
    const names = namesFor('we' + String.fromCharCode(9) + 'ird.py');
    expect(names[0]).not.toContain(String.fromCharCode(9));
  });

  it('strips DEL from artifact filenames too', () => {
    const names = namesFor('we' + String.fromCharCode(0x7f) + 'ird.py');
    expect(names[0]).not.toContain(String.fromCharCode(0x7f));
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

  it('fires when two conversations claim the same path', () => {
    // One file cannot be two successes, however many entries say they wrote it.
    const zip = new JSZip();
    zip.file('Recipe.md', 'second wins');
    const entries = [
      entry({ uuid: 'u1', files: ['Recipe.md'] }),
      entry({ uuid: 'u2', files: ['Recipe.md'] }),
    ];
    const result = reconcileManifest(entries, zip);
    expect(result.ok).toBe(false);
    expect(result.missing.map(m => m.uuid).sort()).toEqual(['u1', 'u2']);
    expect(exportedUuids(entries, result)).toEqual([]);
  });

  it('ignores paths claimed by a conversation that did not succeed', () => {
    // A failed attempt records whatever it wrote before throwing. Letting that
    // contest the successful owner would deny it a timestamp on every run.
    const zip = new JSZip();
    zip.file('Report.md', 'x');
    const entries = [
      entry({ uuid: 'good', status: 'exported', files: ['Report.md'] }),
      entry({ uuid: 'bad', status: 'failed', files: ['Report.md'] }),
    ];
    const result = reconcileManifest(entries, zip);
    expect(result.ok).toBe(true);
    expect(exportedUuids(entries, result)).toEqual(['good']);
  });

  it('fires when two conversations claim paths that differ only by folding', () => {
    const zip = new JSZip();
    zip.file('Recipe.md', 'a');
    zip.file('recipe.md', 'b');
    const entries = [
      entry({ uuid: 'u1', files: ['Recipe.md'] }),
      entry({ uuid: 'u2', files: ['recipe.md'] }),
    ];
    expect(reconcileManifest(entries, zip).ok).toBe(false);
  });

  it('reports an exported entry with no files property at all', () => {
    const result = reconcileManifest([{ uuid: 'u1', title: 'T', status: 'exported' }], new JSZip());
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toMatch(/wrote no files/);
  });

  it('checks every claimed path, not only the last', () => {
    const zip = new JSZip();
    zip.file('present.md', 'x');
    const result = reconcileManifest([entry({ files: ['missing.md', 'present.md'] })], zip);
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toContain('missing.md');
  });

  it('fires when an entry claims two paths that differ only by folding', () => {
    // Both spellings really are in the archive, so a presence check passes and
    // an unfolded duplicate check passes; only a folded one catches it.
    const zip = new JSZip();
    zip.file('Notes.md', 'a');
    zip.file('notes.md', 'b');
    const result = reconcileManifest([entry({ files: ['Notes.md', 'notes.md'] })], zip);
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toMatch(/same path more than once/);
  });

  it('fires when an entry claims the same path twice', () => {
    // Three claimed paths that are one archive entry is not three files.
    const zip = new JSZip();
    zip.file('only.md', 'x');
    const result = reconcileManifest([entry({ files: ['only.md', 'only.md'] })], zip);
    expect(result.ok).toBe(false);
    expect(result.missing[0].reason).toMatch(/same path more than once/);
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

  it('ignores pending entries', () => {
    // What every unreached conversation holds after a cancelled run.
    expect(reconcileManifest([entry({ status: 'pending', files: [] })], new JSZip()).ok).toBe(true);
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
  });

  it('does not record an unnamed conversation that failed as exported', () => {
    const entries = [{ uuid: 'uuid-1', title: null, status: 'failed', reason: 'HTTP 500', files: [] }];
    expect(exportedUuids(entries, clean)).toEqual([]);
  });

  it('tolerates a reconciliation object with no missing list', () => {
    const entries = [{ uuid: 'u1', status: 'exported', files: ['a.md'] }];
    expect(exportedUuids(entries, { ok: true })).toEqual(['u1']);
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

  it('distinguishes every terminal status from a success', () => {
    const entries = [
      { uuid: 'e', status: 'exported', files: ['e.md'] },
      { uuid: 's', status: 'skipped', files: [] },
      { uuid: 'f', status: 'failed', files: [] },
      { uuid: 'c', status: 'cancelled', files: [] },
      { uuid: 'p', status: 'pending', files: [] },
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
      EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME,
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
    const conversations = [conv('u1', EXPORT_MANIFEST_BASENAME)];
    const safeNames = dedupeConversationNames(conversations,
      [EXPORT_MANIFEST_BASENAME, EXPORT_MANIFEST_FILENAME]);
    const zip = new JSZip();

    addZipFile(zip, `${safeNames.get('u1')}.json`, 'conversation body');
    // The manifest write must not collide with it.
    expect(() => addZipFile(zip, EXPORT_MANIFEST_FILENAME, '{}')).not.toThrow();
  });
});
