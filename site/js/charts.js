// Chart.js charts and the Leaflet map. Both libraries load as globals from the CDN <script> tags.

const { Chart, L } = window;
const HOUR_MS = 3_600_000;
const charts = new Map();

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmtHour = new Intl.DateTimeFormat('en-US', { weekday: 'short', hour: 'numeric', timeZone: 'America/New_York' });
const fmtHourOnly = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'America/New_York' });
const fmtDay = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'numeric', day: 'numeric', timeZone: 'America/New_York' });
const fmtFull = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

export const FLOOD_LEVELS = [
  { key: 'action', label: 'Action', color: '--flood-action' },
  { key: 'minor', label: 'Minor flood', color: '--flood-minor' },
  { key: 'moderate', label: 'Moderate flood', color: '--flood-moderate' },
  { key: 'major', label: 'Major flood', color: '--flood-major' },
];

function baseOptions() {
  const text = css('--text-muted');
  const grid = css('--grid');
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: text, boxWidth: 12, usePointStyle: true } },
      tooltip: { callbacks: {} },
    },
    scales: {
      x: { ticks: { color: text, maxRotation: 0, autoSkipPadding: 16 }, grid: { color: grid } },
      y: { ticks: { color: text }, grid: { color: grid }, beginAtZero: true },
    },
  };
}

function draw(canvas, config) {
  charts.get(canvas)?.destroy();
  charts.set(canvas, new Chart(canvas, config));
}

function cumulative(values) {
  let sum = 0;
  return values.map((v) => (sum += v));
}

