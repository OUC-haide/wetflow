export type ResearchProvider = 'europepmc' | 'arxiv' | 'geo';
export interface SearchHit { provider:ResearchProvider; externalId:string; title:string; url:string; doi?:string; authors?:string; year?:string; abstract?:string; pmcid?:string; accession?:string; }
export interface SourceDocument { text:string; level:'metadata'|'abstract'|'fulltext'; url:string; mediaType:string; note?:string; }

type Fetcher = typeof fetch;
const MAX_RESULTS = 20;
const MAX_BODY = 2_000_000;
const TIMEOUT_MS = 12_000;
const safeText = (s: string, max = 12_000) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const decodeXml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)));
function tag(xml: string, name: string): string { return decodeXml(xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'i'))?.[1] ?? ''); }
function all(xml: string, name: string): string[] { return [...xml.matchAll(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, 'gi'))].map(m => decodeXml(m[1] ?? '')); }
function plainXml(xml: string): string {
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<article\b/i.test(xml)) throw new Error('Europe PMC full-text response is not an article XML document');
  const stack: string[] = [];
  for (const m of xml.matchAll(/<\s*(\/?)\s*([\w:.-]+)\b[^>]*?(\/?)\s*>/g)) {
    const closing = m[1] === '/'; const selfClosing = m[3] === '/'; const name = (m[2] ?? '').toLowerCase();
    if (name.startsWith('!') || name.startsWith('?')) continue;
    if (closing) { if (stack.pop() !== name) throw new Error('Malformed Europe PMC article XML'); }
    else if (!selfClosing) stack.push(name);
  }
  if (stack.length) throw new Error('Malformed Europe PMC article XML');
  return decodeXml(xml
    .replace(/<\/?(?:article|body|sec|title|p|table-wrap|table|thead|tbody|label|caption|italic|bold|sup|sub|xref|ext-link|list|list-item|named-content|fig|graphic|media|disp-formula|formula)\b[^>]*>/gi, '\n')
    .replace(/<(?:td|th)\b[^>]*>/gi, '')
    .replace(/<\/(?:td|th)\s*>/gi, '\t')
    .replace(/<tr\b[^>]*>/gi, '')
    .replace(/<\/tr\s*>/gi, '\n')
    .replace(/<\/?(?:break|br)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]*\n[ \t]*/g, '\n').replace(/ *\t */g, '\t').replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

const ALLOWED_HOSTS = new Set(['www.ebi.ac.uk', 'ebi.ac.uk', 'europepmc.org', 'export.arxiv.org', 'arxiv.org', 'eutils.ncbi.nlm.nih.gov', 'www.ncbi.nlm.nih.gov', 'ncbi.nlm.nih.gov']);
function allowedUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname)) throw new Error('Public source redirected outside approved HTTPS provider hosts');
  return url;
}

