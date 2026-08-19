"use strict";

// Default colors
const DEFAULT_FLOW_COLORS = {
    low: "darkred",
    okay: "green",
    elevated: "darkorange",
    high: "red",
    flood: "magenta",
};
const DEFAULT_LAKE_COLORS = {
    low: "red",
    full: "darkorange",
    high: "green",
    flood: "darkgreen",
    above: "darkred",
};
const DEFAULT_TEMP_COLORS = {
    cold: "blue",
    cool: "green",
    warm: "darkorange",
    hot: "red",
    extreme: "darkred",
};

// Working colors, reset from defaults on each startDashboard call
let FLOW_COLORS;
let LAKE_COLORS;
let TEMP_COLORS;
let DEFAULT_TEMP_THRESH;
let MAX_AGE_MS;

let listElement;
let allSites;
let getCustomData;

export async function startDashboard(configFile, customGetter, root = document.body) {
    const riverConfig = await fetch(new URL(configFile, document.baseURI)).then(response => response.json());
    const defaults = riverConfig.defaults || {};
    const structure = riverConfig.structure;

    // Clear the root element
    root.replaceChildren();

    // Set the title and heading
    if (riverConfig.title != undefined) {
        document.title = riverConfig.title;
    }
    if (riverConfig.heading != undefined) {
        const heading = document.createElement("h1");
        heading.textContent = riverConfig.heading;
        root.appendChild(heading);
    }

    // Core list element for the dashboard (visual layout)
    listElement = document.createElement("ul");
    listElement.className = "bar";
    root.appendChild(listElement);

    // Reset colors from defaults, overriding from the config when provided
    FLOW_COLORS = defaults.flowColors || DEFAULT_FLOW_COLORS;
    LAKE_COLORS = defaults.lakeColors || DEFAULT_LAKE_COLORS;
    TEMP_COLORS = defaults.tempColors || DEFAULT_TEMP_COLORS;
    DEFAULT_TEMP_THRESH = defaults.tempThresholds;
    // Drop USGS readings older than this (hours). Set 0 to keep any age.
    const maxAgeHours = defaults.maxAgeHours != undefined ? defaults.maxAgeHours : 6;
    MAX_AGE_MS = maxAgeHours > 0 ? maxAgeHours * 3600 * 1000 : undefined;
    getCustomData = customGetter;

    // Collect the sites and render the structure
    allSites = collectSites(structure);
    renderStructure(structure, { defaultState: defaults.state });

    if (defaults.refreshSeconds > 0) {
        setInterval(update, defaults.refreshSeconds * 1000);
    }
}

function htmlName(site) { return site.name.replaceAll(" ", "_"); }

function updateComputedSites(latestValues) {
    for (const site of allSites) {
        if (site.compute == undefined) {
            continue;
        }
        const name = htmlName(site);
        const flowField = document.getElementById(`${name}_flow`);
        const siteDiv = document.getElementById(`${name}_div`);
        if (!flowField || !siteDiv) {
            continue;
        }

        const addSiteIds = site.compute.add || [];
        const subtractSiteIds = site.compute.subtract || [];
        const siteIds = addSiteIds.concat(subtractSiteIds);
        Promise.all(siteIds.map(siteId => latestValues[siteId])).then(values => {
            const flows = values.map(value => value[0]);
            const total = flows.some(flow => flow == undefined)
                ? undefined
                : Math.round((flows.slice(0, addSiteIds.length).reduce((sum, flow) => sum + flow, 0)
                    - flows.slice(addSiteIds.length).reduce((sum, flow) => sum + flow, 0)) * 10) / 10;

            if (setField(flowField, total, "cfs")) {
                siteDiv.style.display = "";
                setSiteColor(siteDiv, flowHeightColor(site, total));
            }
            else {
                siteDiv.style.display = "none";
            }
        }).catch(error => console.error(`Error updating ${site.name}:`, error));
    }
}

function setField(field, value, unit) {
    if (!field) {
        return false;
    }
    if (value == undefined) {
        field.style.display = "none";
        return false;
    }
    field.textContent = `${value} ${unit}`;
    field.style.display = "inline";
    return true;
}

