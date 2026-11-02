// Live sources fetched straight from the browser. All of these send CORS headers.

export const LOCATION = { lat: 27.904, lon: -80.655, label: 'Palm Bay, FL 32909' };

// Confirmed via api.weather.gov/points for points across the ZIP outline.
export const NWS = { office: 'MLB', gridX: 57, gridY: 43, zones: ['FLZ547', 'FLZ647'], county: 'FLC009' };

// USGS site IDs and NWPS gauge IDs (lid). NWPS only defines flood categories for MEIF1 near Palm Bay;
// the rest are charted without a flood line until NWS adds one.
export const GAUGES = [
  { id: 'turkey-creek', name: 'Turkey Creek at Palm Bay', usgs: '02250030', nwps: 'TRKF1', lat: 28.01724, lon: -80.59589, key: true },
  { id: 'indian-river', name: 'Indian River at Melbourne', nwps: 'MEIF1', lat: 28.08361, lon: -80.59194, datum: 'MHHW' },
  { id: 'st-johns', name: 'St. Johns River near Melbourne', usgs: '02232000', nwps: 'MELF1', lat: 28.08474, lon: -80.752 },
  { id: 'crane-creek', name: 'Crane Creek at Melbourne', usgs: '02249500', nwps: 'CCMF1', lat: 28.07917, lon: -80.62972 },
  { id: 'st-sebastian', name: 'N. Prong St. Sebastian River near Micco', usgs: '02251500', nwps: 'MICF1', lat: 27.85614, lon: -80.52422 },
];

const NWS_API = 'https://api.weather.gov';
const NWS_HEADERS = { accept: 'application/geo+json' };
const DAY_MS = 86_400_000;

async function getJson(url, init = {}) {
  const res = await fetch(url, { cache: 'no-cache', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

// ---------- NWS alerts ----------

function pointInRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function segmentsCross(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function outerRings(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates[0]];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates.map((poly) => poly[0]);
  return [];
}

function ringsIntersect(a, b) {
  if (a.some((p) => pointInRing(p, b)) || b.some((p) => pointInRing(p, a))) return true;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      if (segmentsCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
    }
  }
  return false;
}

// Beach and marine products share a forecast zone with the ZIP's eastern edge but don't apply inland.
const COASTAL_ONLY = /rip current|high surf|beach hazards|small craft|marine|gale|hazardous seas/i;

function alertAffectsZip(feature, zipRings) {
  if (COASTAL_ONLY.test(feature.properties.event)) return false;
  const alertRings = outerRings(feature.geometry);
  if (alertRings.length) return alertRings.some((ar) => zipRings.some((zr) => ringsIntersect(ar, zr)));
  const zones = feature.properties.affectedZones ?? [];
  return zones.some((z) => NWS.zones.some((code) => z.endsWith(`/${code}`)));
}

const SEVERITY_RANK = { Extreme: 0, Severe: 1, Moderate: 2, Minor: 3, Unknown: 4 };

export async function fetchAlerts(zipGeojson) {
  const zones = [...NWS.zones, NWS.county].join(',');
  const data = await getJson(`${NWS_API}/alerts/active?zone=${zones}`, { headers: NWS_HEADERS });
  const zipRings = zipGeojson.features.flatMap((f) => outerRings(f.geometry));
  const alerts = data.features.map((f) => ({
    id: f.id,
    event: f.properties.event,
    severity: f.properties.severity,
    urgency: f.properties.urgency,
    headline: f.properties.headline,
    description: f.properties.description,
    instruction: f.properties.instruction,
    areaDesc: f.properties.areaDesc,
    onset: f.properties.onset || f.properties.effective,
    ends: f.properties.ends || f.properties.expires,
    geometry: f.geometry,
    local: alertAffectsZip(f, zipRings),
  }));
  alerts.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9) || Date.parse(b.onset) - Date.parse(a.onset));
  return alerts;
}

// ---------- NWS forecast, QPF and Area Forecast Discussion ----------

const gridUrl = `${NWS_API}/gridpoints/${NWS.office}/${NWS.gridX},${NWS.gridY}`;

