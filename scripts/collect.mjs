// Collects sources that can't be fetched from the browser (no CORS, or XML that
// needs parsing) and writes them to site/data/*.json for the Pages deploy.
// Every source is independent: a failure is recorded in meta.json and the run
// carries on, so one dead feed never blocks a deploy.

import { mkdir, writeFile } from 'node:fs/promises';
import { XMLParser } from 'fast-xml-parser';

const OUT_DIR = new URL('../site/data/', import.meta.url);
const USER_AGENT =
  'Mozilla/5.0 (compatible; palm-bay-weather-dashboard/1.0; +https://github.com/jackrugile/palm-bay-weather)';
const TIMEOUT_MS = 20_000;
const NEWS_MAX_AGE_DAYS = 14;
const NOTICE_MAX_AGE_DAYS = 30;
const MAX_ITEMS = 150;

const googleNews = (query) =>
  `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;

// Broad regional feeds are only kept when an item mentions the area AND matches a tag.
const LOCAL_AREA = /palm bay|brevard|melbourne|malabar|grant[- ]valkaria|sebastian|space coast|turkey creek|bayside lakes|indian river/i;

const NEWS_FEEDS = [
  { id: 'gn-palm-bay-flood', name: 'Google News: Palm Bay flood', url: googleNews('"Palm Bay" flood when:14d') },
  { id: 'gn-palm-bay-boil', name: 'Google News: Palm Bay boil water notice', url: googleNews('"Palm Bay" "boil water" when:14d') },
  { id: 'gn-palm-bay-water-main', name: 'Google News: Palm Bay water main break', url: googleNews('"Palm Bay" "water main" when:14d') },
  { id: 'gn-palm-bay-roads', name: 'Google News: Palm Bay road closures', url: googleNews('"Palm Bay" (road OR roads) (closed OR closure) when:14d') },
  { id: 'gn-brevard-flooding', name: 'Google News: Brevard County flooding', url: googleNews('"Brevard County" flooding when:7d') },
  { id: 'gn-fpl-brevard', name: 'Google News: FPL outage Brevard', url: googleNews('FPL outage Brevard when:7d') },
  // Florida Today and WESH block direct RSS requests (402/403), so they come in through Google News.
  { id: 'gn-florida-today', name: 'Florida Today (via Google News)', url: googleNews('site:floridatoday.com ("Palm Bay" OR Brevard) (flood OR flooding OR rain) when:7d'), localOnly: true },
  { id: 'gn-wesh', name: 'WESH (via Google News)', url: googleNews('site:wesh.com ("Palm Bay" OR Brevard) when:7d'), localOnly: true },
  { id: 'wftv', name: 'WFTV', url: 'https://www.wftv.com/arc/outboundfeeds/rss/?outputType=xml', localOnly: true },
  { id: 'wkmg', name: 'WKMG News 6', url: 'https://www.clickorlando.com/arc/outboundfeeds/rss/?outputType=xml', localOnly: true },
  { id: 'spectrum-brevard', name: 'Spectrum News 13 Brevard', url: 'https://mynews13.com/services/contentfeed.fl%7Corlando%7Cnews%7Cbrevard.landing.rss', localOnly: true },
];

const NOTICE_FEEDS = [
  // palmbayfl.gov (Granicus Vision CMS) sits behind Akamai, which rejects some clients; Google News covers any gap.
  { id: 'palm-bay-city', name: 'City of Palm Bay news', url: 'https://www.palmbayfl.gov/Home/Components/RssFeeds/RssFeed/View?ctID=5' },
  { id: 'doh-brevard', name: 'Florida DOH-Brevard', url: 'https://brevard.floridahealth.gov/feed/' },
  { id: 'gn-palm-bay-city', name: 'Google News: City of Palm Bay notices', url: googleNews('"City of Palm Bay" (boil OR "water main" OR "water service" OR closed OR shelter OR sandbag) when:14d') },
  { id: 'gn-brevard-em', name: 'Google News: Brevard Emergency Management', url: googleNews('("Brevard County Emergency Management" OR "Brevard EOC" OR "Brevard County" sandbags OR "Brevard County" shelter) when:14d') },
];

const FPL_COUNTY_URL = 'https://www.fplmaps.com/customer/outage/CountyOutages.json';
const OUTAGE_COUNTIES = ['Brevard', 'Indian River'];

const TAGS = [
  ['flood', /flood|inundat|standing water|high water|heavy rain|rainfall|flash flood|shelter in place/i],
  ['boil', /boil[- ]water|boil notice|precautionary boil/i],
  ['water service', /water service|water (?:was |is )?(?:shut|turned) off|turns? off water|water outage|without water|low water pressure|water pressure/i],
  ['main break', /water[- ]?main|main break|pipe (?:break|burst)|broken pipe/i],
  ['closure', /road(?:s|way)? (?:is |are )?closed|closures?\b|closed road|impassable|detour|lanes? closed|bridge closed|shut down (?:road|lanes)/i],
  ['shelter', /\bshelters?\b/i],
  ['sandbag', /sand ?bags?/i],
  ['power', /power outages?|power is out|without power|power (?:is |was )?restored|lost power|FPL outages?|outages? (?:map|report)/i],
  ['health', /health advisory|bacteria|water quality|mosquito|contaminat/i],
];
const NOTICE_TAGS = new Set(['boil', 'water service', 'main break', 'closure', 'shelter', 'sandbag', 'power', 'health']);
const LIFTED = /lifted|rescind|rescinded|cancel+ed|no longer|has been restored|resumed|reopen/i;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: 'text',
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
});

async function fetchWithRetry(url, { accept = '*/*', retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastError;
}

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v) => (v == null ? '' : typeof v === 'object' ? String(v.text ?? v.href ?? '') : String(v));

// Some feeds (the city's included) double-escape entities, so one decode pass remains after XML parsing.
const ENTITIES = { '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lt;': '<', '&gt;': '>' };

function stripHtml(html) {
  return textOf(html)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:nbsp|amp|quot|#39|apos|lt|gt);/g, (m) => ENTITIES[m])
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tagsFor(text) {
  return TAGS.filter(([, re]) => re.test(text)).map(([tag]) => tag);
}

function parseFeed(xml, feed) {
  const doc = parser.parse(xml);
  if (doc.rss?.channel) {
    return asArray(doc.rss.channel.item).map((item) => ({
      title: stripHtml(item.title),
      link: textOf(item.link),
      published: item.pubDate || item['dc:date'] || null,
      summary: stripHtml(item.description).slice(0, 280),
      source: textOf(item.source) || feed.name,
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((entry) => {
      const link = asArray(entry.link).find((l) => !l.rel || l.rel === 'alternate') ?? asArray(entry.link)[0];
      return {
        title: stripHtml(entry.title),
        link: link?.href ?? textOf(link),
        published: entry.published || entry.updated || null,
        summary: stripHtml(entry.summary ?? entry.content).slice(0, 280),
        source: feed.name,
      };
    });
  }
  throw new Error('Response is not an RSS or Atom feed');
}

function normalizeItem(raw, feed) {
  let { title, source } = raw;
  // Google News titles end with " - Outlet Name"; keep the outlet separately.
  if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3));
  const date = raw.published ? new Date(raw.published) : null;
  const published = date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null;
  const tags = tagsFor(`${title} ${raw.summary}`);
  return {
    title,
    link: raw.link,
    source,
    published,
    summary: raw.summary && raw.summary !== title ? raw.summary : '',
    tags,
    lifted: LIFTED.test(title),
    feed: feed.id,
  };
}

async function collectFeed(feed, status) {
  const started = Date.now();
  const entry = { id: feed.id, name: feed.name, kind: 'rss', url: feed.url, ok: false, count: 0, error: null, ms: 0 };
  status.push(entry);
  try {
    const res = await fetchWithRetry(feed.url, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' });
    let items = parseFeed(await res.text(), feed).map((raw) => normalizeItem(raw, feed));
    if (feed.localOnly) {
      items = items.filter((i) => LOCAL_AREA.test(`${i.title} ${i.summary}`) && i.tags.length > 0);
    }
    entry.ok = true;
    entry.count = items.length;
    return items;
  } catch (err) {
    entry.error = err.name === 'TimeoutError' ? `Timed out after ${TIMEOUT_MS / 1000}s` : String(err.message || err);
    return [];
  } finally {
    entry.ms = Date.now() - started;
  }
}

function dedupeAndSort(items, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  const byKey = new Map();
  for (const item of items) {
    if (!item.title || !item.link) continue;
    if (item.published && Date.parse(item.published) < cutoff) continue;
    const key = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 90);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, feeds: [item.feed] });
    } else {
      existing.feeds = [...new Set([...existing.feeds, item.feed])];
      existing.tags = [...new Set([...existing.tags, ...item.tags])];
      // Prefer a direct outlet link over a Google News redirect.
      if (existing.link.includes('news.google.com') && !item.link.includes('news.google.com')) existing.link = item.link;
    }
  }
  return [...byKey.values()]
    .map(({ feed, ...rest }) => rest)
    .sort((a, b) => (Date.parse(b.published ?? 0) || 0) - (Date.parse(a.published ?? 0) || 0))
    .slice(0, MAX_ITEMS);
}

const parseCount = (s) => Number(String(s ?? '').replace(/[^0-9]/g, '')) || 0;

async function collectOutages(status) {
  const started = Date.now();
  const entry = { id: 'fpl', name: 'FPL county outages', kind: 'json', url: FPL_COUNTY_URL, ok: false, count: 0, error: null, ms: 0 };
  status.push(entry);
  const result = {
    provider: 'Florida Power & Light',
    ok: false,
    error: null,
    sourceUpdated: null,
    counties: [],
    links: {
      fplMap: 'https://www.fplmaps.com/',
      powerOutageUs: 'https://poweroutage.us/area/state/florida',
    },
  };
  try {
    const res = await fetchWithRetry(FPL_COUNTY_URL, { accept: 'application/json' });
    const lastModified = res.headers.get('last-modified');
    const data = await res.json();
    const rows = asArray(data.outages);
    if (!rows.length) throw new Error('No county rows in FPL response');
    result.counties = OUTAGE_COUNTIES.map((name) => {
      const row = rows.find((r) => String(r['County Name']).toLowerCase() === name.toLowerCase());
      if (!row) return null;
      const out = parseCount(row['Customers Out']);
      const served = parseCount(row['Customers Served']);
      return { county: name, out, served, percent: served ? (out / served) * 100 : null };
    }).filter(Boolean);
    if (!result.counties.length) throw new Error(`None of ${OUTAGE_COUNTIES.join(', ')} found in FPL response`);
    result.sourceUpdated = lastModified ? new Date(lastModified).toISOString() : null;
    result.ok = true;
    entry.ok = true;
    entry.count = result.counties.length;
  } catch (err) {
    result.error = String(err.message || err);
    entry.error = result.error;
  } finally {
    entry.ms = Date.now() - started;
  }
  return result;
}

async function writeJson(name, data) {
  await writeFile(new URL(name, OUT_DIR), `${JSON.stringify(data, null, 2)}\n`);
}

async function main() {
  const status = [];
  const [newsLists, noticeLists, outages] = await Promise.all([
    Promise.all(NEWS_FEEDS.map((f) => collectFeed(f, status))),
    Promise.all(NOTICE_FEEDS.map((f) => collectFeed(f, status))),
    collectOutages(status),
  ]);

  const newsRaw = newsLists.flat();
  const officialTagged = noticeLists.flat().filter((i) => i.tags.length > 0);
  const news = dedupeAndSort([...newsRaw, ...officialTagged], NEWS_MAX_AGE_DAYS);
  // Notices are official posts plus any news item that mentions a utility/infrastructure issue.
  const notices = dedupeAndSort(
    [...officialTagged, ...newsRaw].filter((i) => i.tags.some((t) => NOTICE_TAGS.has(t))),
    NOTICE_MAX_AGE_DAYS,
  );
  const generatedAt = new Date().toISOString();

  await mkdir(OUT_DIR, { recursive: true });
  await writeJson('news.json', { generatedAt, items: news });
  await writeJson('notices.json', { generatedAt, items: notices });
  await writeJson('outages.json', { generatedAt, ...outages });
  await writeJson('meta.json', {
    generatedAt,
    run: process.env.GITHUB_RUN_ID
      ? { id: process.env.GITHUB_RUN_ID, url: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` }
      : null,
    sources: status.sort((a, b) => a.id.localeCompare(b.id)),
  });

  const failed = status.filter((s) => !s.ok);
  console.log(`news: ${news.length} items, notices: ${notices.length} items, outages: ${outages.ok ? 'ok' : 'failed'}`);
  for (const s of status) console.log(`${s.ok ? 'ok  ' : 'FAIL'} ${s.id} (${s.count} items, ${s.ms} ms)${s.error ? ` - ${s.error}` : ''}`);
  if (failed.length === status.length) {
    console.error('Every source failed; check network access from the runner.');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
