import { defineConfig } from "cf/config";

// summonghost.com: static files only. There is no Worker script and no binding;
// public/_headers sets the response headers. `publish.sh` deploys it.
export default defineConfig({
	worker: {
		name: "summonghost",
		compatibilityDate: "2025-12-23",
		assets: { htmlHandling: "auto-trailing-slash", notFoundHandling: "404-page" },
		previewUrls: false,
		domains: ["summonghost.com", "www.summonghost.com"],
		workersDev: false,
	},
});
