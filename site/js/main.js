import { LOCATION, fetchAlerts, fetchForecast, fetchQpf, fetchDiscussion, fetchRain, fetchObservedRain, fetchGauges, fetchCollected } from './sources.js';
import { FLOOD_LEVELS, renderRainHistory, renderRainProjection, renderGaugeChart, initMap, refreshRadar, renderGaugeMarkers } from './charts.js';

const REFRESH_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const TZ = 'America/New_York';
const NEWS_PAGE = 30;
const NEWS_TAGS = ['flood', 'boil', 'water service', 'main break', 'closure', 'shelter', 'sandbag', 'power', 'health'];

const state = {
  alerts: null,
  rain: null,
  observed: null,
  qpf: null,
  gauges: null,
  outages: null,
  notices: null,
  news: null,
  meta: null,
  newsFilter: 'all',
  newsLimit: NEWS_PAGE,
};
const status = new Map();
let zipGeojson = null;
let mapReady = false;
let lastRefresh = 0;

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtTime = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit', timeZone: TZ });
const fmtDate = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: TZ });
const fmtDayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TZ });
const fmtInt = new Intl.NumberFormat('en-US');

function ago(time) {
  if (!time) return 'unknown';
  const ms = Date.now() - new Date(time).getTime();
  if (ms < 0) return fmtTime.format(new Date(time));
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return fmtDate.format(new Date(time));
}

const inches = (v) => (v == null ? '–' : `${v < 10 ? v.toFixed(2) : v.toFixed(1)} in`);
const feet = (v) => (v == null ? '–' : `${v.toFixed(2)} ft`);

function sumRain(hours, from, to) {
  return hours.filter((h) => h.time > from && h.time <= to).reduce((s, h) => s + h.inches, 0);
}

function sumQpf(periods, from, to) {
  return periods.reduce((s, p) => {
    const overlap = Math.min(p.end, to) - Math.max(p.start, from);
    return overlap > 0 ? s + p.inches * (overlap / (p.end - p.start)) : s;
  }, 0);
}

function setStatus(id, label, { ok = true, time = null, error = null, note = null } = {}) {
  status.set(id, { label, ok, time, error, note });
  renderStatus();
}

const STATUS_ORDER = ['alerts', 'observed', 'rain', 'qpf', 'forecast', 'afd', 'gauges', 'outages', 'notices', 'news', 'meta'];

function renderStatus() {
  $('#status-list').innerHTML = [...status.entries()]
    .sort(([a], [b]) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b))
    .map(([, s]) => s)
    .map((s) => {
      const detail = s.ok ? `${ago(s.time)}${s.note ? ` · ${s.note}` : ''}` : 'failed';
      const title = s.error ? ` title="${esc(s.error)}"` : '';
      return `<li class="status ${s.ok ? (s.note ? 'warn' : 'ok') : 'err'}"${title}><span>${esc(s.label)}</span> ${esc(detail)}</li>`;
    })
    .join('');
}

function errorHtml(what, err) {
  return `<p class="error">Couldn't load ${esc(what)} (${esc(err?.message ?? err)}). It will retry automatically.</p>`;
}

// ---------- alerts ----------

const SEVERITY_CLASS = { Extreme: 'extreme', Severe: 'severe', Moderate: 'moderate', Minor: 'minor' };

function renderAlerts() {
  const local = state.alerts.filter((a) => a.local);
  const other = state.alerts.filter((a) => !a.local);
  $('#alerts-local').innerHTML = local.length
    ? local
        .map(
          (a) => `<article class="alert ${SEVERITY_CLASS[a.severity] ?? 'minor'}">
            <div class="alert-head"><strong>${esc(a.event)}</strong><span>until ${esc(fmtTime.format(new Date(a.ends)))}</span></div>
            <p>${esc(a.headline)}</p>
            <details><summary>Details &amp; instructions</summary>
              <p class="pre">${esc(reflow(a.description ?? ''))}</p>${a.instruction ? `<p class="pre"><strong>What to do:</strong> ${esc(reflow(a.instruction))}</p>` : ''}
            </details>
          </article>`,
        )
        .join('')
    : '<p class="alert none">No active NWS alerts for ZIP 32909 right now.</p>';

  const box = $('#alerts-other');
  box.hidden = other.length === 0;
  box.querySelector('summary').textContent = `${other.length} other alert${other.length === 1 ? '' : 's'} elsewhere in Brevard County`;
  box.querySelector('ul').innerHTML = other
    .map((a) => `<li><strong>${esc(a.event)}</strong> until ${esc(fmtTime.format(new Date(a.ends)))} · <span class="muted">${esc(a.areaDesc)}</span></li>`)
    .join('');
}

