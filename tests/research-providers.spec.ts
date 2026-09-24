import { describe, expect, it, vi } from 'vitest';
import { fetchPublic, searchPublic } from '../src/research/providers.js';

function fixture(body: string, type = 'application/json', status = 200): typeof fetch {
  return vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })) as unknown as typeof fetch;
}

describe('public research adapters', () => {
  it('maps Europe PMC results and falls back honestly to an abstract', async () => {
    const f = fixture(JSON.stringify({ resultList: { result: [{ pmid: '123', pmcid: 'PMC123', title: 'Yeast growth', doi: '10.1/x', authorString: 'A One', firstPublicationDate: '2024-01-02', abstractText: 'A <i>growth</i> study' }] } }));
    const hits = await searchPublic('europepmc', 'yeast', 99, undefined, f);
    expect(hits).toHaveLength(1); expect(hits[0]).toMatchObject({ externalId: '123', pmcid: 'PMC123', year: '2024', doi: '10.1/x' });
    const result = await fetchPublic(hits[0]!, undefined, fixture('', 'application/xml', 404));
    expect(result.level).toBe('abstract'); expect(result.text).toContain('growth'); expect(result.note).toContain('abstract only');
    const full = await fetchPublic(hits[0]!, undefined, fixture('<article><body><p>Growth was measured in g/L.</p><table><tr><th>Time (h)</th><th>Biomass (g/L)</th></tr><tr><td>4</td><td>1.25</td></tr></table></body></article>', 'application/xml'));
    expect(full.level).toBe('fulltext'); expect(full.text).toContain('Growth was measured in g/L.'); expect(full.text).toContain('Time (h)\tBiomass (g/L)\n4\t1.25');
    expect((await fetchPublic(hits[0]!, undefined, fixture('<html><body>fake</body></html>', 'text/html'))).level).toBe('abstract');
    expect((await fetchPublic(hits[0]!, undefined, fixture('<article><body><p>broken</body></article>', 'application/xml'))).level).toBe('abstract');
    const truncated = await fetchPublic(hits[0]!, undefined, fixture(`<article><body><p>${'x'.repeat(100_010)}</p></body></article>`, 'application/xml'));
    expect(truncated.text).toHaveLength(100_000); expect(truncated.note).toContain('truncated');
  });

  it('parses arXiv metadata and returns abstract level only', async () => {
    const xml = `<feed><entry><id>https://arxiv.org/abs/2401.00001</id><title>Culture kinetics</title><published>2024-01-01</published><author><name> B A </name></author><summary>Line one &amp; line two.</summary></entry></feed>`;
    const hits = await searchPublic('arxiv', 'culture', 2, undefined, fixture(xml, 'application/atom+xml'));
    expect(hits[0]).toMatchObject({ externalId: '2401.00001', title: 'Culture kinetics', authors: 'B A', year: '2024' });
    const doc = await fetchPublic(hits[0]!, undefined, fixture(xml, 'application/atom+xml'));
    expect(doc.level).toBe('abstract'); expect(doc.text).toBe('Line one & line two.'); expect(doc.note).toContain('not ingested');
    const legacy = '<feed><entry><id>https://arxiv.org/abs/math.GT/0309136v1</id><title>Legacy</title><summary>Abstract</summary></entry></feed>';
    const legacyHits = await searchPublic('arxiv', 'yeast growth', 1, undefined, fixture(legacy, 'application/atom+xml'));
    expect(legacyHits[0]?.externalId).toBe('math.GT/0309136v1');
    const usedUrl: string[] = [];
    const legacyFetch = vi.fn(async (input: RequestInfo | URL) => { usedUrl.push(String(input)); return new Response(legacy, { headers: { 'content-type': 'application/atom+xml' } }); }) as unknown as typeof fetch;
    await fetchPublic(legacyHits[0]!, undefined, legacyFetch);
    expect(usedUrl[0]).toContain('id_list=math.GT%2F0309136v1');
    const andFetch = vi.fn(async (input: RequestInfo | URL) => { usedUrl.push(String(input)); return new Response('<feed/>', { headers: { 'content-type': 'application/atom+xml' } }); }) as unknown as typeof fetch;
    await searchPublic('arxiv', 'yeast growth', 1, undefined, andFetch);
    expect(new URL(usedUrl.at(-1)!).searchParams.get('search_query')).toBe('all:yeast AND all:growth');
  });

  it('maps GEO metadata and labels the document as metadata only', async () => {
    const esearch = fixture(JSON.stringify({ esearchresult: { idlist: ['42'] } }));
    const esummary = fixture(JSON.stringify({ result: { '42': { accession: 'GSE42', title: 'Fermentation series', summary: 'Study summary', gpl: '7' } } }));
    const f = vi.fn().mockImplementationOnce((...args: Parameters<typeof fetch>) => esearch(...args)).mockImplementationOnce((...args: Parameters<typeof fetch>) => esummary(...args)) as unknown as typeof fetch;
    const hits = await searchPublic('geo', 'fermentation', 5, undefined, f);
    expect(hits[0]).toMatchObject({ externalId: '42', accession: 'GSE42', title: 'Fermentation series' });
    const doc = await fetchPublic(hits[0]!, undefined, f);
    expect(doc.level).toBe('metadata'); expect(doc.note).toContain('not ingested'); expect(doc.text).toContain('Study summary');
  });

  it('caps results, rejects oversized bodies, and honors cancellation', async () => {
    const f = fixture(JSON.stringify({ resultList: { result: Array.from({ length: 30 }, (_, i) => ({ pmid: String(i), title: `t${i}` })) } }));
    expect(await searchPublic('europepmc', 'x', 100, undefined, f)).toHaveLength(20);
    await expect(searchPublic('europepmc', 'x', 1, undefined, fixture('x'.repeat(2_000_001)))).rejects.toThrow(/2 MB/);
    const externalRedirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://example.com/steal' } })) as unknown as typeof fetch;
    await expect(searchPublic('arxiv', 'x', 1, undefined, externalRedirect)).rejects.toThrow(/outside approved/);
    const c = new AbortController(); c.abort();
    await expect(searchPublic('arxiv', 'x', 1, c.signal, fixture('<feed/>', 'application/xml'))).rejects.toBeTruthy();
  });
});