function update() {
    // Share requests within this refresh, but fetch fresh values next time.
    const requiredSiteIds = new Set();
    for (const site of allSites) {
        if (site.siteId != undefined) {
            requiredSiteIds.add(site.siteId);
        }
        for (const siteId of site.compute?.add || []) {
            requiredSiteIds.add(siteId);
        }
        for (const siteId of site.compute?.subtract || []) {
            requiredSiteIds.add(siteId);
        }
    }
    const latestValues = {};
    for (const siteId of requiredSiteIds) {
        latestValues[siteId] = getLatestValues(siteId);
    }

    for (const site of allSites) {
        if (site.siteId == undefined || site.compute != undefined) {
            // Skip lakes / computed sites (no USGS site id)
            continue;
        }
        const name = htmlName(site);
        const siteDiv = document.getElementById(`${name}_div`);
        const siteHeading = siteDiv?.getElementsByClassName("siteLabel")[0];
        if (siteDiv == undefined || siteHeading == undefined) {
            console.warn(`Missing dashboard elements for ${site.name}`);
            continue;
        }
        latestValues[site.siteId].then(
            data => {
                const [flow, height, temp] = data;
                const flowField = document.getElementById(`${name}_flow`);
                const heightField = document.getElementById(`${name}_height`);
                const tempField = document.getElementById(`${name}_temp`);

                const hasFlow = setField(flowField, flow, "cfs");
                const hasHeight = setField(heightField, height, "ft");
                const hasTemp = setField(tempField, temp, "\u00b0F");

                let setSiteHeading = false;
                if (hasFlow || hasHeight) {
                    setSiteColor(siteHeading.parentElement, flowHeightColor(site, flow, height));
                    setSiteHeading = true;
                }

                if (hasTemp) {
                    const thresholds = site.tempThresholds || DEFAULT_TEMP_THRESH;
                    const c = colorFromThresholds(temp, thresholds, TEMP_COLORS) || "gray";
                    if (!setSiteHeading) {
                        setSiteColor(siteHeading.parentElement, c);
                    }
                    tempField.style.color = c;
                }

                // Hide the entire item if it has no data
                // Clear display when showing so CSS grid/layout rules still apply
                siteDiv.style.display = (hasFlow || hasHeight || hasTemp) ? "" : "none";
            }
        ).catch(error => console.error(`Error updating ${site.name}:`, error));
    }

    updateComputedSites(latestValues);
    updateCustomSites();
}

function applyLakeData(site, data) {
    const name = htmlName(site);
    const siteDiv = document.getElementById(`${name}_div`);
    const levelField = document.getElementById(`${name}_level`);
    const fillPercentage = document.getElementById(`${name}_fillPct`);
    if (!siteDiv || !levelField || !fillPercentage) {
        console.warn(`Missing lake dashboard elements for ${site.name}`);
        return;
    }

    const level = data.level;
    const pool = site.pool;
    levelField.textContent = `${level} ft`;

    if (pool?.full != undefined && pool.fullStorageAcFt != undefined && pool.surfaceAcres != undefined) {
        // % of full pool ~= conservation storage / full-pool storage
        // (constant surface-area approx using published volume and area)
        const drawdown = pool.full - level;
        const currentStorage = pool.fullStorageAcFt - pool.surfaceAcres * drawdown;
        const percentage = (currentStorage / pool.fullStorageAcFt) * 100;
        fillPercentage.textContent = `${Math.max(0, percentage).toFixed(0)}%`;
        fillPercentage.style.width = `${Math.max(0, Math.min(100, percentage))}%`;

        const diff = level - pool.full;
        const diffText = diff.toFixed(2);
        if (diff > 0) {
            levelField.textContent += ` (+${diffText} ft)`;
        }
        else if (diff < 0) {
            levelField.textContent += ` (${diffText} ft)`;
        }
        else {
            levelField.textContent += " (@ full pool)";
        }
    }

    const color = colorFromThresholds(level, pool, LAKE_COLORS) || "gray";
    siteDiv.parentElement.style.setProperty("--color", color);
    siteDiv.dataset.statusColor = color;
    levelField.style.color = color;
    updateCommonColors();
}

function applyExtraInfo(site, extra) {
    const extraField = document.getElementById(`${htmlName(site)}_extra`);
    if (!extraField || extra?.text == undefined) {
        return;
    }
    extraField.textContent = extra.text;
    if (extra.value != undefined) {
        extraField.style.color = flowHeightColor(site, extra.value);
    }
}