// ---------- at a glance ----------

function categoryFor(g) {
  if (!g.latest) return null;
  const defined = FLOOD_LEVELS.filter((l) => g.categories[l.key] != null);
  if (!defined.length) return null;
  const hit = [...defined].reverse().find((l) => g.latest.value >= g.categories[l.key]);
  return hit ?? { key: 'normal', label: 'Below flood stage', color: '--ok' };
}

function card(label, value, sub = '', tone = '') {
  return `<div class="glance-card ${tone}"><span class="glance-label">${esc(label)}</span><span class="glance-value">${esc(value)}</span><span class="glance-sub">${sub}</span></div>`;
}

function activeBoilNotices() {
  const cutoff = Date.now() - 7 * DAY_MS;
  return (state.notices?.items ?? []).filter((i) => i.tags.includes('boil') && !i.lifted && Date.parse(i.published ?? 0) > cutoff);
}

function rainTone(v) {
  if (v >= 6) return 'tone-bad';
  if (v >= 2) return 'tone-warn';
  return '';
}

function renderGlance() {
  const now = Date.now();
  const cards = [];

  const past = pastRain();
  if (past) {
    const r24 = sumRain(past.hours, now - DAY_MS, now);
    const r72 = sumRain(past.hours, now - 3 * DAY_MS, now);
    cards.push(card('Rain, last 24 h', inches(r24), esc(past.label), rainTone(r24)));
    cards.push(card('Rain, last 72 h', inches(r72), esc(past.label), rainTone(r72)));
  }
  if (state.rain) {
    const h = state.rain.hours;
    const om48 = sumRain(h, now, now + 2 * DAY_MS);
    if (state.qpf) {
      const nws48 = sumQpf(state.qpf.periods, now, now + 2 * DAY_MS);
      cards.push(card('Rain, next 48 h', inches(nws48), `NWS forecast · Open-Meteo ${esc(inches(om48))}`, rainTone(nws48)));
    } else {
      cards.push(card('Rain, next 48 h', inches(om48), 'Open-Meteo forecast', rainTone(om48)));
    }
  } else {
    cards.push(card('Rainfall', '…', 'loading'));
  }

  if (state.gauges) {
    for (const g of state.gauges.filter((x) => x.key || Object.keys(x.categories).length)) {
      if (!g.latest) {
        cards.push(card(g.name, 'No data', 'gauge not reporting'));
        continue;
      }
      const cat = categoryFor(g);
      const change = g.change24h == null ? '' : ` · ${g.change24h >= 0 ? '▲' : '▼'} ${Math.abs(g.change24h).toFixed(2)} ft in 24 h`;
      const vs = cat
        ? `${esc(cat.label)}${g.categories.minor != null ? ` (minor flood ${g.categories.minor} ft)` : ''}`
        : 'No NWS flood stage defined';
      const tone = cat && cat.key !== 'normal' ? (cat.key === 'action' ? 'tone-warn' : 'tone-bad') : '';
      cards.push(card(g.name, feet(g.latest.value), `${vs}${esc(change)}`, tone));
    }
  }

  const o = state.outages;
  if (o?.ok && o.counties?.length) {
    const brevard = o.counties.find((c) => c.county === 'Brevard') ?? o.counties[0];
    cards.push(card(`FPL outages, ${brevard.county} County`, fmtInt.format(brevard.out), `${brevard.percent?.toFixed(2) ?? '–'}% of ${fmtInt.format(brevard.served)} customers`, brevard.out > 5000 ? 'tone-bad' : brevard.out > 500 ? 'tone-warn' : ''));
  } else if (o) {
    cards.push(card('Power outages', 'See FPL map', `<a href="${esc(o.links?.fplMap ?? 'https://www.fplmaps.com/')}" target="_blank" rel="noopener">FPL outage map</a>`));
  }

  if (state.notices) {
    const boil = activeBoilNotices();
    const water = (state.notices.items ?? []).filter((i) => i.tags.includes('water service') && Date.parse(i.published ?? 0) > now - 3 * DAY_MS);
    cards.push(card('Boil-water notices, last 7 days', String(boil.length), water.length ? `${water.length} water-service report${water.length === 1 ? '' : 's'} in 72 h` : 'from city, DOH and news', boil.length ? 'tone-bad' : ''));
  }

  $('#glance').innerHTML = cards.join('');
}

