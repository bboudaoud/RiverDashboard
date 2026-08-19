"use strict";

// Generic river dashboard entry point.
// Host pages can set data-config on the script tag (defaults to ./river.json),
// or import { boot } and call it with a config path / customGetter.

import { startDashboard } from "./river.js";

function ensureStyles() {
    const href = new URL("../style.css", import.meta.url).href;
    if ([...document.querySelectorAll("link[rel=stylesheet]")].some(link => link.href === href)) {
        return;
    }
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
}

export async function boot(configFile = "./river.json", customGetter, root = document.body) {
    ensureStyles();
    try {
        await startDashboard(configFile, customGetter, root);
    }
    catch (error) {
        console.error(error);
        root.textContent = `Failed to start dashboard: ${error.message}`;
    }
}

const entryScript = [...document.querySelectorAll("script[type=module]")].find(
    script => script.src === import.meta.url
);

if (entryScript) {
    await boot(entryScript.dataset.config || "./river.json");
}