function updateCustomSites() {
    if (getCustomData == undefined) {
        return;
    }

    for (const site of allSites) {
        if (site.source == undefined) {
            continue;
        }
        getCustomData(site).then(data => {
            if (data == undefined) {
                return;
            }
            if (site.type === "lake" && data.level != undefined) {
                applyLakeData(site, data);
            }
            if (data.extra != undefined) {
                applyExtraInfo(site, data.extra);
            }
        }).catch(error => console.error(`Error updating custom data for ${site.name}:`, error));
    }
}

export function parseFlowNumber(flowText) {
    // "246 cfs", "200-300 cfs", "1,200 cfs"
    const cleaned = flowText.replace(/,/g, "").trim();
    const range = cleaned.split(/\s+/)[0].split("-");
    if (range.length === 1) {
        return parseFloat(range[0]);
    }
    if (range.length === 2) {
        return (parseFloat(range[0]) + parseFloat(range[1])) / 2;
    }
    return undefined;
}

export function cfsOnly(flowText) {
    // Keep CFS values only (drop "cfs" / "feet" units from cell text)
    return flowText.replace(/,/g, "").replace(/\s*cfs\s*/i, "").trim();
}

function gaugeUrl(state, siteId, periodDays = 7) {
    return `https://bboudaoud.github.io/USGS-StreamView/gaugeSite.html?state=${state}&site_id=${siteId}&periodDays=${periodDays}`;
}

function getTimeSeries(data, varName) {
    const timeSeries = data?.value?.timeSeries;
    if (!Array.isArray(timeSeries)) {
        return [];
    }
    for (const series of timeSeries) {
        if (series?.variable?.variableName?.includes(varName)) {
            return series.values?.[0]?.value || [];
        }
    }
    return [];
}

function getDataForSite(siteId) {
    const url = `https://waterservices.usgs.gov/nwis/iv/?format=json&sites=${siteId}&parameterCd=00060,00065,00010`;
    return fetch(url).then(response => response.json())
        .then(data => {
            const flowValues = getTimeSeries(data, "Streamflow");
            const heightValues = getTimeSeries(data, "Gage height");
            const tempValues = getTimeSeries(data, "Temperature, water");
            return [flowValues, heightValues, tempValues];
        })
        .catch(error => {
            console.error("Error fetching data:", error);
            return [[], [], []];
        });
}

function latestValue(values, decimals, convert = value => value) {
    if (values.length === 0) {
        return undefined;
    }
    const latest = values[values.length - 1];
    if (MAX_AGE_MS != undefined && latest.dateTime != undefined) {
        const ageMs = Date.now() - new Date(latest.dateTime).getTime();
        if (ageMs > MAX_AGE_MS) {
            return undefined;
        }
    }
    const factor = 10 ** decimals;
    const value = convert(Number(latest.value));
    return Math.round(value * factor) / factor;
}

function getLatestValues(siteId) {
    return getDataForSite(siteId).then(data => {
        const [flowValues, heightValues, tempValues] = data;
        const flow = latestValue(flowValues, 1);
        const height = latestValue(heightValues, 2);
        const temp = latestValue(tempValues, 2, value => value * 9 / 5 + 32);
        return [flow, height, temp];
    });
}

function collectSites(structure) {
    const sites = [];
    for (const item of structure) {
        if (item.type === "fork") {
            for (const branch of item.branches) {
                sites.push(branch);
            }
        }
        else if (item.type === "inflow") {
            sites.push(item.tributary);
        }
        else {
            sites.push(item);
        }
    }
    return sites;
}

function createSiteElement(site, options = {}) {
    const name = htmlName(site);
    const siteDiv = document.createElement("div");
    siteDiv.id = `${name}_div`;
    siteDiv.className = "siteDiv";

    let siteUrl = site.url;
    const state = site.state || options.defaultState;
    if (siteUrl == undefined && site.siteId != undefined && state != undefined) {
        siteUrl = gaugeUrl(state, site.siteId);
    }
    const labelHtml = siteUrl != undefined
        ? `<h2 class="siteLabel"><a href=${siteUrl} target="_blank">${site.name}</a></h2>`
        : `<h2 class="siteLabel">${site.name}</h2>`;

    if (site.type === "lake") {
        siteDiv.innerHTML = `${labelHtml}
        <div class="lake-fill">
            <div class="fill-percentage" id="${name}_fillPct">--%</div>
        </div>
        <p class="siteData lake-level" id="${name}_level">-- ft</p>`;
    }
    else {
        const showHeight = site.showHeight !== false;
        const showTemp = site.showTemp !== false;
        let statsHtml = `<p class="siteData" id=${name}_flow>-- cfs</p>`;
        if (showHeight) {
            statsHtml += `<p class="siteData" id=${name}_height>-- ft</p>`;
        }
        if (showTemp) {
            statsHtml += `<p class="siteData" id=${name}_temp>-- \u00b0F</p>`;
        }
        if (site.extra != undefined) {
            const placeholder = site.extra.placeholder || "--";
            statsHtml += `<br><p class="siteData siteExtra" id=${name}_extra style="color:gray">${placeholder}</p>`;
        }
        siteDiv.innerHTML = `${labelHtml}<div class="siteStats">${statsHtml}</div>`;
    }

    return siteDiv;
}