// ---------- rain ----------

// Radar-estimated rain is preferred for the past; Open-Meteo's model is the fallback.
function pastRain() {
  const now = Date.now();
  if (state.observed?.hours.length) return { hours: state.observed.hours, label: 'radar estimate (IEM/MRMS)', observed: true };
  if (state.rain) return { hours: state.rain.hours.filter((h) => h.time <= now), label: 'Open-Meteo model', observed: false };
  return null;
}

function renderRain() {
  const now = Date.now();
  const past = pastRain();
  if (past) {
    $('#rain-history-source').textContent = past.observed ? 'radar estimate (IEM/MRMS), dashed line = Open-Meteo model' : 'Open-Meteo model (radar estimate unavailable)';
    renderRainHistory($('#rain-history'), past.hours, { label: past.observed ? 'radar estimate' : 'Open-Meteo', modelHours: past.observed && state.rain ? state.rain.hours : null });
  }
  if (!state.rain) return;
  const hours = state.rain.hours;
  renderRainProjection($('#rain-projection'), hours.filter((h) => h.time > now), state.qpf);

  // Hourly values are totals for the hour ending at `time`.
  const byDay = new Map();
  const add = (h) => {
    const key = fmtDayKey.format(new Date(h.time - 1));
    byDay.set(key, (byDay.get(key) ?? 0) + h.inches);
  };
  const firstObserved = past?.observed ? past.hours[0]?.time ?? now : now;
  hours.filter((h) => h.time < firstObserved || h.time > now).forEach(add);
  if (past?.observed) past.hours.forEach(add);
  const today = fmtDayKey.format(new Date());
  const keys = [...byDay.keys()].sort();
  $('#daily-rain').innerHTML = `<h3>Daily totals <span class="muted small">(past: ${esc(past?.label ?? 'Open-Meteo')}; future: Open-Meteo forecast)</span></h3><ol class="day-list">${keys
    .map((key) => [key, byDay.get(key)])
    .map(([key, total]) => {
      const date = new Date(`${key}T12:00:00`);
      const cls = key === today ? 'today' : key < today ? 'past' : 'future';
      const tone = total >= 4 ? 'tone-bad' : total >= 1.5 ? 'tone-warn' : '';
      return `<li class="${cls} ${tone}"><span>${esc(fmtDate.format(date))}</span><strong>${esc(inches(total))}</strong></li>`;
    })
    .join('')}</ol>`;
}

// ---------- gauges ----------

function gaugePopup(g) {
  const cat = categoryFor(g);
  return `<strong>${esc(g.name)}</strong><br>${g.latest ? `${esc(feet(g.latest.value))} at ${esc(fmtTime.format(new Date(g.latest.time)))}` : 'No recent data'}<br>${esc(cat ? cat.label : 'No NWS flood stage defined')}<br><a href="${esc(g.links.usgs ?? g.links.nwps)}" target="_blank" rel="noopener">Gauge page</a>`;
}

function categoryColor(g) {
  const cat = categoryFor(g);
  if (!cat) return css('--water');
  return css(cat.color);
}

function stageKey(g) {
  const levels = FLOOD_LEVELS.filter((l) => g.categories[l.key] != null);
  if (!levels.length) return '';
  return `<p class="stage-key small">${levels.map((l) => `<span style="--key:var(${l.color})">${esc(l.label)} ${esc(g.categories[l.key])} ft</span>`).join('')}</p>`;
}

