/* =========================================================================
   Global Energy Transition — D3.js v7 dashboard
   Data: Our World in Data · cleaned_countries.csv + cleaned_regions.csv
   Design: premium dark theme inherited from style.css.

   Architecture:
     - Load both CSVs in parallel, build derived structures once
     - Lazy-render each panel on first activation (rendered{} flags)
     - Map / scatter / bars react to a year slider per panel
     - Single shared tooltip element
   ========================================================================= */

(() => {
  "use strict";

  // =======================================================================
  //  Formatters
  // =======================================================================
  const fmt = {
    count: d3.format(","),
    countShort: (v) => {
      if (v == null || isNaN(v)) return "—";
      if (v >= 1e9) return (v / 1e9).toFixed(1) + "B";
      if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(Math.round(v));
    },
    twh: (v) => {
      if (v == null || isNaN(v)) return "—";
      if (v >= 1000) return (v / 1000).toFixed(1) + "k TWh";
      return v.toFixed(0) + " TWh";
    },
    pct1: (v) => (v == null || isNaN(v) ? "—" : v.toFixed(1) + "%"),
    pct0: (v) => (v == null || isNaN(v) ? "—" : Math.round(v) + "%"),
    kwh:  (v) => (v == null || isNaN(v) ? "—" : fmt.countShort(v) + " kWh"),
    mt:   (v) => (v == null || isNaN(v) ? "—" : fmt.countShort(v) + " Mt"),
    int:  (v) => (v == null || isNaN(v) ? "—" : d3.format(",")(Math.round(v))),
  };

  // =======================================================================
  //  Energy palette — purpose-built per source. Greens for renewables,
  //  warm tones for fossil fuels, blue for nuclear. Order matters: it's
  //  the stacking order from base (heaviest historical) to top (newest).
  // =======================================================================
  const SOURCE_KEYS = ["coal", "oil", "gas", "nuclear", "hydro", "wind", "solar", "other"];
  const SOURCE_LABEL = {
    coal: "Coal", oil: "Oil", gas: "Gas",
    nuclear: "Nuclear", hydro: "Hydro",
    wind: "Wind", solar: "Solar", other: "Other renewables",
  };
  const SOURCE_COLOR = {
    coal:    "#5C5048",   // dark warm brown
    oil:     "#8C5E47",   // burnt umber
    gas:     "#D4825E",   // terracotta
    nuclear: "#B488C2",   // muted violet
    hydro:   "#7BA8D4",   // dusty blue
    wind:    "#8CB5A7",   // sage teal
    solar:   "#E0C28A",   // warm gold
    other:   "#98C290",   // sage green
  };

  // Choropleth: per-metric sequential ramp (low → high)
  // Greens = "good" direction (more renewables), Reds = "bad" (fossil/emissions).
  const METRIC_DEF = {
    renewables_share_energy: {
      label: "% Renewables in primary energy",
      domain: [0, 100],
      colorRange: ["#3A2A2A", "#5C7B3F", "#98C290", "#E0E2A3"],
      format: fmt.pct1,
      tooltipLabel: "Renewables share",
    },
    fossil_share_energy: {
      label: "% Fossil in primary energy",
      domain: [30, 100],
      colorRange: ["#2A3A2E", "#8C5E47", "#D4825E", "#E8B284"],
      format: fmt.pct1,
      tooltipLabel: "Fossil share",
    },
    energy_per_capita: {
      label: "Energy per capita (kWh)",
      domain: [0, 80000],
      colorRange: ["#1F2A38", "#4A6580", "#9DB7CC", "#E0EAF2"],
      format: fmt.kwh,
      tooltipLabel: "Energy / capita",
    },
    ghg_per_capita: {
      label: "Energy CO₂e per capita (t)",
      domain: [0, 25],
      colorRange: ["#2A3A2E", "#7B8954", "#D4A574", "#E08F6B"],
      format: (v) => (v == null || isNaN(v) ? "—" : v.toFixed(1) + " t"),
      tooltipLabel: "CO₂e / capita",
    },
  };

  // =======================================================================
  //  Country name reconciliation between OWID and world-atlas topojson.
  //  world-atlas v2 (110m) uses these short English names.
  // =======================================================================
  const TOPO_NAME_TO_OWID = {
    "United States of America": "United States",
    "Russia": "Russia",
    "Czechia": "Czechia",
    "Dominican Rep.": "Dominican Republic",
    "Bosnia and Herz.": "Bosnia and Herzegovina",
    "Eq. Guinea": "Equatorial Guinea",
    "Central African Rep.": "Central African Republic",
    "S. Sudan": "South Sudan",
    "Dem. Rep. Congo": "Democratic Republic of Congo",
    "Congo": "Congo",
    "Côte d'Ivoire": "Cote d'Ivoire",
    "Solomon Is.": "Solomon Islands",
    "N. Cyprus": "Cyprus",
    "W. Sahara": "Western Sahara",
    "Falkland Is.": "Falkland Islands",
    "Taiwan": "Taiwan",
    "Korea": "South Korea",
    "Dem. Rep. Korea": "North Korea",
  };

  // =======================================================================
  //  Shared tooltip
  // =======================================================================
  const tooltipEl = document.getElementById("tooltip");
  const tooltip = {
    show(html, event) {
      tooltipEl.innerHTML = html;
      tooltipEl.classList.add("is-visible");
      this.move(event);
    },
    move(event) {
      tooltipEl.style.left = event.clientX + "px";
      tooltipEl.style.top = event.clientY + "px";
    },
    hide() { tooltipEl.classList.remove("is-visible"); },
  };

  // =======================================================================
  //  State
  // =======================================================================
  const STATE = {
    countries: null,    // raw rows for countries
    regions: null,      // raw rows for regions
    byIso: null,        // Map: iso3 -> array of yearly rows
    byCountryName: null,// Map: country name -> iso3 (for topojson lookup)
    yearMin: 1990,
    yearMax: 2024,
    LATEST: 2024,       // Portugal tab anchor (PT + peers have 2024 share data)
  };
  const rendered = { overview: false, rankings: false, portugal: false };

  // =======================================================================
  //  Tab controller (kept simple; pattern from sales-intelligence sibling)
  // =======================================================================
  function initTabs() {
    const tabs = document.querySelectorAll(".tab");
    const indicator = document.getElementById("tabs-indicator");

    const positionIndicator = (tab) => {
      const rail = tab.parentElement;
      const r = tab.getBoundingClientRect();
      const rr = rail.getBoundingClientRect();
      indicator.style.width = r.width + "px";
      indicator.style.transform = `translateX(${r.left - rr.left}px)`;
    };

    tabs.forEach((t) => {
      t.addEventListener("click", () => {
        tabs.forEach((o) => {
          o.classList.toggle("is-active", o === t);
          o.setAttribute("aria-selected", o === t ? "true" : "false");
        });
        document.querySelectorAll(".panel").forEach((p) => {
          p.classList.toggle("is-active", p.id === "panel-" + t.dataset.panel);
        });
        positionIndicator(t);
        renderPanel(t.dataset.panel);
      });
    });

    requestAnimationFrame(() => positionIndicator(document.querySelector(".tab.is-active")));
    window.addEventListener("resize", () => {
      positionIndicator(document.querySelector(".tab.is-active"));
    });
  }

  function renderPanel(name) {
    if (rendered[name]) return;
    if (name === "overview") renderOverview();
    if (name === "rankings") renderRankings();
    if (name === "portugal") renderPortugal();
    rendered[name] = true;
  }

  // Debounced redraw on resize for the active panel
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const active = document.querySelector(".tab.is-active")?.dataset.panel;
      if (!active) return;
      rendered[active] = false;
      document.querySelectorAll(`#panel-${active} .chart`).forEach((el) => (el.innerHTML = ""));
      renderPanel(active);
    }, 180);
  });

  // =======================================================================
  //  Data loading
  // =======================================================================
  Promise.all([
    d3.csv("países_limpos.csv", d3.autoType),
    d3.csv("regiões_limpas.csv", d3.autoType),
  ])
    .then(([countries, regions]) => {
      STATE.countries = countries;
      STATE.regions = regions;

      // Index countries by iso_code → array of rows (sorted by year)
      STATE.byIso = d3.group(countries.filter((d) => d.iso_code), (d) => d.iso_code);
      STATE.byCountryName = new Map(
        countries.filter((d) => d.iso_code).map((d) => [d.country, d.iso_code])
      );

      const years = countries.map((d) => d.year).filter((y) => y != null);
      STATE.yearMin = d3.min(years);
      STATE.yearMax = d3.max(years);

      renderMeta();
      initTabs();
      initYearSliders();
      initMetricToggle();
      renderPanel("overview");
    })
    .catch((err) => {
      console.error(err);
      document.querySelector(".page").insertAdjacentHTML(
        "afterbegin",
        `<div style="padding:1rem;background:rgba(201,168,106,0.1);
         border:1px solid rgba(201,168,106,0.3);border-radius:8px;
         margin-bottom:1rem;color:#EEEAE0">
         <strong>Could not load CSV data.</strong>
         Make sure países_limpos.csv and regiões_limpas.csv are in the
         <code>data/</code> folder, and serve the project over HTTP
         (e.g. <code>python -m http.server</code>).</div>`
      );
    });

  function renderMeta() {
    document.getElementById("meta-period").textContent =
      `${STATE.yearMin} — ${STATE.yearMax}`;
    document.getElementById("meta-rows").textContent =
      fmt.count(STATE.countries.length);
  }

  // =======================================================================
  //  Cross-panel controls: year sliders + map metric toggle
  // =======================================================================
  let mapState = { year: 2023, metric: "renewables_share_energy" };
  let rankYear = 2023;

  function initYearSliders() {
    // Map slider (drives the choropleth + KPIs)
    const mapSlider = document.getElementById("year-input");
    const mapOut = document.getElementById("year-output");
    mapSlider.addEventListener("input", (e) => {
      mapState.year = +e.target.value;
      mapOut.textContent = mapState.year;
      updateChoropleth();
      updateKPIs();
    });

    // Rankings slider (drives the bar chart + scatter)
    const rankSlider = document.getElementById("year-input-rank");
    const rankOut = document.getElementById("year-output-rank");
    rankSlider.addEventListener("input", (e) => {
      rankYear = +e.target.value;
      rankOut.textContent = rankYear;
      drawRenewablesRanking();
      drawScatter();
    });
  }

  function initMetricToggle() {
    document.querySelectorAll(".seg").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".seg").forEach((b) => {
          b.classList.toggle("is-active", b === btn);
          b.setAttribute("aria-checked", b === btn ? "true" : "false");
        });
        mapState.metric = btn.dataset.metric;
        updateChoropleth();
        updateLegend();
      });
    });
  }

  // =======================================================================
  //  Helpers
  // =======================================================================
  // Get the row for a given iso/year, or null if missing
  function getRow(iso, year) {
    const arr = STATE.byIso.get(iso);
    if (!arr) return null;
    return arr.find((d) => d.year === year) || null;
  }

  // Compute a metric value, including the synthetic ghg_per_capita
  function metricValue(row, metric) {
    if (!row) return null;
    if (metric === "ghg_per_capita") {
      if (!row.greenhouse_gas_emissions || !row.population) return null;
      // Mt CO2e * 1e6 / population = tonnes per person
      return (row.greenhouse_gas_emissions * 1e6) / row.population;
    }
    const v = row[metric];
    return v == null || isNaN(v) ? null : v;
  }

  // Aggregate world figures from the regions file (entity = "World")
  function getWorldRow(year) {
    return STATE.regions.find((d) => d.country === "World" && d.year === year) || null;
  }

  // Decompose a year row into the 8 source shares we plot.
  // OWID provides explicit shares for each source as % of primary energy:
  // coal/oil/gas/nuclear/hydro/wind/solar. "Other renewables" is recovered
  // as renewables_share - (hydro+wind+solar) — biofuels, geothermal, etc.
  function rowToShares(row) {
    if (!row) return null;
    const coal    = row.coal_share_energy ?? 0;
    const oil     = row.oil_share_energy ?? 0;
    const gas     = row.gas_share_energy ?? 0;
    const nuclear = row.nuclear_share_energy ?? 0;
    const hydro   = row.hydro_share_energy ?? 0;
    const wind    = row.wind_share_energy ?? 0;
    const solar   = row.solar_share_energy ?? 0;
    const renew   = row.renewables_share_energy ?? 0;
    // "Other renewables" = total renewables minus the three we plot separately.
    // Negative values shouldn't happen but clamp at zero just in case.
    const other = Math.max(0, renew - (hydro + wind + solar));

    return { coal, oil, gas, nuclear, hydro, wind, solar, other };
  }

  // Build a stacked time series from a list of country/region rows.
  // We require coal_share_energy (a proxy for "the detailed mix is reported").
  function buildStackedSeries(rows) {
    return rows
      .filter((r) => r.coal_share_energy != null)
      .sort((a, b) => a.year - b.year)
      .map((r) => {
        const s = rowToShares(r);
        return { year: r.year, ...s };
      });
  }

  // =======================================================================
  //  PANEL 1 · Global Overview
  // =======================================================================
  function renderOverview() {
    updateKPIs();
    drawChoroplethMap();   // builds the SVG, stores updaters for slider
  }

  function updateKPIs() {
    const w = getWorldRow(mapState.year);
    document.getElementById("kpi-population-sub").textContent = `Year ${mapState.year}`;

    document.querySelectorAll(".kpi").forEach((el) => {
      const key = el.dataset.kpi;
      const v = el.querySelector(".kpi__value");
      if (!w) { v.textContent = "—"; return; }
      if (key === "population")    v.textContent = fmt.countShort(w.population);
      if (key === "primaryEnergy") v.textContent = fmt.twh(w.primary_energy_consumption);
      if (key === "renewables")    v.textContent = fmt.pct1(w.renewables_share_energy);
      if (key === "emissions")     v.textContent = fmt.countShort(w.greenhouse_gas_emissions) + " Mt";
    });
  }

  // ---------- Choropleth map ----------
  // The map function is the most ambitious one. It builds the SVG once,
  // attaches a paint() helper that updateChoropleth() calls when the
  // year slider or metric toggle change.
  let mapPaint = null;     // closure: redraws colours
  let mapZoomG = null;     // group inside SVG that holds lands
  let mapPathGen = null;
  let mapZoom = null;

  function drawChoroplethMap() {
    const el = document.getElementById("chart-world-map");
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 520;

    const svg = d3.select(el).append("svg")
      .attr("viewBox", [0, 0, width, height])
      .style("cursor", "grab");

    // Ocean
    svg.append("rect")
      .attr("class", "map-ocean")
      .attr("width", width).attr("height", height);

    const projection = (typeof d3.geoNaturalEarth1 === "function")
      ? d3.geoNaturalEarth1()
      : d3.geoEquirectangular();

    projection.fitExtent([[10, 10], [width - 10, height - 10]], { type: "Sphere" });
    mapPathGen = d3.geoPath(projection);

    mapZoomG = svg.append("g").attr("class", "zoom-root");

    mapZoom = d3.zoom()
      .scaleExtent([1, 12])
      .translateExtent([[-width * 0.2, -height * 0.2], [width * 1.2, height * 1.2]])
      .on("zoom", (event) => {
        mapZoomG.attr("transform", event.transform);
        const k = event.transform.k;
        mapZoomG.selectAll(".map-land").attr("stroke-width", 0.4 / k);
      });
    svg.call(mapZoom);

    // Reset + detail panel wiring
    const resetBtn = document.getElementById("map-reset");
    const detailPanel = document.getElementById("map-detail");
    document.getElementById("map-detail-close").onclick = () => {
      detailPanel.classList.remove("is-visible");
      mapZoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
    };
    resetBtn.onclick = () => {
      svg.transition().duration(700).ease(d3.easeCubicInOut)
        .call(mapZoom.transform, d3.zoomIdentity);
      resetBtn.classList.remove("is-visible");
      detailPanel.classList.remove("is-visible");
      mapZoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
    };

    function zoomToFeature(feature) {
      const [[x0, y0], [x1, y1]] = mapPathGen.bounds(feature);
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      const dx = Math.max(x1 - x0, 1), dy = Math.max(y1 - y0, 1);
      const scale = Math.min(6, 0.55 / Math.max(dx / width, dy / height));
      // Bias upward+right so the bottom-left detail panel doesn't cover it
      const tx = width / 2 - scale * cx + 65;
      const ty = height / 2 - scale * cy - 60;
      svg.transition().duration(800).ease(d3.easeCubicInOut)
        .call(mapZoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    function populateDetail(iso, name) {
      const row = getRow(iso, mapState.year);
      document.getElementById("map-detail-title").textContent = name;
      document.getElementById("map-detail-eyebrow").textContent =
        `SELECTED · ${mapState.year}`;
      const set = (id, val) => document.getElementById(id).textContent = val;

      if (!row) {
        set("md-population", "—"); set("md-energy", "—");
        set("md-renew", "—"); set("md-fossil", "—");
        set("md-nuclear", "—"); set("md-ghg", "—");
        document.getElementById("md-rank").textContent = "NO DATA FOR THIS YEAR";
      } else {
        set("md-population", fmt.countShort(row.population));
        set("md-energy",     fmt.twh(row.primary_energy_consumption));
        set("md-renew",      fmt.pct1(row.renewables_share_energy));
        set("md-fossil",     fmt.pct1(row.fossil_share_energy));
        set("md-nuclear",    fmt.pct1(row.nuclear_share_energy));
        set("md-ghg",        fmt.mt(row.greenhouse_gas_emissions));

        // Rank by current metric within countries that have data this year
        const metric = mapState.metric;
        const all = [];
        STATE.byIso.forEach((arr, iso2) => {
          const v = metricValue(arr.find((d) => d.year === mapState.year), metric);
          if (v != null) all.push({ iso: iso2, v });
        });
        all.sort((a, b) => b.v - a.v);
        const idx = all.findIndex((d) => d.iso === iso);
        if (idx >= 0) {
          document.getElementById("md-rank").textContent =
            `RANK #${idx + 1} OF ${all.length} · ${METRIC_DEF[metric].label.toUpperCase()}`;
        } else {
          document.getElementById("md-rank").textContent = "NOT RANKED";
        }
      }
      detailPanel.classList.add("is-visible");
      resetBtn.classList.add("is-visible");
    }

    // Loading state
    const loader = mapZoomG.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("font-family", "var(--font-mono)").attr("font-size", 11)
      .attr("fill", "var(--ink-muted)")
      .text("loading world map…");

    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((world) => {
        loader.remove();
        const countries = topojson.feature(world, world.objects.countries);

        const lands = mapZoomG.append("g").attr("class", "lands")
          .selectAll("path")
          .data(countries.features)
          .join("path")
          .attr("class", "map-land")
          .attr("d", mapPathGen)
          .on("mousemove", function (event, f) {
            const name = TOPO_NAME_TO_OWID[f.properties.name] || f.properties.name;
            const iso = STATE.byCountryName.get(name);
            const row = iso ? getRow(iso, mapState.year) : null;
            const v = metricValue(row, mapState.metric);
            const def = METRIC_DEF[mapState.metric];
            tooltip.show(
              `<div class="tooltip__title">${name}</div>
               <div class="tooltip__row"><span>${def.tooltipLabel}</span>
                 <strong>${v == null ? "—" : def.format(v)}</strong></div>
               <div class="tooltip__row"><span>Year</span>
                 <strong>${mapState.year}</strong></div>`,
              event
            );
          })
          .on("mouseleave", () => tooltip.hide())
          .on("click", function (event, f) {
            event.stopPropagation();
            const name = TOPO_NAME_TO_OWID[f.properties.name] || f.properties.name;
            const iso = STATE.byCountryName.get(name);
            mapZoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
            d3.select(this).classed("is-selected", true);
            zoomToFeature(f);
            if (iso) populateDetail(iso, name);
            else {
              const detailPanel = document.getElementById("map-detail");
              document.getElementById("map-detail-title").textContent = name;
              document.getElementById("map-detail-eyebrow").textContent = "NO MATCHING DATA";
              ["md-population","md-energy","md-renew","md-fossil","md-nuclear","md-ghg"]
                .forEach((id) => document.getElementById(id).textContent = "—");
              document.getElementById("md-rank").textContent = "—";
              detailPanel.classList.add("is-visible");
              resetBtn.classList.add("is-visible");
            }
          });

        // Closure that paints lands by the active metric+year
        mapPaint = function () {
          const def = METRIC_DEF[mapState.metric];
          const color = d3.scaleLinear()
            .domain(d3.range(def.colorRange.length).map(
              (i) => def.domain[0] + (def.domain[1] - def.domain[0]) * i / (def.colorRange.length - 1)
            ))
            .range(def.colorRange)
            .clamp(true);

          lands.transition().duration(450).ease(d3.easeCubicOut)
            .attr("fill", (f) => {
              const name = TOPO_NAME_TO_OWID[f.properties.name] || f.properties.name;
              const iso = STATE.byCountryName.get(name);
              const v = metricValue(getRow(iso, mapState.year), mapState.metric);
              if (v == null) return "var(--bg-elevated)";
              return color(v);
            })
            .attr("class", (f) => {
              const name = TOPO_NAME_TO_OWID[f.properties.name] || f.properties.name;
              const iso = STATE.byCountryName.get(name);
              const v = metricValue(getRow(iso, mapState.year), mapState.metric);
              return v == null ? "map-land is-no-data" : "map-land";
            });
        };

        mapPaint();
        drawLegend();
      })
      .catch((err) => {
        console.error("Map load failed", err);
        loader.text("could not load map data");
      });
  }

  function updateChoropleth() {
    if (typeof mapPaint === "function") mapPaint();
  }

  // Map legend (sits inside the map card, bottom-right)
  function drawLegend() {
    const card = document.getElementById("map-card");
    let legend = card.querySelector(".map-legend");
    if (!legend) {
      legend = document.createElement("div");
      legend.className = "map-legend";
      legend.innerHTML = `
        <div class="map-legend__title" id="legend-title">—</div>
        <div class="map-legend__bar" id="legend-bar"></div>
        <div class="map-legend__ticks">
          <span id="legend-min">—</span>
          <span id="legend-max">—</span>
        </div>`;
      card.appendChild(legend);
    }
    updateLegend();
  }

  function updateLegend() {
    const def = METRIC_DEF[mapState.metric];
    if (!def) return;
    const stops = def.colorRange.map(
      (c, i) => `${c} ${(i / (def.colorRange.length - 1) * 100).toFixed(0)}%`
    ).join(", ");
    const bar = document.getElementById("legend-bar");
    if (!bar) return;
    bar.style.background = `linear-gradient(90deg, ${stops})`;
    document.getElementById("legend-title").textContent = def.label;
    document.getElementById("legend-min").textContent = def.format(def.domain[0]);
    document.getElementById("legend-max").textContent = def.format(def.domain[1]);
  }

  // ---------- World stacked area ----------
  function drawWorldStackedArea() {
    const el = document.getElementById("chart-world-mix");
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 320;
    const margin = { top: 18, right: 24, bottom: 32, left: 44 };

    const worldRows = STATE.regions.filter((d) => d.country === "World");
    const series = buildStackedSeries(worldRows);
    if (!series.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);font-family:var(--font-mono);
        font-size:11px;padding:1rem">No world data available.</p>`;
      return;
    }

    const stack = d3.stack().keys(SOURCE_KEYS).order(d3.stackOrderNone);
    const stacked = stack(series);

    const x = d3.scaleLinear()
      .domain(d3.extent(series, (d) => d.year))
      .range([margin.left, width - margin.right]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(stacked, (s) => d3.max(s, (d) => d[1])) || 100])
      .nice()
      .range([height - margin.bottom, margin.top]);

    const svg = d3.select(el).append("svg")
      .attr("viewBox", [0, 0, width, height]);

    // Gridlines
    svg.append("g").selectAll("line")
      .data(y.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    // Areas
    const area = d3.area()
      .x((d) => x(d.data.year))
      .y0((d) => y(d[0]))
      .y1((d) => y(d[1]))
      .curve(d3.curveMonotoneX);

    svg.append("g").selectAll("path")
      .data(stacked).join("path")
      .attr("fill", (d) => SOURCE_COLOR[d.key])
      .attr("opacity", 0.92)
      .attr("d", area)
      .on("mousemove", (event, d) => {
        // Find the year nearest the mouse
        const [mx] = d3.pointer(event);
        const yr = Math.round(x.invert(mx));
        const point = d.find((p) => p.data.year === yr);
        const v = point ? (point[1] - point[0]) : null;
        tooltip.show(
          `<div class="tooltip__title">
            <span class="tooltip__swatch" style="background:${SOURCE_COLOR[d.key]}"></span>
            ${SOURCE_LABEL[d.key]}
           </div>
           <div class="tooltip__row"><span>Year</span><strong>${yr}</strong></div>
           <div class="tooltip__row"><span>Share</span><strong>${v == null ? "—" : v.toFixed(1) + "%"}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide());

    // Axes
    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((v) => v + "%").tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").remove());

    // Legend chips below the chart
    let chips = el.querySelector(".legend-chips");
    if (!chips) {
      chips = document.createElement("div");
      chips.className = "legend-chips";
      chips.innerHTML = SOURCE_KEYS.map((k) => `
        <span class="legend-chip">
          <span class="legend-chip__swatch" style="background:${SOURCE_COLOR[k]}"></span>
          ${SOURCE_LABEL[k]}
        </span>`).join("");
      el.appendChild(chips);
    }
  }

  // =======================================================================
  //  PANEL 2 · Country Rankings
  // =======================================================================
  function renderRankings() {
    drawRenewablesRanking();
    drawScatter();
  }

  function drawRenewablesRanking() {
    const el = document.getElementById("chart-rank-renewables");
    el.innerHTML = "";
    const width = el.clientWidth;

    // Build top-15 for the active year, ignoring countries with tiny populations
    // (small island states with skewed shares would drown the message)
    const candidates = [];
    STATE.byIso.forEach((arr, iso) => {
      const row = arr.find((d) => d.year === rankYear);
      if (!row) return;
      if (row.renewables_share_energy == null) return;
      if (row.population == null || row.population < 1e6) return;
      candidates.push({
        iso,
        country: row.country,
        value: row.renewables_share_energy,
      });
    });
    candidates.sort((a, b) => b.value - a.value);
    const top = candidates.slice(0, 15);

    if (!top.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);font-family:var(--font-mono);
        font-size:11px;padding:1rem">No share data for ${rankYear}.</p>`;
      return;
    }

    const barHeight = 22, padding = 0.26;
    const margin = { top: 10, right: 70, bottom: 26, left: 130 };
    const height = top.length * (barHeight / (1 - padding)) + margin.top + margin.bottom;

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const y = d3.scaleBand()
      .domain(top.map((d) => d.country))
      .range([margin.top, height - margin.bottom])
      .padding(padding);

    const x = d3.scaleLinear()
      .domain([0, Math.max(100, d3.max(top, (d) => d.value) * 1.05)])
      .range([margin.left, width - margin.right]);

    // Gridlines
    svg.append("g").selectAll("line")
      .data(x.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", margin.top).attr("y2", height - margin.bottom);

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat((v) => v + "%").tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    // Highlight Portugal in accent-2 if present
    svg.append("g").selectAll("rect")
      .data(top).join("rect")
      .attr("class", "bar")
      .attr("x", margin.left)
      .attr("y", (d) => y(d.country))
      .attr("height", y.bandwidth())
      .attr("width", 0)
      .attr("fill", (d) => d.iso === "PRT" ? "var(--accent-2)" : "var(--accent-3)")
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.country}</div>
           <div class="tooltip__row"><span>Renewables</span><strong>${fmt.pct1(d.value)}</strong></div>
           <div class="tooltip__row"><span>Year</span><strong>${rankYear}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 30).ease(d3.easeCubicOut)
      .attr("width", (d) => x(d.value) - margin.left);

    svg.append("g").selectAll("text")
      .data(top).join("text")
      .attr("class", "direct-label")
      .attr("x", (d) => x(d.value) + 6)
      .attr("y", (d) => y(d.country) + y.bandwidth() / 2 + 4)
      .attr("opacity", 0)
      .text((d) => fmt.pct1(d.value))
      .transition().delay((_, i) => 350 + i * 30).duration(300)
      .attr("opacity", 1);
  }

  function drawScatter() {
    const el = document.getElementById("chart-scatter");
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 380;
    const margin = { top: 18, right: 24, bottom: 42, left: 56 };

    // GDP coverage in OWID lags by ~2 years. If the active year has no GDP,
    // walk back until we find one that does — and surface that fact in the
    // chart caption so the user knows which year they're looking at.
    let scatterYear = rankYear;
    let pointsCount = 0;
    while (scatterYear >= STATE.yearMin) {
      let n = 0;
      STATE.byIso.forEach((arr) => {
        const row = arr.find((d) => d.year === scatterYear);
        if (row && row.gdp != null && row.renewables_share_energy != null
            && row.population != null && row.population >= 1e6) n++;
      });
      if (n >= 20) { pointsCount = n; break; }
      scatterYear--;
    }
    // Update card caption with the resolved year if it differs
    const cap = el.parentElement.querySelector(".card__caption");
    if (cap) {
      cap.innerHTML = scatterYear === rankYear
        ? "GDP per capita against renewables share · bubble size = population"
        : `GDP per capita against renewables share · bubble size = population
           <span style="color:var(--accent);font-style:italic">· data from ${scatterYear} (latest with GDP)</span>`;
    }

    // Build dataset for the resolved year
    const points = [];
    STATE.byIso.forEach((arr, iso) => {
      const row = arr.find((d) => d.year === scatterYear);
      if (!row) return;
      if (row.renewables_share_energy == null) return;
      if (row.gdp == null || row.population == null) return;
      if (row.population < 1e6) return; // filter out micro-states
      points.push({
        iso,
        country: row.country,
        gdpPC: row.gdp / row.population,
        renew: row.renewables_share_energy,
        pop: row.population,
      });
    });

    if (!points.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);font-family:var(--font-mono);
        font-size:11px;padding:1rem">No GDP/renewables data found.</p>`;
      return;
    }

    const x = d3.scaleLog()
      .domain([Math.max(500, d3.min(points, (d) => d.gdpPC) * 0.9),
               d3.max(points, (d) => d.gdpPC) * 1.1])
      .range([margin.left, width - margin.right]);

    const y = d3.scaleLinear()
      .domain([0, Math.max(100, d3.max(points, (d) => d.renew) * 1.05)])
      .range([height - margin.bottom, margin.top]);

    const r = d3.scaleSqrt()
      .domain([0, d3.max(points, (d) => d.pop)])
      .range([2, 26]);

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    // Gridlines (horizontal)
    svg.append("g").selectAll("line")
      .data(y.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5, "$~s").tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove())
      .append("text")
      .attr("x", width - margin.right).attr("y", 32)
      .attr("text-anchor", "end")
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("fill", "var(--ink-muted)")
      .text("GDP per capita (log scale, USD)");

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((v) => v + "%").tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").remove())
      .append("text")
      .attr("x", 0).attr("y", margin.top - 6)
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("fill", "var(--ink-muted)")
      .text("% renewables");

    svg.append("g").selectAll("circle")
      .data(points).join("circle")
      .attr("cx", (d) => x(d.gdpPC))
      .attr("cy", (d) => y(d.renew))
      .attr("r", 0)
      .attr("fill", (d) => d.iso === "PRT" ? "var(--accent-2)" : "var(--accent-3)")
      .attr("fill-opacity", (d) => d.iso === "PRT" ? 0.85 : 0.45)
      .attr("stroke", (d) => d.iso === "PRT" ? "var(--accent-2)" : "var(--accent-3)")
      .attr("stroke-width", (d) => d.iso === "PRT" ? 2 : 1)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.country}</div>
           <div class="tooltip__row"><span>GDP / capita</span><strong>$${fmt.countShort(d.gdpPC)}</strong></div>
           <div class="tooltip__row"><span>Renewables</span><strong>${fmt.pct1(d.renew)}</strong></div>
           <div class="tooltip__row"><span>Population</span><strong>${fmt.countShort(d.pop)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 6).ease(d3.easeCubicOut)
      .attr("r", (d) => r(d.pop));

    // Direct label for Portugal
    const pt = points.find((d) => d.iso === "PRT");
    if (pt) {
      svg.append("text")
        .attr("class", "direct-label")
        .attr("x", x(pt.gdpPC) + r(pt.pop) + 4)
        .attr("y", y(pt.renew) + 4)
        .attr("fill", "var(--accent-2)")
        .attr("opacity", 0)
        .text("Portugal")
        .transition().delay(900).duration(400).attr("opacity", 1);
    }
  }

  // =======================================================================
  //  PANEL 3 · Portugal in Focus
  // =======================================================================
  function renderPortugal() {
    drawPortugalSlope();
    drawPortugalVsEU();
  }

  function drawPortugalStackedArea() {
    const el = document.getElementById("chart-pt-mix");
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 340;
    const margin = { top: 18, right: 24, bottom: 32, left: 44 };

    const ptRows = (STATE.byIso.get("PRT") || []);
    const series = buildStackedSeries(ptRows);
    if (!series.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);padding:1rem">No data.</p>`;
      return;
    }

    const stack = d3.stack().keys(SOURCE_KEYS).order(d3.stackOrderNone);
    const stacked = stack(series);

    const x = d3.scaleLinear()
      .domain(d3.extent(series, (d) => d.year))
      .range([margin.left, width - margin.right]);

    const y = d3.scaleLinear()
      .domain([0, d3.max(stacked, (s) => d3.max(s, (d) => d[1])) || 100])
      .nice()
      .range([height - margin.bottom, margin.top]);

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    svg.append("g").selectAll("line")
      .data(y.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    const area = d3.area()
      .x((d) => x(d.data.year))
      .y0((d) => y(d[0]))
      .y1((d) => y(d[1]))
      .curve(d3.curveMonotoneX);

    svg.append("g").selectAll("path")
      .data(stacked).join("path")
      .attr("fill", (d) => SOURCE_COLOR[d.key])
      .attr("opacity", 0.92)
      .attr("d", area)
      .on("mousemove", (event, d) => {
        const [mx] = d3.pointer(event);
        const yr = Math.round(x.invert(mx));
        const point = d.find((p) => p.data.year === yr);
        const v = point ? (point[1] - point[0]) : null;
        tooltip.show(
          `<div class="tooltip__title">
            <span class="tooltip__swatch" style="background:${SOURCE_COLOR[d.key]}"></span>
            ${SOURCE_LABEL[d.key]}
           </div>
           <div class="tooltip__row"><span>Year</span><strong>${yr}</strong></div>
           <div class="tooltip__row"><span>Share</span><strong>${v == null ? "—" : v.toFixed(1) + "%"}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide());

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(8).tickFormat(d3.format("d")).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((v) => v + "%").tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").remove());

    let chips = el.querySelector(".legend-chips");
    if (!chips) {
      chips = document.createElement("div");
      chips.className = "legend-chips";
      chips.innerHTML = SOURCE_KEYS.map((k) => `
        <span class="legend-chip">
          <span class="legend-chip__swatch" style="background:${SOURCE_COLOR[k]}"></span>
          ${SOURCE_LABEL[k]}
        </span>`).join("");
      el.appendChild(chips);
    }
  }

  // ---------- Slope chart ----------
  // Compares Portugal's earliest-available year vs latest year (2024) across
  // 4 indicators. Each indicator can have a different start year because
  // OWID coverage varies per series — we surface the actual year next to the
  // baseline value when it differs from 1990.
  function drawPortugalSlope() {
    const el = document.getElementById("chart-pt-slope");
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 360;
    const margin = { top: 32, right: 110, bottom: 36, left: 110 };

    const ptArr = (STATE.byIso.get("PRT") || []).slice().sort((a, b) => a.year - b.year);
    const r2024 = ptArr.find((d) => d.year === STATE.LATEST);
    if (!r2024) {
      el.innerHTML = `<p style="color:var(--ink-muted);padding:1rem">No 2024 data.</p>`;
      return;
    }

    // Helper: find first row whose `key` is a number (handles the GHG NaNs)
    const firstWith = (key) => ptArr.find((r) => r[key] != null && !isNaN(r[key]));

    // GHG per capita (electricity sector only — see methodology note)
    const ghgPerCap = (r) => {
      if (!r || r.greenhouse_gas_emissions == null || !r.population) return null;
      return (r.greenhouse_gas_emissions * 1e6) / r.population;
    };
    const firstWithGhg = ptArr.find((r) => ghgPerCap(r) != null);

    const indicators = [
      {
        label: "% Fossil",
        before: firstWith("fossil_share_energy"),
        v1Key: "fossil_share_energy", v2Key: "fossil_share_energy",
        good: "down", fmt: fmt.pct1,
      },
      {
        label: "% Renewables",
        before: firstWith("renewables_share_energy"),
        v1Key: "renewables_share_energy", v2Key: "renewables_share_energy",
        good: "up", fmt: fmt.pct1,
      },
      {
        label: "Energy / capita",
        before: firstWith("energy_per_capita"),
        v1Key: "energy_per_capita", v2Key: "energy_per_capita",
        good: "neutral", fmt: fmt.kwh,
      },
      {
        label: "Power CO₂e / cap",
        before: firstWithGhg,
        // Custom getters because this is derived
        getV1: (r) => ghgPerCap(r),
        getV2: (r) => ghgPerCap(r),
        good: "down", fmt: (v) => (v == null || isNaN(v) ? "—" : v.toFixed(1) + " t"),
      },
    ].filter((ind) => ind.before).map((ind) => {
      const v1 = ind.getV1 ? ind.getV1(ind.before) : ind.before[ind.v1Key];
      const v2 = ind.getV2 ? ind.getV2(r2024) : r2024[ind.v2Key];
      return { ...ind, v1, v2, year1: ind.before.year };
    });

    if (!indicators.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);padding:1rem">No comparable indicators.</p>`;
      return;
    }

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);
    const xL = margin.left;
    const xR = width - margin.right;

    // Year headers
    svg.append("text")
      .attr("x", xL).attr("y", 18)
      .attr("text-anchor", "middle")
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("letter-spacing", "0.12em").attr("fill", "var(--ink-muted)")
      .text("EARLIEST");
    svg.append("text")
      .attr("x", xR).attr("y", 18)
      .attr("text-anchor", "middle")
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("letter-spacing", "0.12em").attr("fill", "var(--ink-muted)")
      .text(`${STATE.LATEST}`);

    // Vertical guides
    [xL, xR].forEach((cx) => {
      svg.append("line")
        .attr("x1", cx).attr("x2", cx)
        .attr("y1", margin.top).attr("y2", height - margin.bottom)
        .attr("stroke", "var(--line-faint)").attr("stroke-width", 1);
    });

    const innerH = height - margin.top - margin.bottom;
    const bandH = innerH / indicators.length;

    indicators.forEach((ind, i) => {
      const cy = margin.top + bandH * (i + 0.5);
      const span = bandH * 0.32;
      const max = Math.max(ind.v1, ind.v2);
      const min = Math.min(ind.v1, ind.v2);
      const range = max - min || 1;
      const yScale = (v) => cy + span * (1 - 2 * (v - min) / range);

      const y1 = yScale(ind.v1);
      const y2 = yScale(ind.v2);

      // Direction colour (only for clearly directional indicators)
      let stroke = "var(--accent)"; // neutral default
      if (ind.good !== "neutral") {
        const went = ind.good === "down" ? (ind.v2 < ind.v1) : (ind.v2 > ind.v1);
        stroke = went ? "var(--accent-3)" : "var(--accent-2)";
      }

      svg.append("line")
        .attr("class", "slope-line")
        .attr("x1", xL).attr("y1", y1)
        .attr("x2", xL).attr("y2", y1)
        .attr("stroke", stroke)
        .transition().duration(900).delay(i * 120).ease(d3.easeCubicOut)
        .attr("x2", xR).attr("y2", y2);

      svg.append("circle").attr("class", "slope-dot")
        .attr("cx", xL).attr("cy", y1).attr("r", 5).attr("fill", stroke);
      svg.append("circle").attr("class", "slope-dot")
        .attr("cx", xR).attr("cy", y2).attr("r", 5).attr("fill", stroke);

      // Left: indicator name
      svg.append("text").attr("class", "slope-label")
        .attr("x", xL - 12).attr("y", y1 + 4)
        .attr("text-anchor", "end")
        .text(ind.label);

      // Left: baseline value + actual year
      svg.append("text").attr("class", "slope-value")
        .attr("x", xL - 12).attr("y", y1 + 18)
        .attr("text-anchor", "end")
        .attr("fill", "var(--ink-muted)")
        .text(`${ind.fmt(ind.v1)} · ${ind.year1}`);

      // Right: latest value
      svg.append("text").attr("class", "slope-value")
        .attr("x", xR + 12).attr("y", y2 + 4)
        .attr("font-weight", 600).attr("fill", "var(--ink-primary)")
        .text(ind.fmt(ind.v2));

      // Right: delta %
      const delta = ind.v2 - ind.v1;
      const pct = ind.v1 ? ((delta / ind.v1) * 100) : null;
      const pctStr = pct == null ? "" :
        (pct > 0 ? "+" : "") + (Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(0)) + "%";
      svg.append("text").attr("class", "slope-value")
        .attr("x", xR + 12).attr("y", y2 + 18)
        .attr("fill", stroke)
        .text(pctStr);
    });
  }

  // ---------- Portugal vs European peers (latest year, horizontal bars) ----
  function drawPortugalVsEU() {
    const el = document.getElementById("chart-pt-vs-eu");
    el.innerHTML = "";
    const width = el.clientWidth;

    const peers = ["PRT", "ESP", "FRA", "DEU", "ITA", "GBR"];
    const data = peers
      .map((iso) => {
        const arr = STATE.byIso.get(iso);
        const row = arr && arr.find((d) => d.year === STATE.LATEST);
        return row ? {
          iso, country: row.country,
          renew: row.renewables_share_energy,
        } : null;
      })
      .filter((d) => d && d.renew != null)
      .sort((a, b) => b.renew - a.renew);

    if (!data.length) {
      el.innerHTML = `<p style="color:var(--ink-muted);padding:1rem">No peer data.</p>`;
      return;
    }

    const barHeight = 28, padding = 0.30;
    const margin = { top: 12, right: 70, bottom: 26, left: 100 };
    const height = data.length * (barHeight / (1 - padding)) + margin.top + margin.bottom;

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const y = d3.scaleBand()
      .domain(data.map((d) => d.country))
      .range([margin.top, height - margin.bottom])
      .padding(padding);

    const x = d3.scaleLinear()
      .domain([0, Math.max(50, d3.max(data, (d) => d.renew) * 1.05)])
      .range([margin.left, width - margin.right]);

    svg.append("g").selectAll("line")
      .data(x.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", margin.top).attr("y2", height - margin.bottom);

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat((v) => v + "%").tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    svg.append("g").selectAll("rect")
      .data(data).join("rect")
      .attr("class", "bar")
      .attr("x", margin.left)
      .attr("y", (d) => y(d.country))
      .attr("height", y.bandwidth())
      .attr("width", 0)
      .attr("fill", (d) => d.iso === "PRT" ? "var(--accent-2)" : "var(--accent-3)")
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.country}</div>
           <div class="tooltip__row"><span>Renewables</span><strong>${fmt.pct1(d.renew)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 60).ease(d3.easeCubicOut)
      .attr("width", (d) => x(d.renew) - margin.left);

    svg.append("g").selectAll("text")
      .data(data).join("text")
      .attr("class", "direct-label")
      .attr("x", (d) => x(d.renew) + 6)
      .attr("y", (d) => y(d.country) + y.bandwidth() / 2 + 4)
      .attr("opacity", 0)
      .text((d) => fmt.pct1(d.renew))
      .transition().delay((_, i) => 400 + i * 60).duration(300)
      .attr("opacity", 1);
  }
})();
