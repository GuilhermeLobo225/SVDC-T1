/* =========================================================================
   Online Retail — Sales Intelligence Report
   D3.js v7 implementation. Premium dark theme, modular chart functions,
   lazy panel rendering, click-to-zoom map, and a dedicated Insights panel.
   ========================================================================= */

(() => {
  "use strict";

  // =======================================================================
  //  Formatters
  // =======================================================================
  const fmt = {
    money: (v) => {
      if (v >= 1e6) return "£" + (v / 1e6).toFixed(2) + "M";
      if (v >= 1e3) return "£" + (v / 1e3).toFixed(1) + "K";
      return "£" + d3.format(",.0f")(v);
    },
    moneyFull: d3.format(",.2f"),
    moneyAxis: (v) => {
      if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(0) + "K";
      return v;
    },
    count:      d3.format(","),
    countShort: (v) => {
      if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
      if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
      return String(v);
    },
    pct:      d3.format(".1%"),
    pctShort: d3.format(".0%"),
  };

  const monthShort = (name) => name.slice(0, 3);

  // =======================================================================
  //  Category palette — adapted for premium dark (Paul Tol-inspired)
  // =======================================================================
  const CAT_PALETTE = [
    "#D4A574", "#D4825E", "#88CCEE", "#CC6677", "#DDCC77",
    "#44AA99", "#AA4499", "#8DB684", "#B488C2", "#C4946C",
  ];
  const categoryColor = d3.scaleOrdinal().range(CAT_PALETTE);

  // Quarter palette — single-hue (gold) progression
  const QUARTER_COLOUR = {
    Q1: "#E0C28A",
    Q2: "#C9A86A",
    Q3: "#A68B50",
    Q4: "#806934",
  };

  // Country name reconciliation between our data and world-atlas topojson.
  const NAME_TO_TOPO = {
    "EIRE": "Ireland",
    "USA":  "United States of America",
    "RSA":  "South Africa",
    "Czech Republic": "Czechia",
  };
  const TOPO_TO_NAME = Object.fromEntries(
    Object.entries(NAME_TO_TOPO).map(([k, v]) => [v, k])
  );

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
    hide() {
      tooltipEl.classList.remove("is-visible");
    },
  };

  // =======================================================================
  //  Tab controller
  // =======================================================================
  const rendered = { summary: false, product: false, customer: false, insights: false };
  let DATA = null;

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
    if (rendered[name] || !DATA) return;
    if (name === "summary")  renderSummaryPanel(DATA);
    if (name === "product")  renderProductPanel(DATA);
    if (name === "customer") renderCustomerPanel(DATA);
    if (name === "insights") renderInsightsPanel(DATA);
    rendered[name] = true;
  }

  // Responsive redraw — rebuild visible panel on resize (debounced)
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      const active = document.querySelector(".tab.is-active")?.dataset.panel;
      if (!active) return;
      rendered[active] = false;
      document.querySelectorAll(`#panel-${active} .chart`).forEach((el) => (el.innerHTML = ""));
      document.querySelectorAll(`#panel-${active} .data-table tbody`).forEach((el) => (el.innerHTML = ""));
      document.querySelectorAll(`#panel-${active} .pair-list`).forEach((el) => (el.innerHTML = ""));
      renderPanel(active);
    }, 180);
  });

  // Entry point
  fetch("data.json")
    .then((r) => {
      if (!r.ok) throw new Error(`data.json failed: ${r.status}`);
      return r.json();
    })
    .then((data) => {
      DATA = data;
      initTabs();
      renderMeta(data.meta);
      renderPanel("summary");
    })
    .catch((err) => {
      console.error(err);
      document.querySelector(".page").insertAdjacentHTML(
        "afterbegin",
        `<div style="padding:1rem;background:rgba(201,168,106,0.1);border:1px solid rgba(201,168,106,0.3);
        border-radius:8px;margin-bottom:1rem;color:#EEEAE0">
        <strong>Could not load data.json.</strong>
        Run <code>python preprocessment.py</code> first, then serve this
        folder over HTTP (see README).</div>`
      );
    });

  function renderMeta(meta) {
    if (!meta) return;
    const from = new Date(meta.dateFrom);
    const to = new Date(meta.dateTo);
    const dFmt = d3.timeFormat("%b %Y");
    document.getElementById("meta-period").textContent = `${dFmt(from)} — ${dFmt(to)}`;
    document.getElementById("meta-rows").textContent = fmt.count(meta.rows);
  }

  // Utility: measure widest label for dynamic left margins
  function measureMaxLabelWidth(labels, fontFamily, fontSize) {
    const temp = d3.select("body").append("svg")
      .attr("width", 0).attr("height", 0)
      .style("position", "absolute").style("visibility", "hidden");
    let max = 0;
    labels.forEach((l) => {
      const t = temp.append("text")
        .attr("font-family", fontFamily)
        .attr("font-size", fontSize)
        .text(l);
      max = Math.max(max, t.node().getBBox().width);
    });
    temp.remove();
    return max;
  }

  // =======================================================================
  //  Panel 1 · Executive Summary
  // =======================================================================
  function renderSummaryPanel(d) {
    drawKPIs(d.kpis);
    drawLineMonthlyRevenue(d.revenueByMonth, "#chart-revenue-month");
    drawDonutQuarters(d.revenueByQuarter, "#chart-revenue-quarter");
    drawHorizontalBars(d.revenueByCountry, "#chart-revenue-country", {
      valueKey: "revenue",
      labelKey: "country",
      labelFmt: fmt.money,
      axisFmt:  fmt.moneyAxis,
      colour:   "var(--accent)",
    });
  }

  function drawKPIs(kpis) {
    const values = {
      totalRevenue:   fmt.money(kpis.totalRevenue),
      avgOrderValue:  "£" + fmt.moneyFull(kpis.avgOrderValue),
      totalCustomers: fmt.countShort(kpis.totalCustomers),
      totalOrders:    fmt.countShort(kpis.totalOrders),
    };
    document.querySelectorAll(".kpi").forEach((el) => {
      const key = el.dataset.kpi;
      el.querySelector(".kpi__value").textContent = values[key] ?? "—";
    });
  }

  // Line chart: Revenue by Month
  function drawLineMonthlyRevenue(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 280;
    const margin = { top: 24, right: 70, bottom: 32, left: 52 };

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const x = d3.scalePoint()
      .domain(data.map((d) => d.month))
      .range([margin.left, width - margin.right])
      .padding(0.3);

    const y = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.revenue) * 1.1])
      .nice()
      .range([height - margin.bottom, margin.top]);

    svg.append("g")
      .selectAll("line")
      .data(y.ticks(5))
      .join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).tickFormat(monthShort).tickSize(0).tickPadding(10))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).ticks(5).tickFormat((v) => "£" + fmt.moneyAxis(v)).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").remove());

    const line = d3.line().x((d) => x(d.month)).y((d) => y(d.revenue)).curve(d3.curveMonotoneX);
    const area = d3.area().x((d) => x(d.month)).y0(height - margin.bottom).y1((d) => y(d.revenue)).curve(d3.curveMonotoneX);

    const grad = svg.append("defs").append("linearGradient")
      .attr("id", "lineGrad").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
    grad.append("stop").attr("offset", "0%").attr("stop-color", "#C9A86A").attr("stop-opacity", 0.3);
    grad.append("stop").attr("offset", "100%").attr("stop-color", "#C9A86A").attr("stop-opacity", 0);

    svg.append("path").datum(data).attr("class", "area-series").attr("fill", "url(#lineGrad)").attr("opacity", 1).attr("d", area);

    const path = svg.append("path").datum(data).attr("class", "line-series").attr("stroke", "var(--accent)").attr("d", line);
    const totalLength = path.node().getTotalLength();
    path.attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition().duration(900).ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    svg.append("g").selectAll("circle")
      .data(data).join("circle")
      .attr("class", "line-dot")
      .attr("cx", (d) => x(d.month)).attr("cy", (d) => y(d.revenue))
      .attr("r", 0).attr("fill", "var(--accent)")
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.month}</div>
           <div class="tooltip__row"><span>Revenue</span><strong>£${fmt.moneyFull(d.revenue)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().delay((_, i) => 700 + i * 40).duration(300).attr("r", 4);

    const peak = data.reduce((a, b) => (b.revenue > a.revenue ? b : a));
    svg.append("text")
      .attr("class", "direct-label")
      .attr("x", x(peak.month)).attr("y", y(peak.revenue) - 14)
      .attr("text-anchor", "middle").attr("fill", "var(--accent)").attr("opacity", 0)
      .text(`peak · ${fmt.money(peak.revenue)}`)
      .transition().delay(1200).duration(400).attr("opacity", 1);
  }

  // Donut chart: Revenue by Quarter
  function drawDonutQuarters(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 280;
    const radius = Math.min(width, height) / 2 - 18;
    const innerRadius = radius * 0.62;

    const svg = d3.select(el).append("svg")
      .attr("viewBox", [-width / 2, -height / 2, width, height]);

    const pie = d3.pie().value((d) => d.revenue).sort(null).padAngle(0.012);
    const arc = d3.arc().innerRadius(innerRadius).outerRadius(radius).cornerRadius(3);
    const arcLabel = d3.arc().innerRadius(radius + 14).outerRadius(radius + 14);
    const arcs = pie(data);

    svg.append("g").selectAll("path")
      .data(arcs).join("path")
      .attr("class", "arc")
      .attr("fill", (d) => QUARTER_COLOUR[d.data.quarter])
      .attr("d", arc)
      .each(function (d) { this._current = { ...d, startAngle: d.endAngle, endAngle: d.endAngle }; })
      .transition().duration(800).ease(d3.easeCubicOut)
      .attrTween("d", function (d) {
        const i = d3.interpolate(this._current, d);
        this._current = d;
        return (t) => arc(i(t));
      });

    svg.selectAll(".arc")
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">
            <span class="tooltip__swatch" style="background:${QUARTER_COLOUR[d.data.quarter]}"></span>${d.data.quarter}
           </div>
           <div class="tooltip__row"><span>Revenue</span><strong>£${fmt.moneyFull(d.data.revenue)}</strong></div>
           <div class="tooltip__row"><span>Share</span><strong>${d.data.percentage.toFixed(1)}%</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide());

    const labels = svg.append("g").selectAll("g")
      .data(arcs).join("g")
      .attr("opacity", 0)
      .attr("transform", (d) => `translate(${arcLabel.centroid(d)})`);

    labels.append("text")
      .attr("text-anchor", "middle").attr("dy", -2)
      .attr("font-family", "var(--font-mono)").attr("font-size", 10).attr("font-weight", 600)
      .attr("fill", "var(--ink-primary)")
      .text((d) => d.data.quarter);

    labels.append("text")
      .attr("text-anchor", "middle").attr("dy", 12)
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("fill", "var(--ink-muted)")
      .text((d) => d.data.percentage.toFixed(0) + "%");

    labels.transition().delay((_, i) => 500 + i * 80).duration(400).attr("opacity", 1);

    const total = d3.sum(data, (d) => d.revenue);
    const centre = svg.append("g").attr("opacity", 0);
    centre.append("text")
      .attr("text-anchor", "middle").attr("dy", -4)
      .attr("font-family", "var(--font-mono)").attr("font-size", 10)
      .attr("fill", "var(--ink-muted)").attr("letter-spacing", "0.12em")
      .text("TOTAL");
    centre.append("text")
      .attr("text-anchor", "middle").attr("dy", 18)
      .attr("font-family", "var(--font-display)").attr("font-style", "italic").attr("font-size", 22)
      .attr("fill", "var(--ink-primary)")
      .text(fmt.money(total));

    centre.transition().delay(800).duration(400).attr("opacity", 1);
  }

  // Horizontal bar chart — generic helper with dynamic left margin
  function drawHorizontalBars(data, selector, opts) {
    const {
      valueKey = "revenue",
      labelKey = "country",
      labelFmt = fmt.money,
      axisFmt  = fmt.moneyAxis,
      colour   = "var(--accent)",
      barHeight = 22,
      padding   = 0.28,
      valuePrefix = "",
      valueSuffix = "",
    } = opts || {};

    const el = document.querySelector(selector);
    el.innerHTML = "";

    const sorted = [...data].sort((a, b) => b[valueKey] - a[valueKey]);
    const width = el.clientWidth;

    // Measure longest label to compute left margin
    const labels = sorted.map((d) => String(d[labelKey]));
    const measured = measureMaxLabelWidth(labels, '"IBM Plex Mono", monospace', 10);
    const marginLeft = Math.min(Math.max(measured + 20, 100), width * 0.45);

    const margin = { top: 10, right: 90, bottom: 26, left: marginLeft };
    const height = Math.max(220, sorted.length * (barHeight / (1 - padding)) + margin.top + margin.bottom);

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const y = d3.scaleBand()
      .domain(sorted.map((d) => d[labelKey]))
      .range([margin.top, height - margin.bottom])
      .padding(padding);

    const x = d3.scaleLinear()
      .domain([0, d3.max(sorted, (d) => d[valueKey]) * 1.02])
      .range([margin.left, width - margin.right])
      .nice();

    svg.append("g").selectAll("line")
      .data(x.ticks(5)).join("line")
      .attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", margin.top).attr("y2", height - margin.bottom);

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(5).tickFormat(axisFmt).tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    svg.append("g").attr("class", "bars").selectAll("rect")
      .data(sorted).join("rect")
      .attr("class", "bar")
      .attr("x", margin.left)
      .attr("y", (d) => y(d[labelKey]))
      .attr("height", y.bandwidth())
      .attr("width", 0)
      .attr("fill", colour)
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d[labelKey]}</div>
           <div class="tooltip__row"><span>${valueKey}</span><strong>${valuePrefix}${labelFmt(d[valueKey])}${valueSuffix}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 35).ease(d3.easeCubicOut)
      .attr("width", (d) => x(d[valueKey]) - margin.left);

    svg.append("g").selectAll("text")
      .data(sorted).join("text")
      .attr("class", "direct-label")
      .attr("x", (d) => x(d[valueKey]) + 6)
      .attr("y", (d) => y(d[labelKey]) + y.bandwidth() / 2 + 4)
      .attr("opacity", 0)
      .text((d) => valuePrefix + labelFmt(d[valueKey]) + valueSuffix)
      .transition().delay((_, i) => 400 + i * 35).duration(300)
      .attr("opacity", 1);
  }

  // =======================================================================
  //  Panel 2 · Product Performance
  // =======================================================================
  function renderProductPanel(d) {
    categoryColor.domain(d.categoryBreakdown.map((c) => c.category));

    drawTreemap(d.categoryBreakdown, "#chart-category-treemap");
    drawTopProductsTable(d.topProductsByRevenue, "#table-top-products");

    drawHorizontalBars(d.topProductsByUnits, "#chart-units-description", {
      valueKey: "unitsSold",
      labelKey: "description",
      labelFmt: fmt.count,
      axisFmt:  fmt.moneyAxis,
      colour:   "var(--accent)",
      barHeight: 18,
      padding:   0.22,
    });
  }

  function drawTreemap(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 420;

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const root = d3.hierarchy({ children: data })
      .sum((d) => d.revenue)
      .sort((a, b) => b.value - a.value);

    d3.treemap().size([width, height]).paddingInner(3).round(true)(root);

    const cells = svg.append("g").selectAll("g")
      .data(root.leaves()).join("g")
      .attr("transform", (d) => `translate(${d.x0}, ${d.y0})`);

    cells.append("rect")
      .attr("class", "treemap-cell")
      .attr("width", (d) => Math.max(0, d.x1 - d.x0))
      .attr("height", 0)
      .attr("fill", (d) => categoryColor(d.data.category))
      .attr("rx", 4)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">
            <span class="tooltip__swatch" style="background:${categoryColor(d.data.category)}"></span>${d.data.category}
           </div>
           <div class="tooltip__row"><span>Revenue</span><strong>£${fmt.moneyFull(d.data.revenue)}</strong></div>
           <div class="tooltip__row"><span>Units</span><strong>${fmt.count(d.data.unitsSold)}</strong></div>
           <div class="tooltip__row"><span>Products</span><strong>${fmt.count(d.data.products)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 50).ease(d3.easeCubicOut)
      .attr("height", (d) => Math.max(0, d.y1 - d.y0));

    cells.each(function (d) {
      const w = d.x1 - d.x0;
      const h = d.y1 - d.y0;
      const g = d3.select(this);
      if (w < 60 || h < 32) return;

      g.append("text")
        .attr("class", "treemap-label")
        .attr("x", 12).attr("y", 26)
        .attr("font-size", w > 160 ? 18 : 14)
        .attr("opacity", 0)
        .text(d.data.category)
        .transition().delay(700).duration(400).attr("opacity", 1);

      if (h > 54) {
        g.append("text")
          .attr("class", "treemap-value")
          .attr("x", 12).attr("y", w > 160 ? 46 : 42)
          .attr("opacity", 0)
          .text(fmt.money(d.data.revenue))
          .transition().delay(800).duration(400).attr("opacity", 1);
      }
    });
  }

  function drawTopProductsTable(rows, selector) {
    const tbody = document.querySelector(selector + " tbody");
    tbody.innerHTML = "";
    rows.forEach((d, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="td-rank">${String(i + 1).padStart(2, "0")}</span>&nbsp;${d.description}</td>
        <td class="num">${fmt.count(d.unitsSold)}</td>
        <td class="num">£${fmt.moneyFull(d.revenue)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  // =======================================================================
  //  Panel 3 · Customer Analysis  (map with click-zoom)
  // =======================================================================
  function renderCustomerPanel(d) {
    drawCustomerMap(d.customersByCountry, "#chart-customer-map");
    drawTopCustomersTable(d.topCustomers, "#table-top-customers");
    drawCustomersByMonth(d.customersByMonth, "#chart-customers-month");
  }

  function drawCustomerMap(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 480;

    const svg = d3.select(el).append("svg")
      .attr("viewBox", [0, 0, width, height])
      .style("cursor", "grab");

    // Ocean background
    svg.append("rect")
      .attr("class", "map-ocean")
      .attr("width", width).attr("height", height);

    // Projection: NaturalEarth1 (from d3-geo-projection) with fallback
    const projection = (typeof d3.geoNaturalEarth1 === "function")
      ? d3.geoNaturalEarth1()
      : d3.geoEquirectangular();

    projection.fitExtent(
      [[10, 10], [width - 10, height - 10]],
      { type: "Sphere" }
    );

    const pathGen = d3.geoPath(projection);

    const zoomG = svg.append("g").attr("class", "zoom-root");

    const sortedData = [...data].sort((a, b) => b.customers - a.customers);
    const rankByCountry = new Map(sortedData.map((d, i) => [d.country, i + 1]));
    const dataByOurName = new Map(sortedData.map((d) => [d.country, d]));

    const zoom = d3.zoom()
      .scaleExtent([1, 12])
      .translateExtent([[-width * 0.2, -height * 0.2], [width * 1.2, height * 1.2]])
      .on("zoom", (event) => {
        zoomG.attr("transform", event.transform);
        const k = event.transform.k;
        zoomG.selectAll(".map-land").attr("stroke-width", 0.5 / k);
        zoomG.selectAll(".map-bubble").attr("stroke-width", 1.2 / k);
        zoomG.selectAll(".map-label").attr("font-size", Math.max(8, 10 / Math.sqrt(k)));
      });
    svg.call(zoom);

    const resetBtn = document.getElementById("map-reset");
    const detailPanel = document.getElementById("map-detail");
    const detailCloseBtn = document.getElementById("map-detail-close");

    function showResetControls() {
      resetBtn.classList.add("is-visible");
    }
    function resetView() {
      svg.transition().duration(700).ease(d3.easeCubicInOut)
        .call(zoom.transform, d3.zoomIdentity);
      resetBtn.classList.remove("is-visible");
      detailPanel.classList.remove("is-visible");
      zoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
    }
    resetBtn.onclick = resetView;
    detailCloseBtn.onclick = () => {
      detailPanel.classList.remove("is-visible");
      zoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
    };

    function zoomToFeature(feature) {
      const bounds = pathGen.bounds(feature);
      const [[x0, y0], [x1, y1]] = bounds;
      const cx = (x0 + x1) / 2;
      const cy = (y0 + y1) / 2;
      const dx = Math.max(x1 - x0, 1);
      const dy = Math.max(y1 - y0, 1);
      const scale = Math.min(6, 0.55 / Math.max(dx / width, dy / height));
      // The detail panel sits at bottom-left (260×180px). We bias the zoom
      // target upward so the country sits above the panel, not behind it.
      const panelH = 180;
      const panelW = 260;
      const offsetY = -panelH / 3;   // shift up
      const offsetX = panelW / 4;    // shift slightly right
      const tx = width / 2 - scale * cx + offsetX;
      const ty = height / 2 - scale * cy + offsetY;
      svg.transition().duration(800).ease(d3.easeCubicInOut)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    function zoomToPoint(lng, lat, scale = 4.5) {
      const [cx, cy] = projection([lng, lat]);
      const panelH = 180;
      const panelW = 260;
      const offsetY = -panelH / 3;
      const offsetX = panelW / 4;
      const tx = width / 2 - scale * cx + offsetX;
      const ty = height / 2 - scale * cy + offsetY;
      svg.transition().duration(800).ease(d3.easeCubicInOut)
        .call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(scale));
    }

    function populateDetail(countryData) {
      document.getElementById("map-detail-title").textContent = countryData.country;
      document.getElementById("md-customers").textContent = fmt.count(countryData.customers);
      document.getElementById("md-orders").textContent    = fmt.count(countryData.orders);
      document.getElementById("md-revenue").textContent   = "£" + fmt.moneyFull(countryData.revenue);
      const aov = countryData.orders > 0 ? countryData.revenue / countryData.orders : 0;
      const rpc = countryData.customers > 0 ? countryData.revenue / countryData.customers : 0;
      document.getElementById("md-aov").textContent = "£" + fmt.moneyFull(aov);
      document.getElementById("md-rpc").textContent = "£" + fmt.moneyFull(rpc);
      const rank = rankByCountry.get(countryData.country) || "—";
      document.getElementById("md-rank").textContent = `RANK #${rank} OUTSIDE UK`;
      document.getElementById("map-detail-eyebrow").textContent = "SELECTED MARKET";
      detailPanel.classList.add("is-visible");
    }

    function populateDetailEmpty(countryName) {
      document.getElementById("map-detail-title").textContent = countryName;
      document.getElementById("md-customers").textContent = "0";
      document.getElementById("md-orders").textContent    = "0";
      document.getElementById("md-revenue").textContent   = "—";
      document.getElementById("md-aov").textContent       = "—";
      document.getElementById("md-rpc").textContent       = "—";
      document.getElementById("md-rank").textContent      = "NO RECORDED CUSTOMERS";
      document.getElementById("map-detail-eyebrow").textContent = "SELECTED MARKET";
      detailPanel.classList.add("is-visible");
    }

    // Loading placeholder
    const loader = zoomG.append("text")
      .attr("x", width / 2).attr("y", height / 2)
      .attr("text-anchor", "middle")
      .attr("font-family", "var(--font-mono)").attr("font-size", 11)
      .attr("fill", "var(--ink-muted)")
      .text("loading world map…");

    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((world) => {
        loader.remove();
        const countries = topojson.feature(world, world.objects.countries);

        const landSelection = zoomG.append("g").attr("class", "lands")
          .selectAll("path")
          .data(countries.features)
          .join("path")
          .attr("class", "map-land")
          .attr("d", pathGen);

        landSelection.on("click", function (event, feature) {
          event.stopPropagation();
          const topoName = feature.properties.name;
          const ourName = TOPO_TO_NAME[topoName] || topoName;
          zoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
          d3.select(this).classed("is-selected", true);
          zoomToFeature(feature);
          showResetControls();
          const cData = dataByOurName.get(ourName);
          if (cData) populateDetail(cData);
          else populateDetailEmpty(topoName);
        });

        drawBubbles(countries);
      })
      .catch((err) => {
        console.warn("Could not load world map; drawing bubbles without land.", err);
        loader.remove();
        drawBubbles(null);
      });

    function drawBubbles(countries) {
      const maxCustomers = d3.max(sortedData, (d) => d.customers) || 1;
      const radius = d3.scaleSqrt().domain([0, maxCustomers]).range([3, 26]);

      zoomG.append("g").attr("class", "bubbles")
        .selectAll("circle")
        .data(sortedData).join("circle")
        .attr("class", "map-bubble")
        .attr("cx", (d) => projection([d.lng, d.lat])[0])
        .attr("cy", (d) => projection([d.lng, d.lat])[1])
        .attr("r", 0)
        .attr("fill", "var(--accent-2)")
        .attr("fill-opacity", 0.55)
        .attr("stroke", "var(--accent-2)")
        .attr("stroke-width", 1.2)
        .on("mousemove", (event, d) => {
          tooltip.show(
            `<div class="tooltip__title">${d.country}</div>
             <div class="tooltip__row"><span>Customers</span><strong>${fmt.count(d.customers)}</strong></div>
             <div class="tooltip__row"><span>Orders</span><strong>${fmt.count(d.orders)}</strong></div>
             <div class="tooltip__row"><span>Revenue</span><strong>£${fmt.moneyFull(d.revenue)}</strong></div>`,
            event
          );
        })
        .on("mouseleave", () => tooltip.hide())
        .on("click", function (event, d) {
          event.stopPropagation();
          tooltip.hide();

          let feature = null;
          if (countries) {
            const topoName = NAME_TO_TOPO[d.country] || d.country;
            feature = countries.features.find((f) => f.properties.name === topoName);
          }
          if (feature) {
            zoomG.selectAll(".map-land.is-selected").classed("is-selected", false);
            zoomG.selectAll(".map-land")
              .filter((f) => f === feature)
              .classed("is-selected", true);
            zoomToFeature(feature);
          } else {
            zoomToPoint(d.lng, d.lat, 5);
          }
          showResetControls();
          populateDetail(d);
        })
        .transition().duration(700).delay((_, i) => i * 40).ease(d3.easeCubicOut)
        .attr("r", (d) => radius(d.customers));

      const top10 = sortedData.slice(0, 10);
      zoomG.append("g").attr("class", "map-labels")
        .selectAll("text")
        .data(top10).join("text")
        .attr("class", "map-label")
        .attr("x", (d) => projection([d.lng, d.lat])[0])
        .attr("y", (d) => projection([d.lng, d.lat])[1] - radius(d.customers) - 6)
        .attr("text-anchor", "middle")
        .attr("opacity", 0)
        .text((d) => d.country)
        .transition().delay(800).duration(400).attr("opacity", 1);
    }
  }

  function drawTopCustomersTable(rows, selector) {
    const tbody = document.querySelector(selector + " tbody");
    tbody.innerHTML = "";
    rows.forEach((d, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="td-rank">${String(i + 1).padStart(2, "0")}</span>&nbsp;${d.customerId}</td>
        <td>${d.country}</td>
        <td class="num">${fmt.count(d.orders)}</td>
        <td class="num">£${fmt.moneyFull(d.revenue)}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  function drawCustomersByMonth(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 280;
    const margin = { top: 24, right: 24, bottom: 32, left: 48 };

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const x = d3.scaleBand()
      .domain(data.map((d) => d.month))
      .range([margin.left, width - margin.right])
      .padding(0.35);

    const y = d3.scaleLinear()
      .domain([0, d3.max(data, (d) => d.customers) * 1.15])
      .nice()
      .range([height - margin.bottom, margin.top]);

    svg.append("g").selectAll("line")
      .data(y.ticks(4)).join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).tickFormat(monthShort).tickSize(0).tickPadding(10))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).ticks(4).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    svg.append("g").selectAll("rect")
      .data(data).join("rect")
      .attr("class", "bar")
      .attr("x", (d) => x(d.month))
      .attr("width", x.bandwidth())
      .attr("y", height - margin.bottom)
      .attr("height", 0)
      .attr("fill", "var(--accent)")
      .attr("rx", 2)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.month}</div>
           <div class="tooltip__row"><span>Customers</span><strong>${fmt.count(d.customers)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 40).ease(d3.easeCubicOut)
      .attr("y", (d) => y(d.customers))
      .attr("height", (d) => y(0) - y(d.customers));

    svg.append("g").selectAll("text")
      .data(data).join("text")
      .attr("class", "direct-label")
      .attr("x", (d) => x(d.month) + x.bandwidth() / 2)
      .attr("y", (d) => y(d.customers) - 6)
      .attr("text-anchor", "middle")
      .attr("opacity", 0)
      .text((d) => fmt.count(d.customers))
      .transition().delay((_, i) => 500 + i * 40).duration(300)
      .attr("opacity", 1);
  }

  // =======================================================================
  //  Panel 4 · Insights (cancellations + product affinity)
  // =======================================================================
  function renderInsightsPanel(d) {
    drawCancelByCategory(d.cancellationsByCategory, "#chart-cancel-category");
    drawCancelByMonth(d.cancellationsByMonth, "#chart-cancel-month");
    drawProductPairs(d.productPairs, "#pair-list");
  }

  function drawCancelByCategory(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;

    const sorted = [...data].sort((a, b) => b.cancelRate - a.cancelRate);
    const labels = sorted.map((d) => d.category);
    const measured = measureMaxLabelWidth(labels, '"IBM Plex Mono", monospace', 10);
    const marginLeft = Math.min(Math.max(measured + 20, 100), width * 0.45);
    const margin = { top: 10, right: 80, bottom: 26, left: marginLeft };
    const barHeight = 22;
    const padding = 0.28;
    const height = sorted.length * (barHeight / (1 - padding)) + margin.top + margin.bottom;

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const y = d3.scaleBand()
      .domain(sorted.map((d) => d.category))
      .range([margin.top, height - margin.bottom])
      .padding(padding);

    const x = d3.scaleLinear()
      .domain([0, Math.max(d3.max(sorted, (d) => d.cancelRate) * 1.15, 0.01)])
      .range([margin.left, width - margin.right])
      .nice();

    svg.append("g").selectAll("line")
      .data(x.ticks(4)).join("line")
      .attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d))
      .attr("y1", margin.top).attr("y2", height - margin.bottom);

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).ticks(4).tickFormat(fmt.pctShort).tickSize(0).tickPadding(6))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove());

    // Colour ramp: higher rate = warmer (terracotta)
    const maxRate = d3.max(sorted, (d) => d.cancelRate) || 0.01;
    const colourScale = d3.scaleLinear()
      .domain([0, maxRate])
      .range(["#7FA89C", "#D4825E"]);  // sage → terracotta

    svg.append("g").selectAll("rect")
      .data(sorted).join("rect")
      .attr("class", "bar")
      .attr("x", margin.left)
      .attr("y", (d) => y(d.category))
      .attr("height", y.bandwidth())
      .attr("width", 0)
      .attr("fill", (d) => colourScale(d.cancelRate))
      .attr("rx", 1)
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.category}</div>
           <div class="tooltip__row"><span>Cancel rate</span><strong>${fmt.pct(d.cancelRate)}</strong></div>
           <div class="tooltip__row"><span>Cancelled units</span><strong>${fmt.count(d.cancelledUnits)}</strong></div>
           <div class="tooltip__row"><span>Sold units</span><strong>${fmt.count(d.salesUnits)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().duration(700).delay((_, i) => i * 35).ease(d3.easeCubicOut)
      .attr("width", (d) => x(d.cancelRate) - margin.left);

    svg.append("g").selectAll("text")
      .data(sorted).join("text")
      .attr("class", "direct-label")
      .attr("x", (d) => x(d.cancelRate) + 6)
      .attr("y", (d) => y(d.category) + y.bandwidth() / 2 + 4)
      .attr("opacity", 0)
      .text((d) => fmt.pct(d.cancelRate))
      .transition().delay((_, i) => 400 + i * 35).duration(300).attr("opacity", 1);
  }

  function drawCancelByMonth(data, selector) {
    const el = document.querySelector(selector);
    el.innerHTML = "";
    const width = el.clientWidth;
    const height = 280;
    const margin = { top: 24, right: 40, bottom: 32, left: 52 };

    const svg = d3.select(el).append("svg").attr("viewBox", [0, 0, width, height]);

    const x = d3.scalePoint()
      .domain(data.map((d) => d.month))
      .range([margin.left, width - margin.right])
      .padding(0.3);

    const y = d3.scaleLinear()
      .domain([0, Math.max(d3.max(data, (d) => d.cancelRate) * 1.2, 0.01)])
      .nice()
      .range([height - margin.bottom, margin.top]);

    svg.append("g").selectAll("line")
      .data(y.ticks(4)).join("line")
      .attr("class", "gridline")
      .attr("x1", margin.left).attr("x2", width - margin.right)
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d));

    svg.append("g")
      .attr("class", "axis axis--x")
      .attr("transform", `translate(0, ${height - margin.bottom})`)
      .call(d3.axisBottom(x).tickFormat(monthShort).tickSize(0).tickPadding(10))
      .call((g) => g.select(".domain").remove());

    svg.append("g")
      .attr("class", "axis axis--y")
      .attr("transform", `translate(${margin.left}, 0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat(fmt.pctShort).tickSize(0).tickPadding(8))
      .call((g) => g.select(".domain").remove())
      .call((g) => g.selectAll("line").remove());

    const line = d3.line()
      .x((d) => x(d.month))
      .y((d) => y(d.cancelRate))
      .curve(d3.curveMonotoneX);

    const grad = svg.append("defs").append("linearGradient")
      .attr("id", "cancelGrad").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 1);
    grad.append("stop").attr("offset", "0%").attr("stop-color", "#D4825E").attr("stop-opacity", 0.3);
    grad.append("stop").attr("offset", "100%").attr("stop-color", "#D4825E").attr("stop-opacity", 0);

    const area = d3.area()
      .x((d) => x(d.month))
      .y0(height - margin.bottom)
      .y1((d) => y(d.cancelRate))
      .curve(d3.curveMonotoneX);

    svg.append("path").datum(data)
      .attr("class", "area-series")
      .attr("fill", "url(#cancelGrad)")
      .attr("opacity", 1)
      .attr("d", area);

    const path = svg.append("path").datum(data)
      .attr("class", "line-series")
      .attr("stroke", "var(--accent-2)")
      .attr("d", line);

    const totalLength = path.node().getTotalLength();
    path.attr("stroke-dasharray", `${totalLength} ${totalLength}`)
      .attr("stroke-dashoffset", totalLength)
      .transition().duration(900).ease(d3.easeCubicOut)
      .attr("stroke-dashoffset", 0);

    svg.append("g").selectAll("circle")
      .data(data).join("circle")
      .attr("class", "line-dot")
      .attr("cx", (d) => x(d.month))
      .attr("cy", (d) => y(d.cancelRate))
      .attr("r", 0)
      .attr("fill", "var(--accent-2)")
      .on("mousemove", (event, d) => {
        tooltip.show(
          `<div class="tooltip__title">${d.month}</div>
           <div class="tooltip__row"><span>Cancel rate</span><strong>${fmt.pct(d.cancelRate)}</strong></div>
           <div class="tooltip__row"><span>Cancelled</span><strong>${fmt.count(d.cancelledUnits)}</strong></div>
           <div class="tooltip__row"><span>Sold</span><strong>${fmt.count(d.salesUnits)}</strong></div>`,
          event
        );
      })
      .on("mouseleave", () => tooltip.hide())
      .transition().delay((_, i) => 700 + i * 40).duration(300).attr("r", 4);
  }

  function drawProductPairs(pairs, selector) {
    const container = document.querySelector(selector);
    container.innerHTML = "";
    if (!pairs || pairs.length === 0) {
      container.innerHTML = `<p style="padding:1rem;color:var(--ink-muted);
        font-style:italic">No product pair data available.</p>`;
      return;
    }

    const maxCount = pairs[0].count;

    pairs.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "pair-row";

      const bar = document.createElement("div");
      bar.className = "pair-row__bar";
      bar.style.width = `${(p.count / maxCount) * 100}%`;

      row.innerHTML = `
        <span class="pair-row__rank">${String(i + 1).padStart(2, "0")}</span>
        <div class="pair-row__items">
          <span class="pair-row__item" title="${p.productA}">${p.productA}</span>
          <span class="pair-row__item" title="${p.productB}">${p.productB}</span>
        </div>
        <span class="pair-row__count">${fmt.count(p.count)}×</span>
      `;
      row.appendChild(bar);

      row.addEventListener("mousemove", (event) => {
        tooltip.show(
          `<div class="tooltip__title">Bought together</div>
           <div class="tooltip__row" style="flex-direction:column;align-items:flex-start;gap:2px">
             <span>${p.productA}</span>
             <span style="color:var(--accent)">+ ${p.productB}</span>
           </div>
           <div class="tooltip__row" style="margin-top:6px">
             <span>Co-occurrences</span><strong>${fmt.count(p.count)}</strong>
           </div>`,
          event
        );
      });
      row.addEventListener("mouseleave", () => tooltip.hide());

      container.appendChild(row);
    });
  }
})();
