"use strict";

// Generic river dashboard entry point.
// Point startDashboard at your river config JSON, and optionally pass a
// customGetter for non-USGS sources (lakes, dam projections, etc.).

import { startDashboard } from "./river.js";

try {
    await startDashboard("./river.json");
}
catch (error) {
    console.error(error);
    document.body.textContent = `Failed to start dashboard: ${error.message}`;
}