function renderGauges() {
  const container = $('#gauges');
  container.innerHTML = state.gauges
    .map((g) => {
      const cat = categoryFor(g);
      const badge = cat ? `<span class="badge" style="--badge:var(${cat.color})">${esc(cat.label)}</span>` : '<span class="badge muted-badge">No NWS flood stage</span>';
      const change = g.change24h == null ? '' : `<span class="change ${g.change24h > 0.05 ? 'up' : g.change24h < -0.05 ? 'down' : ''}">${g.change24h >= 0 ? '▲' : '▼'} ${Math.abs(g.change24h).toFixed(2)} ft / 24 h</span>`;
      return `<figure class="gauge-card" id="gauge-${esc(g.id)}">
        <figcaption>
          <div class="gauge-title"><strong>${esc(g.name)}</strong>${badge}</div>
          <div class="gauge-now">${g.latest ? `<span class="gauge-value">${esc(feet(g.latest.value))}</span> ${change}<span class="muted small">${esc(fmtTime.format(new Date(g.latest.time)))}${g.datum ? ` · ${esc(g.datum)} datum` : ''}</span>` : '<span class="muted">No readings in the last 7 days</span>'}</div>
        </figcaption>
        ${g.series.length ? '<div class="chart-box small-chart"><canvas></canvas></div>' : ''}
        ${stageKey(g)}
        <div class="gauge-links small">${g.links.usgs ? `<a href="${esc(g.links.usgs)}" target="_blank" rel="noopener">USGS ${esc(g.usgs)}</a> · ` : ''}<a href="${esc(g.links.nwps)}" target="_blank" rel="noopener">NWS ${esc(g.nwps)}</a></div>
      </figure>`;
    })
    .join('');
  for (const g of state.gauges) {
    const canvas = container.querySelector(`#gauge-${g.id} canvas`);
    if (canvas) renderGaugeChart(canvas, g);
  }
  if (mapReady) renderGaugeMarkers(state.gauges, { categoryColor, popupHtml: gaugePopup });
}

// ---------- outlook ----------

function renderForecast(forecast) {
  $('#forecast-updated').textContent = `· updated ${ago(forecast.updated)}`;
  $('#forecast').innerHTML = forecast.periods
    .slice(0, 8)
    .map(
      (p) => `<li>
        <details>
          <summary><strong>${esc(p.name)}</strong> <span class="pop" title="Chance of rain">${p.pop == null ? '' : `${esc(p.pop)}% rain`}</span><span class="muted">${esc(p.shortForecast)} · ${esc(p.temperature)}°${esc(p.temperatureUnit)}</span></summary>
          <p>${esc(p.detailedForecast)}</p>
        </details>
      </li>`,
    )
    .join('');
}

function renderOutlookSummary() {
  const el = $('#outlook-summary') ?? (() => {
    const div = document.createElement('div');
    div.id = 'outlook-summary';
    div.className = 'outlook-summary';
    $('#outlook-title').after(div);
    return div;
  })();
  const now = Date.now();
  const lines = [];
  for (const a of (state.alerts ?? []).filter((x) => x.local)) {
    lines.push(`<li><strong>${esc(a.event)}</strong> in effect until <strong>${esc(fmtTime.format(new Date(a.ends)))}</strong></li>`);
  }
  if (state.qpf) {
    const periods = state.qpf.periods;
    const end = Math.max(...periods.map((p) => p.end));
    const next = (ms) => inches(sumQpf(periods, now, Math.min(now + ms, end)));
    lines.push(`<li>NWS forecast rain: <strong>${esc(next(DAY_MS))}</strong> next 24 h, <strong>${esc(next(2 * DAY_MS))}</strong> next 48 h, <strong>${esc(inches(sumQpf(periods, now, end)))}</strong> through ${esc(fmtDate.format(new Date(end)))}.</li>`);
    const wet = periods.filter((p) => p.end > now && p.inches >= 0.1);
    lines.push(
      wet.length
        ? `<li>NWS expects measurable rain (≥ 0.1 in per period) until about <strong>${esc(fmtTime.format(new Date(wet.at(-1).end)))}</strong>.</li>`
        : '<li>NWS forecasts no period with ≥ 0.1 in of rain ahead.</li>',
    );
  }
  if (state.rain) {
    const h = state.rain.hours;
    const next = (ms) => inches(sumRain(h, now, now + ms));
    lines.push(`<li class="muted">Open-Meteo model for comparison: ${esc(next(DAY_MS))} next 24 h, ${esc(next(7 * DAY_MS))} next 7 days (models can badly underestimate tropical downpours).</li>`);
  }
  el.innerHTML = lines.length ? `<ul>${lines.join('')}</ul>` : '';
}