export async function fetchForecast() {
  const data = await getJson(`${gridUrl}/forecast`, { headers: NWS_HEADERS });
  return {
    updated: data.properties.updateTime || data.properties.generatedAt,
    periods: data.properties.periods.map((p) => ({
      name: p.name,
      start: p.startTime,
      isDaytime: p.isDaytime,
      temperature: p.temperature,
      temperatureUnit: p.temperatureUnit,
      pop: p.probabilityOfPrecipitation?.value ?? null,
      shortForecast: p.shortForecast,
      detailedForecast: p.detailedForecast,
      wind: `${p.windDirection} ${p.windSpeed}`,
    })),
  };
}

// "2026-11-02T12:00:00+00:00/PT6H" -> { start, hours }
function parseValidTime(validTime) {
  const [start, duration] = validTime.split('/');
  const m = /P(?:(\d+)D)?T?(?:(\d+)H)?/.exec(duration);
  const hours = (Number(m?.[1] ?? 0) * 24) + Number(m?.[2] ?? 0);
  return { start: Date.parse(start), hours: hours || 1 };
}

export async function fetchQpf() {
  const data = await getJson(gridUrl, { headers: NWS_HEADERS });
  const qpf = data.properties.quantitativePrecipitation;
  const toInches = qpf.uom.endsWith('mm') ? 1 / 25.4 : 1;
  return {
    updated: data.properties.updateTime,
    periods: qpf.values.map((v) => {
      const { start, hours } = parseValidTime(v.validTime);
      return { start, end: start + hours * 3_600_000, inches: (v.value ?? 0) * toInches };
    }),
  };
}

export async function fetchDiscussion() {
  const list = await getJson(`${NWS_API}/products/types/AFD/locations/${NWS.office}`);
  const latest = list['@graph']?.[0];
  if (!latest) throw new Error('No Area Forecast Discussion found');
  const product = await getJson(`${NWS_API}/products/${latest.id}`);
  const text = product.productText.replace(/\r/g, '');
  const sections = [];
  const re = /^\.([A-Z][A-Z0-9 /&-]+?)\.\.\.\s*$/gm;
  const marks = [...text.matchAll(re)];
  marks.forEach((m, i) => {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].index : text.length;
    const body = text.slice(bodyStart, bodyEnd).replace(/\n&&[\s\S]*$/, '').replace(/^\s*Issued at .*\n/, '').trim();
    if (body) sections.push({ title: m[1].trim(), text: body });
  });
  return { issued: latest.issuanceTime, url: `https://forecast.weather.gov/product.php?site=${NWS.office}&issuedby=${NWS.office}&product=AFD`, sections };
}

// ---------- Open-Meteo hourly rain ----------

export async function fetchRain() {
  const params = new URLSearchParams({
    latitude: LOCATION.lat,
    longitude: LOCATION.lon,
    hourly: 'precipitation,precipitation_probability',
    past_days: '7',
    forecast_days: '7',
    precipitation_unit: 'inch',
    timezone: 'America/New_York',
    timeformat: 'unixtime',
  });
  const data = await getJson(`https://api.open-meteo.com/v1/forecast?${params}`);
  const h = data.hourly;
  return {
    hours: h.time.map((t, i) => ({
      time: t * 1000,
      inches: h.precipitation[i] ?? 0,
      probability: h.precipitation_probability?.[i] ?? null,
    })),
  };
}

// ---------- Observed (radar-estimated) rain: IEM reanalysis hourly, MRMS-based ----------
// Open-Meteo's model badly underestimates tropical downpours (≈1 in vs ≈11 in observed on Nov 2, 2026),
// so past rainfall comes from IEM's radar/gauge estimate at the ZIP centroid.

const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'America/New_York' });

export async function fetchObservedRain(days = 7) {
  const now = Date.now();
  const dates = Array.from({ length: days + 1 }, (_, i) => dayKey.format(new Date(now - (days - i) * DAY_MS)));
  const results = await Promise.allSettled(
    [...new Set(dates)].map((d) => getJson(`https://mesonet.agron.iastate.edu/iemre/hourly/${d}/${LOCATION.lat}/${LOCATION.lon}/json`)),
  );
  const ok = results.filter((r) => r.status === 'fulfilled');
  if (!ok.length) throw results[0].reason;
  // IEM fills hours after "now" with model guidance; only keep hours that have already ended.
  const hours = ok
    .flatMap((r) => r.value.data)
    .map((h) => ({ time: Date.parse(h.valid_utc) + 3_600_000, inches: h.hourly_precip_in ?? 0 }))
    .filter((h) => h.time <= now && h.time > now - days * DAY_MS)
    .sort((a, b) => a.time - b.time);
  return { hours, missingDays: results.length - ok.length };
}