function renderStructure(structure, options = {}) {
    for (const item of structure) {
        const li = document.createElement("li");

        if (item.type === "fork") {
            li.className = "fork-container";
            const forkDiv = document.createElement("div");
            forkDiv.className = "fork";

            const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
            svg.setAttribute("class", "fork-lines");
            svg.setAttribute("viewBox", "0 0 200 80");
            svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
            svg.innerHTML = `
            <line class="fork-line left" x1="70" y1="16" x2="100" y2="55" />
            <line class="fork-line right" x1="130" y1="16" x2="100" y2="55" />
            <line class="fork-line stem" x1="100" y1="55" x2="100" y2="80" />
            <circle class="fork-dot left" cx="70" cy="16" r="8" />
            <circle class="fork-dot right" cx="130" cy="16" r="8" />
        `;
            forkDiv.appendChild(svg);

            item.branches.forEach((branch, idx) => {
                const branchDiv = document.createElement("div");
                branchDiv.className = idx === 0 ? "branch left" : "branch right";
                branchDiv.appendChild(createSiteElement(branch, options));
                forkDiv.appendChild(branchDiv);
            });
            li.appendChild(forkDiv);
        }
        else if (item.type === "lake") {
            li.className = "lake-container";
            li.appendChild(createSiteElement(item, options));
        }
        else if (item.type === "inflow") {
            li.className = "inflow-container";
            const inflowDiv = document.createElement("div");
            inflowDiv.className = "inflow";
            const tributaryDiv = document.createElement("div");
            tributaryDiv.className = "tributary";
            const junction = document.createElement("div");
            junction.className = "inflow-junction";
            tributaryDiv.appendChild(junction);
            tributaryDiv.appendChild(createSiteElement(item.tributary, options));
            inflowDiv.appendChild(tributaryDiv);
            li.appendChild(inflowDiv);
        }
        else if (item.type === "terminal") {
            li.className = "terminal-container";
            li.appendChild(createSiteElement(item, options));
        }
        else {
            li.appendChild(createSiteElement(item, options));
        }

        listElement.appendChild(li);
    }

    // Do an initial update to update contents
    update();
}

function colorFromThresholds(value, thresholds, colors) {
    if (value == undefined || thresholds == undefined || colors == undefined) {
        return undefined;
    }

    // Named: {"low": 50, "okay": 200, ...} matched by color key
    // List:  [50, 200, ...] matched by position to color order
    if (!Array.isArray(thresholds)) {
        const colorKeys = Object.keys(colors);
        for (const key of colorKeys) {
            if (thresholds[key] != undefined && value < thresholds[key]) {
                return colors[key];
            }
        }
        return colors[colorKeys[colorKeys.length - 1]];
    }

    const colorValues = Array.isArray(colors) ? colors : Object.values(colors);
    for (let i = 0; i < thresholds.length; i++) {
        if (value < thresholds[i]) {
            return colorValues[i];
        }
    }
    return colorValues[colorValues.length - 1];
}

function flowHeightColor(site, flow, height, colors = FLOW_COLORS) {
    if (site?.flowThresholds != undefined && flow != undefined) {
        return colorFromThresholds(flow, site.flowThresholds, colors);
    }
    if (site?.heightThresholds != undefined && height != undefined) {
        return colorFromThresholds(height, site.heightThresholds, colors);
    }
}

function getMainColor(item) {
    if (item.classList.contains("fork-container")) {
        const branchColors = Array.from(item.querySelectorAll(".branch .siteDiv"))
            .map(siteDiv => siteDiv.dataset.statusColor);
        if (branchColors.length === 2 && branchColors[0] != undefined && branchColors[0] === branchColors[1]) {
            return branchColors[0];
        }
        return undefined;
    }
    if (item.classList.contains("inflow-container")) {
        return undefined;
    }
    const siteDiv = item.querySelector(".siteDiv");
    return siteDiv ? siteDiv.dataset.statusColor : undefined;
}