// NWS products are hard-wrapped at ~70 columns; join wrapped lines but keep blank lines and bullets.
const reflow = (text) => text.replace(/\n(?!\n)(?!\s*[-*] )\s*/g, ' ');

const AFD_SKIP = /^(AVIATION|MARINE|FIRE WEATHER|PRELIMINARY POINT TEMPS\/POPS|MLB WATCHES\/WARNINGS\/ADVISORIES|WATCHES\/WARNINGS\/ADVISORIES)/;

function renderDiscussion(afd) {
  $('#afd-updated').textContent = `· issued ${ago(afd.issued)}`;
  const sections = afd.sections.filter((s) => !AFD_SKIP.test(s.title));
  const key = sections.find((s) => s.title.startsWith('KEY MESSAGES'));
  const rest = sections.filter((s) => s !== key);
  $('#afd').innerHTML = `${key ? `<div class="key-messages"><h4>Key messages</h4><p class="pre">${esc(reflow(key.text))}</p></div>` : ''}
    ${rest.map((s) => `<details><summary>${esc(s.title.toLowerCase())}</summary><p class="pre">${esc(reflow(s.text))}</p></details>`).join('')}
    <p class="small"><a href="${esc(afd.url)}" target="_blank" rel="noopener">Full discussion on weather.gov</a></p>`;
}

// ---------- utilities & news ----------

function itemHtml(i) {
  const tags = i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('');
  return `<li><a href="${esc(safeUrl(i.link))}" target="_blank" rel="noopener">${esc(i.title)}</a>
    <div class="meta">${esc(i.source)} · ${esc(i.published ? ago(i.published) : 'undated')}${i.lifted ? ' · <span class="tag ok">lifted / resolved</span>' : ''} ${tags}</div></li>`;
}

const UTILITY_GROUPS = [
  { title: 'Boil-water notices & water service', tags: ['boil', 'water service'] },
  { title: 'Water main breaks', tags: ['main break'] },
  { title: 'Road closures', tags: ['closure'] },
  { title: 'Shelters & sandbags', tags: ['shelter', 'sandbag'] },
  { title: 'Health advisories', tags: ['health'] },
];

function outageHtml() {
  const o = state.outages;
  if (!o) return '<p class="loading">Loading…</p>';
  const links = `<p class="small"><a href="${esc(o.links.fplMap)}" target="_blank" rel="noopener">FPL outage map</a> · <a href="${esc(o.links.powerOutageUs)}" target="_blank" rel="noopener">PowerOutage.us</a></p>`;
  const table = o.ok
    ? `<table class="outage-table"><thead><tr><th>County</th><th>Out</th><th>Served</th><th>%</th></tr></thead><tbody>${o.counties
        .map((c) => `<tr><td>${esc(c.county)}</td><td>${esc(fmtInt.format(c.out))}</td><td>${esc(fmtInt.format(c.served))}</td><td>${esc(c.percent?.toFixed(2) ?? '–')}</td></tr>`)
        .join('')}</tbody></table><p class="muted small">FPL updated ${esc(ago(o.sourceUpdated ?? o.generatedAt))}. FPL publishes county totals only.</p>`
    : `<p class="error small">FPL outage data unavailable (${esc(o.error)}). Showing outage news instead.</p>`;
  const power = (state.news?.items ?? []).filter((i) => i.tags.includes('power')).slice(0, 4);
  return `${table}${power.length ? `<ul class="item-list">${power.map(itemHtml).join('')}</ul>` : ''}${links}`;
}