function rainChart(canvas, hours, { cumulativeLabel, extraDatasets = [] }) {
  const options = baseOptions();
  options.scales.x.ticks.callback = function tick(value) {
    const t = this.getLabelForValue(value);
    return fmtHourOnly.format(t) === '12 AM' ? fmtDay.format(t) : fmtHour.format(t);
  };
  options.scales.x.ticks.maxTicksLimit = 8;
  options.scales.y.title = { display: true, text: 'in / hour', color: css('--text-muted') };
  options.scales.total = {
    position: 'right',
    beginAtZero: true,
    ticks: { color: css('--text-muted') },
    grid: { drawOnChartArea: false },
    title: { display: true, text: 'running total (in)', color: css('--text-muted') },
  };
  options.plugins.tooltip.callbacks.title = (items) => fmtFull.format(Number(items[0].label));
  options.plugins.tooltip.callbacks.label = (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(2)} in`;

  draw(canvas, {
    data: {
      labels: hours.map((h) => h.time),
      datasets: [
        { type: 'bar', label: 'Hourly rain', data: hours.map((h) => h.inches), backgroundColor: css('--rain'), barPercentage: 1, categoryPercentage: 1, yAxisID: 'y', order: 2 },
        { type: 'line', label: cumulativeLabel, data: cumulative(hours.map((h) => h.inches)), borderColor: css('--accent'), pointRadius: 0, borderWidth: 2, yAxisID: 'total', order: 1 },
        ...extraDatasets,
      ],
    },
    options,
  });
}

// `hours` drives the bars; `modelHours` (Open-Meteo) is drawn as a comparison running total when given.
export function renderRainHistory(canvas, hours, { label, modelHours = null }) {
  const extra = [];
  if (modelHours) {
    const byTime = new Map(modelHours.map((h) => [h.time, h.inches]));
    extra.push({ type: 'line', label: 'Running total (Open-Meteo model)', data: cumulative(hours.map((h) => byTime.get(h.time) ?? 0)), borderColor: css('--text-muted'), borderDash: [4, 4], pointRadius: 0, borderWidth: 1.5, yAxisID: 'total', order: 0 });
  }
  rainChart(canvas, hours, { cumulativeLabel: `Running total (${label})`, extraDatasets: extra });
}

// Spreads each NWS QPF period evenly over its hours so it lines up with the hourly bars.
function qpfPerHour(hours, qpfPeriods) {
  return hours.map((h) => {
    const p = qpfPeriods.find((q) => h.time >= q.start && h.time < q.end);
    return p ? p.inches / ((p.end - p.start) / HOUR_MS) : 0;
  });
}

export function renderRainProjection(canvas, hours, qpf) {
  const extra = [];
  if (qpf?.periods?.length) {
    const lastQpf = Math.max(...qpf.periods.map((p) => p.end));
    const totals = cumulative(qpfPerHour(hours, qpf.periods)).map((v, i) => (hours[i].time < lastQpf ? v : null));
    extra.push({ type: 'line', label: 'Running total (NWS forecast)', data: totals, borderColor: css('--nws'), borderDash: [6, 4], pointRadius: 0, borderWidth: 2, yAxisID: 'total', order: 0, spanGaps: false });
  }
  rainChart(canvas, hours, { cumulativeLabel: 'Running total (Open-Meteo)', extraDatasets: extra });
}

export function renderGaugeChart(canvas, gauge) {
  const options = baseOptions();
  const first = gauge.series[0]?.time ?? Date.now();
  const last = gauge.series.at(-1)?.time ?? Date.now();
  options.scales.x = {
    type: 'linear',
    min: first,
    max: last,
    ticks: { color: css('--text-muted'), maxTicksLimit: 5, maxRotation: 0, callback: (v) => fmtDay.format(v) },
    grid: { color: css('--grid') },
  };
  options.scales.y.beginAtZero = false;
  options.scales.y.title = { display: true, text: `feet${gauge.datum ? ` (${gauge.datum})` : ''}`, color: css('--text-muted') };
  options.plugins.legend.display = false;
  options.plugins.tooltip.callbacks.title = (items) => fmtFull.format(items[0].parsed.x);
  options.plugins.tooltip.callbacks.label = (item) => `${item.dataset.label}: ${item.parsed.y.toFixed(2)} ft`;
  options.interaction = { mode: 'nearest', axis: 'x', intersect: false };

  const levels = FLOOD_LEVELS.filter((l) => gauge.categories[l.key] != null).map((l) => ({
    type: 'line',
    label: `${l.label} (${gauge.categories[l.key]} ft)`,
    data: [{ x: first, y: gauge.categories[l.key] }, { x: last, y: gauge.categories[l.key] }],
    borderColor: css(l.color),
    borderDash: [6, 4],
    borderWidth: 1.5,
    pointRadius: 0,
  }));

  draw(canvas, {
    type: 'line',
    data: {
      datasets: [
        { label: 'Water level', data: gauge.series.map((p) => ({ x: p.time, y: p.value })), borderColor: css('--water'), backgroundColor: css('--water-fill'), fill: 'start', pointRadius: 0, borderWidth: 2 },
        ...levels,
      ],
    },
    options,
  });
}

// ---------- Map ----------

let map;
let radarLayer;
const gaugeLayer = L ? L.layerGroup() : null;
const RADAR_URL = 'https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png';

export function initMap(el, { center, zipGeojson }) {
  map = L.map(el, { scrollWheelZoom: false });
  const zip = L.geoJSON(zipGeojson, { style: { color: css('--accent'), weight: 3, fillOpacity: 0.05 } });
  // Set the view before adding tile layers so Leaflet doesn't fetch and then abort a first round of tiles.
  if (zip.getBounds().isValid()) map.fitBounds(zip.getBounds().pad(0.6), { animate: false });
  else map.setView([center.lat, center.lon], 11);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  radarLayer = L.tileLayer(`${RADAR_URL}?t=${Date.now()}`, {
    opacity: 0.6,
    attribution: 'Radar: <a href="https://mesonet.agron.iastate.edu/">Iowa Environmental Mesonet</a> / NWS NEXRAD',
  }).addTo(map);
  zip.addTo(map).bindTooltip('ZIP 32909');
  gaugeLayer.addTo(map);
  L.control.layers(null, { 'Radar (NEXRAD)': radarLayer, 'ZIP 32909 outline': zip, 'River gauges': gaugeLayer }, { collapsed: true }).addTo(map);
}

export function refreshRadar() {
  radarLayer?.setUrl(`${RADAR_URL}?t=${Date.now()}`);
}

export function renderGaugeMarkers(gauges, { categoryColor, popupHtml }) {
  if (!map) return;
  gaugeLayer.clearLayers();
  for (const g of gauges) {
    L.circleMarker([g.lat, g.lon], { radius: 8, color: '#fff', weight: 2, fillColor: categoryColor(g), fillOpacity: 0.95 })
      .bindPopup(popupHtml(g))
      .addTo(gaugeLayer);
  }
}