// ---------- Water levels: USGS IV + NWPS flood categories ----------

const NO_STAGE = -9000;

async function fetchNwpsGauge(lid) {
  const g = await getJson(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}`);
  const categories = {};
  for (const [name, c] of Object.entries(g.flood?.categories ?? {})) {
    if (c.stage != null && c.stage > NO_STAGE) categories[name] = c.stage;
  }
  const observed = g.status?.observed ?? {};
  return {
    categories,
    floodCategory: observed.floodCategory ?? null,
    url: `https://water.noaa.gov/gauges/${lid.toLowerCase()}`,
  };
}

async function fetchNwpsSeries(lid, sinceMs) {
  const data = await getJson(`https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow/observed`);
  return (data.data ?? [])
    .map((d) => ({ time: Date.parse(d.validTime), value: d.primary }))
    .filter((d) => d.time >= sinceMs && d.value > NO_STAGE);
}

async function fetchUsgsSeries(siteIds) {
  const params = new URLSearchParams({ format: 'json', sites: siteIds.join(','), parameterCd: '00065', period: 'P7D', siteStatus: 'all' });
  const data = await getJson(`https://waterservices.usgs.gov/nwis/iv/?${params}`);
  const bySite = {};
  for (const ts of data.value.timeSeries) {
    const site = ts.sourceInfo.siteCode[0].value;
    const noData = Number(ts.variable.noDataValue);
    const values = ts.values.find((v) => v.value.length)?.value ?? [];
    const series = values
      .map((v) => ({ time: Date.parse(v.dateTime), value: Number(v.value) }))
      .filter((v) => Number.isFinite(v.value) && v.value !== noData);
    if (!bySite[site] || series.length > bySite[site].length) bySite[site] = series;
  }
  return bySite;
}

export async function fetchGauges() {
  const since = Date.now() - 7 * DAY_MS;
  const usgsIds = GAUGES.filter((g) => g.usgs).map((g) => g.usgs);
  const [usgs, ...rest] = await Promise.allSettled([
    fetchUsgsSeries(usgsIds),
    ...GAUGES.map((g) => fetchNwpsGauge(g.nwps)),
    ...GAUGES.map((g) => (g.usgs ? Promise.resolve(null) : fetchNwpsSeries(g.nwps, since))),
  ]);
  const nwpsMeta = rest.slice(0, GAUGES.length);
  const nwpsSeries = rest.slice(GAUGES.length);
  if (usgs.status === 'rejected' && nwpsSeries.every((s) => s.status !== 'fulfilled' || !s.value)) throw usgs.reason;

  return GAUGES.map((g, i) => {
    const meta = nwpsMeta[i].status === 'fulfilled' ? nwpsMeta[i].value : null;
    const series = g.usgs ? (usgs.status === 'fulfilled' ? usgs.value[g.usgs] ?? [] : []) : nwpsSeries[i].value ?? [];
    const latest = series.at(-1) ?? null;
    const dayAgo = latest ? [...series].reverse().find((p) => p.time <= latest.time - DAY_MS) : null;
    return {
      ...g,
      series,
      latest,
      change24h: latest && dayAgo ? latest.value - dayAgo.value : null,
      categories: meta?.categories ?? {},
      floodCategory: meta?.floodCategory ?? null,
      links: {
        usgs: g.usgs ? `https://waterdata.usgs.gov/monitoring-location/${g.usgs}/` : null,
        nwps: meta?.url ?? `https://water.noaa.gov/gauges/${g.nwps.toLowerCase()}`,
      },
      error: series.length ? null : 'No recent readings',
    };
  });
}

// ---------- Collected JSON (written by scripts/collect.mjs in CI) ----------

export async function fetchCollected(name) {
  try {
    return { ...(await getJson(`data/${name}.json`)), sample: false };
  } catch {
    return { ...(await getJson(`data/sample/${name}.json`)), sample: true };
  }
}