function renderUtilities() {
  const items = state.notices?.items ?? [];
  const n = state.notices;
  $('#notices-note').innerHTML = n
    ? `Keyword-matched from the City of Palm Bay, DOH-Brevard and local news, collected ${esc(ago(n.generatedAt))}${n.sample ? ' (<strong>sample data</strong>)' : ''}. Always confirm with the linked source.`
    : '';
  const groups = UTILITY_GROUPS.map((g) => {
    const matches = items.filter((i) => i.tags.some((t) => g.tags.includes(t))).slice(0, 5);
    return `<div class="utility"><h3>${esc(g.title)}</h3>${matches.length ? `<ul class="item-list">${matches.map(itemHtml).join('')}</ul>` : '<p class="muted small">Nothing reported in the last 30 days.</p>'}</div>`;
  });
  groups.splice(3, 0, `<div class="utility"><h3>Power</h3>${outageHtml()}</div>`);
  $('#utilities').innerHTML = groups.join('');
}

function renderNews() {
  const items = state.news?.items ?? [];
  const counts = Object.fromEntries(NEWS_TAGS.map((t) => [t, items.filter((i) => i.tags.includes(t)).length]));
  const chips = [['all', items.length], ...NEWS_TAGS.filter((t) => counts[t]).map((t) => [t, counts[t]])];
  $('#news-filters').innerHTML = chips
    .map(([t, c]) => `<button type="button" class="chip" data-tag="${esc(t)}" aria-pressed="${state.newsFilter === t}">${esc(t === 'all' ? 'All' : t)} <span>${c}</span></button>`)
    .join('');
  const filtered = state.newsFilter === 'all' ? items : items.filter((i) => i.tags.includes(state.newsFilter));
  $('#news').innerHTML = filtered.length
    ? filtered.slice(0, state.newsLimit).map(itemHtml).join('')
    : '<li class="muted">No items.</li>';
  const more = $('#news-more');
  more.hidden = filtered.length <= state.newsLimit;
  more.textContent = `Show more (${filtered.length - state.newsLimit} more)`;
}

// ---------- loading ----------

async function load(id, label, fn, onOk, onErr) {
  try {
    const result = await fn();
    onOk(result);
    return result;
  } catch (err) {
    console.error(label, err);
    setStatus(id, label, { ok: false, error: String(err?.message ?? err) });
    onErr?.(err);
    return null;
  }
}

function collectedNote(data, ids) {
  if (data.sample) return 'sample data';
  const feeds = (state.meta?.sources ?? []).filter((s) => ids(s));
  const failed = feeds.filter((s) => !s.ok);
  return failed.length ? `${failed.length}/${feeds.length} feeds failed` : null;
}

async function refreshCollected() {
  await load('meta', 'Collector', () => fetchCollected('meta'), (m) => { state.meta = m; });
  const isNotice = (s) => ['palm-bay-city', 'doh-brevard', 'gn-palm-bay-city', 'gn-brevard-em'].includes(s.id);
  await Promise.all([
    load('news', 'News', () => fetchCollected('news'), (d) => {
      state.news = d;
      setStatus('news', 'News', { time: d.generatedAt, note: collectedNote(d, (s) => s.kind === 'rss' && !isNotice(s)) });
      renderNews();
    }, (err) => { $('#news').innerHTML = `<li>${errorHtml('news', err)}</li>`; }),
    load('notices', 'Notices', () => fetchCollected('notices'), (d) => {
      state.notices = d;
      setStatus('notices', 'City/county notices', { time: d.generatedAt, note: collectedNote(d, isNotice) });
    }),
    load('outages', 'FPL outages', () => fetchCollected('outages'), (d) => {
      state.outages = d;
      setStatus('outages', 'FPL outages', { ok: true, time: d.sourceUpdated ?? d.generatedAt, note: d.sample ? 'sample data' : d.ok ? null : 'unavailable' });
    }),
  ]);
  if (state.meta?.sources) {
    const failed = state.meta.sources.filter((s) => !s.ok);
    const el = $('#status-list');
    el.title = failed.length ? `Failed feeds: ${failed.map((s) => `${s.name} (${s.error})`).join('; ')}` : '';
  }
  renderUtilities();
  renderGlance();
}