const rgbCache = new Map();
let rgbProbe;

function parseRgb(color) {
    if (rgbCache.has(color)) {
        return rgbCache.get(color);
    }
    if (rgbProbe == undefined) {
        rgbProbe = document.createElement("span");
        rgbProbe.style.display = "none";
        document.body.appendChild(rgbProbe);
    }
    rgbProbe.style.color = color;
    const match = getComputedStyle(rgbProbe).color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    const rgb = match
        ? [Number(match[1]), Number(match[2]), Number(match[3])]
        : undefined;
    rgbCache.set(color, rgb);
    return rgb;
}

function blendColors(colorA, colorB, amount) {
    if (colorA == undefined) {
        return colorB;
    }
    if (colorB == undefined || colorA === colorB || amount <= 0) {
        return colorA;
    }
    if (amount >= 1) {
        return colorB;
    }
    const rgbA = parseRgb(colorA);
    const rgbB = parseRgb(colorB);
    if (rgbA == undefined || rgbB == undefined) {
        return colorA;
    }
    const r = Math.round(rgbA[0] + (rgbB[0] - rgbA[0]) * amount);
    const g = Math.round(rgbA[1] + (rgbB[1] - rgbA[1]) * amount);
    const b = Math.round(rgbA[2] + (rgbB[2] - rgbA[2]) * amount);
    return `rgb(${r}, ${g}, ${b})`;
}

function findNeighbor(colors, start, step) {
    for (let index = start + step; index >= 0 && index < colors.length; index += step) {
        if (colors[index] != undefined) {
            return { index, color: colors[index] };
        }
    }
    return { index: -1, color: undefined };
}

function updateCommonColors() {
    const fork = listElement.querySelector(".fork-container");
    if (fork) {
        const stem = fork.querySelector(".fork-line.stem");
        const branchColors = Array.from(fork.querySelectorAll(".branch .siteDiv"))
            .map(siteDiv => siteDiv.dataset.statusColor);
        if (branchColors.length === 2 && branchColors[0] != undefined && branchColors[1] != undefined) {
            stem.style.stroke = blendColors(branchColors[0], branchColors[1], 0.5);
        }
        else {
            stem.style.removeProperty("stroke");
        }
    }

    const items = Array.from(listElement.children);
    const knownColors = items.map(getMainColor);
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (knownColors[i] != undefined || item.classList.contains("fork-container") || item.classList.contains("lake-container")) {
            continue;
        }

        const above = findNeighbor(knownColors, i, -1);
        const below = findNeighbor(knownColors, i, 1);

        if (above.color != undefined && below.color != undefined) {
            const amount = (i - above.index) / (below.index - above.index);
            item.style.setProperty("--color", blendColors(above.color, below.color, amount));
        }
        else if (above.color != undefined) {
            item.style.setProperty("--color", above.color);
        }
        else if (below.color != undefined) {
            item.style.setProperty("--color", below.color);
        }
        else {
            item.style.removeProperty("--color");
        }
    }
}

function setSiteColor(siteDiv, color) {
    if (color == undefined) {
        delete siteDiv.dataset.statusColor;
        updateCommonColors();
        return;
    }

    siteDiv.dataset.statusColor = color;
    siteDiv.style.color = color;
    const dataFields = siteDiv.querySelectorAll(".siteData");
    for (const dataField of dataFields) {
        dataField.style.color = color;
    }

    const parent = siteDiv.parentElement;
    if (parent?.classList.contains("branch")) {
        parent.style.setProperty("--color", color);
        const side = parent.classList.contains("left") ? "left" : "right";
        const svg = parent.parentElement.querySelector(".fork-lines");
        const dot = svg?.querySelector(`.fork-dot.${side}`);
        const line = svg?.querySelector(`.fork-line.${side}`);
        if (dot) {
            dot.style.fill = color;
        }
        if (line) {
            line.style.stroke = color;
        }
    }
    else if (parent?.classList.contains("tributary")) {
        parent.style.setProperty("--tributary-color", color);
        parent.style.color = color;
    }
    else if (parent) {
        parent.style.setProperty("--color", color);
    }

    updateCommonColors();
}