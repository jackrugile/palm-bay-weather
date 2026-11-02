# palm-bay-weather

A lightweight, self-updating flood dashboard for **Palm Bay, FL 32909**, hosted on GitHub Pages:

**https://jackrugile.github.io/palm-bay-weather/**

It shows active NWS alerts, rainfall (past and projected), river and lagoon gauge levels against NWS flood stages, an NWS forecast and forecast discussion, boil-water and water-service notices, road closures, FPL power outages, local news and a radar map. It works on a phone.

There's no build step and no commits for content. Each GitHub Actions run fetches fresh data, bundles it with the site and deploys it to Pages.

## One-time setup (GitHub UI)

1. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
2. Merge to `main` (or run the workflow manually from **Actions → Collect data and deploy → Run workflow**).
3. The site is then live at `https://jackrugile.github.io/palm-bay-weather/`.

That's it. After that the workflow runs on every push to `main`, every 15 minutes on a schedule, and on demand.

## How it updates

| Data | Where it's fetched | How often |
| --- | --- | --- |
| NWS alerts, forecast, rain forecast (QPF), forecast discussion | Browser, `api.weather.gov` | Every 5 min while the page is open |
| Past rainfall (radar estimate, MRMS) | Browser, Iowa Environmental Mesonet | Every 5 min |
| Hourly rain model, past and next 7 days | Browser, Open-Meteo | Every 5 min |
| Water levels | Browser, USGS Instantaneous Values and NOAA NWPS | Every 5 min |
| Radar map tiles | Browser, IEM NEXRAD tiles; NWS KMLB loop on demand | Every 5 min |
| News, city/county notices, FPL outages | GitHub Action, `scripts/collect.mjs` → `site/data/*.json` | Every 15 min (cron) |

The collector keeps going when a feed fails. Each source's status and error are written to `site/data/meta.json`, and the page shows a "last updated" chip per source. If `site/data/*.json` is missing (for example when running locally without the collector), the page falls back to the snapshot in `site/data/sample/`.

### Sources

- **Alerts:** NWS active alerts for Brevard County and zones FLZ547/FLZ647. Warning polygons are intersected with the ZIP 32909 outline (`site/assets/zip-32909.geojson`, from Census TIGERweb) to decide what applies to 32909.
- **Forecast:** NWS gridpoint MLB 57,43, with its QPF and the latest Melbourne Area Forecast Discussion.
- **Rain:** Iowa Environmental Mesonet hourly reanalysis (MRMS radar estimate) at the ZIP centroid for the past 7 days; Open-Meteo for the hourly projection; NWS QPF for the official forecast total.
- **Gauges:** Turkey Creek at Palm Bay (USGS 02250030 / NWS TRKF1), Indian River at Melbourne (NWS MEIF1, MHHW datum), St. Johns River near Melbourne (02232000 / MELF1), Crane Creek at Melbourne (02249500 / CCMF1), and N. Prong St. Sebastian River near Micco (02251500 / MICF1). Edit `GAUGES` in `site/js/sources.js` to change them. Of these, NWS only publishes flood stages for MEIF1.
- **Notices:** City of Palm Bay news RSS, Florida DOH-Brevard, and Google News searches for city and county emergency notices, keyword-tagged as boil, water service, main break, closure, shelter, sandbag, power or health.
- **News:** Google News searches (Palm Bay flood, boil water, water main, road closures, Brevard flooding, FPL outages, Florida Today, WESH) plus the WFTV, WKMG and Spectrum News 13 Brevard RSS feeds, filtered to local stories.
- **Power:** FPL county outage JSON for Brevard and Indian River counties. FPL only publishes county totals, so there's no Palm Bay-only figure. If the JSON is unreachable, the dashboard shows outage news and links to the FPL map and PowerOutage.us.

## Run locally

```sh
npm install
npm run collect        # writes site/data/*.json
npm run serve          # serves site/ at http://localhost:3000
```

## Files

- `site/index.html`, `site/styles.css`: the page.
- `site/js/main.js`: renders the panels and re-fetches live sources.
- `site/js/sources.js`: live API calls, gauge and location config.
- `site/js/charts.js`: Chart.js charts and the Leaflet map.
- `site/data/`: collector output (git-ignored) plus `sample/` fallback data.
- `scripts/collect.mjs`: news, notices and outages collector.
- `.github/workflows/deploy.yml`: collect and deploy on push, every 15 minutes, and manually.

## Limits

- GitHub's scheduled runs can start 5–15 minutes late when Actions is busy.
- GitHub disables scheduled workflows in public repos after 60 days without repository activity. Re-enable it from the Actions tab, or push any commit.
- Actions minutes are free for public repos, so the 15-minute schedule costs nothing.
- News and notices are matched by keyword. Always confirm with the linked source, and in an emergency call 911.