async function refreshLive() {
  const zip = zipGeojson;
  await Promise.all([
    load('alerts', 'NWS alerts', () => fetchAlerts(zip), (a) => {
      state.alerts = a;
      setStatus('alerts', 'NWS alerts', { time: Date.now() });
      renderAlerts();
    }, (err) => { $('#alerts-local').innerHTML = errorHtml('NWS alerts', err); }),
    load('rain', 'Open-Meteo rain', fetchRain, (r) => {
      state.rain = r;
      setStatus('rain', 'Open-Meteo rain', { time: Date.now() });
    }, (err) => { $('#daily-rain').innerHTML = errorHtml('rainfall', err); }),
    load('observed', 'Radar rain estimate', fetchObservedRain, (o) => {
      state.observed = o;
      setStatus('observed', 'Radar rain estimate', { time: o.hours.at(-1)?.time ?? null, note: o.missingDays ? `${o.missingDays} day(s) missing` : null });
    }),
    load('qpf', 'NWS rain forecast', fetchQpf, (q) => {
      state.qpf = q;
      setStatus('qpf', 'NWS rain forecast', { time: q.updated });
    }),
    load('forecast', 'NWS forecast', fetchForecast, (f) => {
      renderForecast(f);
      setStatus('forecast', 'NWS forecast', { time: f.updated });
    }, (err) => { $('#forecast').innerHTML = `<li>${errorHtml('the forecast', err)}</li>`; }),
    load('afd', 'Forecast discussion', fetchDiscussion, (d) => {
      renderDiscussion(d);
      setStatus('afd', 'Forecast discussion', { time: d.issued });
    }, (err) => { $('#afd').innerHTML = errorHtml('the forecast discussion', err); }),
    load('gauges', 'Gauges', fetchGauges, (g) => {
      state.gauges = g;
      const latest = Math.max(...g.filter((x) => x.latest).map((x) => x.latest.time));
      const missing = g.filter((x) => !x.latest).length;
      setStatus('gauges', 'Gauges', { time: Number.isFinite(latest) ? latest : null, note: missing ? `${missing} not reporting` : null });
      renderGauges();
    }, (err) => { $('#gauges').innerHTML = errorHtml('gauges', err); }),
  ]);
  if (state.rain || state.observed) renderRain();
  renderOutlookSummary();
  renderGlance();
}

async function refreshAll() {
  lastRefresh = Date.now();
  const btn = $('#refresh');
  btn.disabled = true;
  btn.textContent = 'Refreshing…';
  refreshRadar();
  await Promise.all([refreshLive(), refreshCollected()]);
  btn.disabled = false;
  btn.textContent = 'Refresh now';
}

async function init() {
  try {
    zipGeojson = await (await fetch('assets/zip-32909.geojson')).json();
  } catch (err) {
    console.error('ZIP outline', err);
    zipGeojson = { type: 'FeatureCollection', features: [] };
  }
  if (window.L) {
    initMap($('#map'), { center: LOCATION, zipGeojson });
    mapReady = true;
  } else {
    $('#map').innerHTML = '<p class="error">Map library failed to load.</p>';
  }

  $('#refresh').addEventListener('click', refreshAll);
  $('#news-filters').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    state.newsFilter = chip.dataset.tag;
    state.newsLimit = NEWS_PAGE;
    renderNews();
  });
  $('#news-more').addEventListener('click', () => {
    state.newsLimit += NEWS_PAGE;
    renderNews();
  });
  $('.radar-loop').addEventListener('toggle', (e) => {
    const img = e.target.querySelector('img');
    if (e.target.open) img.src = `${img.dataset.src}?t=${Date.now()}`;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - lastRefresh > REFRESH_MS) refreshAll();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshAll();
  }, REFRESH_MS);
  setInterval(renderStatus, 60_000);

  await refreshAll();
}

init();