async function request(url: string, fetcher: Fetcher, signal?: AbortSignal): Promise<{ body: string; contentType: string }> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
  let current = allowedUrl(url); let response: Response;
  for (let redirects = 0; ; redirects++) {
    response = await fetcher(current.toString(), { signal: combined, redirect: 'manual', headers: { accept: 'application/json, application/atom+xml, application/xml, text/xml;q=0.9' } });
    if (signal?.aborted) throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (redirects >= 2) throw new Error('Public source exceeded the redirect limit');
    const location = response.headers.get('location'); if (!location) throw new Error('Public source returned a redirect without a location');
    current = allowedUrl(new URL(location, current).toString());
  }
  if (!response.ok) throw new Error(`Public source returned HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_BODY) throw new Error('Public source response exceeded the 2 MB limit');
  if (!response.body) {
    const body = await response.text();
    if (body.length > MAX_BODY) throw new Error('Public source response exceeded the 2 MB limit');
    return { body, contentType: response.headers.get('content-type') ?? '' };
  }
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > MAX_BODY) { await reader.cancel(); throw new Error('Public source response exceeded the 2 MB limit'); } chunks.push(value); }
  } finally { reader.releaseLock(); }
  const merged = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return { body: new TextDecoder().decode(merged), contentType: response.headers.get('content-type') ?? '' };
}

export async function searchPublic(provider: ResearchProvider, query: string, limit: number, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<SearchHit[]> {
  if (!['europepmc', 'arxiv', 'geo'].includes(provider)) throw new Error('Unsupported public research provider');
  const q = query.trim(); if (!q || q.length > 500) throw new Error('Search query must contain 1–500 characters');
  const n = Math.max(1, Math.min(MAX_RESULTS, Math.floor(Number.isFinite(limit) ? limit : 1)));
  if (provider === 'europepmc') {
    const u = new URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search'); u.search = new URLSearchParams({ query: q, format: 'json', pageSize: String(n), resultType: 'core' }).toString();
    const { body } = await request(u.toString(), fetcher, signal); const data = JSON.parse(body) as { resultList?: { result?: Record<string, unknown>[] } };
    return (data.resultList?.result ?? []).slice(0, n).map(x => { const id = String(x.pmid ?? x.pmcid ?? ''); const pmcid = x.pmcid ? String(x.pmcid) : undefined; return { provider, externalId: id, title: String(x.title ?? ''), url: pmcid ? `https://europepmc.org/articles/${pmcid}` : `https://europepmc.org/article/MED/${id}`, ...(x.doi ? { doi: String(x.doi) } : {}), ...(x.authorString ? { authors: String(x.authorString) } : {}), ...(x.firstPublicationDate ? { year: String(x.firstPublicationDate).slice(0, 4) } : {}), ...(x.abstractText ? { abstract: safeText(String(x.abstractText)) } : {}), ...(pmcid ? { pmcid } : {}) } as SearchHit; }).filter(x => x.externalId && x.title);
  }
  if (provider === 'arxiv') {
    const terms = q.match(/[\p{L}\p{N}_.+-]+/gu) ?? [];
    if (!terms.length) throw new Error('Search query must include searchable words');
    const u = new URL('https://export.arxiv.org/api/query'); u.search = new URLSearchParams({ search_query: terms.map(term => `all:${term}`).join(' AND '), start: '0', max_results: String(n), sortBy: 'relevance', sortOrder: 'descending' }).toString();
    const { body } = await request(u.toString(), fetcher, signal);
    return all(body, 'entry').slice(0, n).map(entry => { const id = tag(entry, 'id').trim(); const externalId = id.match(/\/abs\/(.+)$/)?.[1] ?? id.split('/').at(-1) ?? id; return { provider, externalId, title: safeText(tag(entry, 'title')), url: id.replace(/^http:\/\//i, 'https://'), ...(tag(entry, 'published') ? { year: tag(entry, 'published').slice(0, 4) } : {}), ...(all(entry, 'author').map(a => safeText(tag(a, 'name'), 200)).filter(Boolean).length ? { authors: all(entry, 'author').map(a => safeText(tag(a, 'name'), 200)).filter(Boolean).join(', ').slice(0, 1000) } : {}), ...(tag(entry, 'summary') ? { abstract: safeText(tag(entry, 'summary')) } : {}) }; }).filter(x => x.externalId && x.title);
  }
  const u = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi'); u.search = new URLSearchParams({ db: 'gds', term: q, retmode: 'json', retmax: String(n) }).toString();
  const { body } = await request(u.toString(), fetcher, signal); const ids = (JSON.parse(body) as { esearchresult?: { idlist?: string[] } }).esearchresult?.idlist ?? [];
  if (!ids.length) return [];
  const summary = new URL('https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'); summary.search = new URLSearchParams({ db: 'gds', id: ids.join(','), retmode: 'json' }).toString();
  const { body: sb } = await request(summary.toString(), fetcher, signal); const result = JSON.parse(sb) as { result?: Record<string, Record<string, unknown>> };
  return ids.slice(0, n).map(id => { const x = result.result?.[id] ?? {}; const acc = String(x.accession ?? x.gds ?? id); const title = String(x.title ?? ''); return { provider, externalId: id, title, url: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(acc)}`, accession: acc, ...(x.summary ? { abstract: safeText(String(x.summary)) } : {}), ...(x.gpl ? { authors: `Platform ${String(x.gpl)}` } : {}) }; }).filter(x => x.title);
}

export async function fetchPublic(hit: SearchHit, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<SourceDocument> {
  if (hit.provider === 'europepmc') {
    if (hit.pmcid && /^PMC\d+$/i.test(hit.pmcid)) {
      const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/${encodeURIComponent(hit.pmcid)}/fullTextXML`;
      try { const { body } = await request(url, fetcher, signal); const fullText = plainXml(body); const truncated = fullText.length > 100_000; const text = fullText.slice(0, 100_000); if (text.length > 0) return { text, level: 'fulltext', url, mediaType: 'application/xml', ...(truncated ? { note: 'Full text truncated at 100,000 characters.' } : {}) }; }
      catch (error) { if (signal?.aborted) throw error; }
    }
    if (hit.abstract) return { text: safeText(hit.abstract), level: 'abstract', url: hit.url, mediaType: 'text/plain', note: 'Europe PMC abstract only; full text was unavailable or not open access.' };
    throw new Error('No open abstract or full text is available for this Europe PMC record');
  }
  if (hit.provider === 'arxiv') {
    const id = hit.externalId.replace(/^https?:\/\/(?:www\.)?arxiv\.org\/abs\//i, ''); if (!/^(?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7}(?:v\d+)?|\d{4}\.\d{4,5}(?:v\d+)?)$/i.test(id)) throw new Error('Invalid arXiv record identifier');
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const { body } = await request(url, fetcher, signal); const entry = all(body, 'entry')[0]; const abstract = entry ? safeText(tag(entry, 'summary')) : hit.abstract ?? '';
    if (!abstract) throw new Error('No abstract is available for this arXiv record');
    return { text: abstract, level: 'abstract', url: `https://arxiv.org/abs/${encodeURIComponent(id)}`, mediaType: 'text/plain', note: 'Metadata API supplies the abstract; full text/PDF is not ingested.' };
  }
  if (hit.provider === 'geo') return { text: hit.abstract ?? 'GEO series metadata is available; experiment matrix and raw files have not been downloaded.', level: 'metadata', url: hit.url, mediaType: 'text/plain', note: 'GEO search metadata only. Raw expression matrices and supplementary files are not ingested.' };
  throw new Error('Unsupported public research provider');
}
