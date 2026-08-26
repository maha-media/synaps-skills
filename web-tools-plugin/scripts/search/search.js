#!/usr/bin/env node

import { extractHost, recallAndEmit, failAndExit } from "../_lib/hooks.mjs";

const args = process.argv.slice(2);

// Parse --content flag
const contentIndex = args.indexOf("--content");
const fetchContent = contentIndex !== -1;
if (fetchContent) args.splice(contentIndex, 1);

// Parse --highlights flag
const highlightsIndex = args.indexOf("--highlights");
const useHighlights = highlightsIndex !== -1;
if (useHighlights) args.splice(highlightsIndex, 1);

// Parse -n <num>
let numResults = 5;
const nIndex = args.indexOf("-n");
if (nIndex !== -1 && args[nIndex + 1]) {
	numResults = parseInt(args[nIndex + 1], 10);
	args.splice(nIndex, 2);
}

// Parse search type flags (mutually exclusive, last one wins)
let searchType = "auto";
const typeFlags = {
	"--instant": "fast",
	"--fast": "fast",
	"--auto": "auto",
	"--deep": "deep",
	"--deep-reasoning": "deep-reasoning",
};
for (const [flag, type] of Object.entries(typeFlags)) {
	const fi = args.indexOf(flag);
	if (fi !== -1) {
		searchType = type;
		args.splice(fi, 1);
	}
}

// Parse --category <category>
let category = null;
const catIndex = args.indexOf("--category");
if (catIndex !== -1 && args[catIndex + 1]) {
	category = args[catIndex + 1];
	args.splice(catIndex, 2);
}

// Parse --freshness <pd|pw|pm|py|YYYY-MM-DDtoYYYY-MM-DD>
let freshness = null;
const freshnessIndex = args.indexOf("--freshness");
if (freshnessIndex !== -1 && args[freshnessIndex + 1]) {
	freshness = args[freshnessIndex + 1];
	args.splice(freshnessIndex, 2);
}

// Parse --domain <domain> (repeatable)
let includeDomains = [];
let idx;
while ((idx = args.indexOf("--domain")) !== -1) {
	if (args[idx + 1]) {
		includeDomains.push(args[idx + 1]);
		args.splice(idx, 2);
	} else {
		args.splice(idx, 1);
	}
}

// Parse --exclude <domain> (repeatable)
let excludeDomains = [];
while ((idx = args.indexOf("--exclude")) !== -1) {
	if (args[idx + 1]) {
		excludeDomains.push(args[idx + 1]);
		args.splice(idx, 2);
	} else {
		args.splice(idx, 1);
	}
}

const query = args.join(" ");

if (!query) {
	console.log("Usage: search.js <query> [options]");
	console.log("\nOptions:");
	console.log("  -n <num>              Number of results (default: 5)");
	console.log("  --content             Include full page text (via Exa)");
	console.log("  --highlights          Include key excerpts instead of full text");
	console.log("  --instant             Fastest search (alias for --fast)");
	console.log("  --fast                Fast search, basic depth");
	console.log("  --auto                Balanced relevance & speed (default)");
	console.log("  --deep                Thorough search, multiple query variations");
	console.log("  --deep-reasoning      Complex research, multi-step reasoning");
	console.log("  --category <cat>      Category: news, research paper, company, people");
	console.log("  --freshness <period>  Filter by time: pd (day), pw (week), pm (month), py (year)");
	console.log("                        or YYYY-MM-DDtoYYYY-MM-DD for date range");
	console.log("  --domain <domain>     Include domain (repeatable)");
	console.log("  --exclude <domain>    Exclude domain (repeatable)");
	console.log("\nEnvironment:");
	console.log("  EXA_API_KEY           Optional. Your Exa API key for richer ranking/content.");
	console.log("                        If unset, falls back to a free DuckDuckGo search.");
	console.log("\nExamples:");
	console.log('  search.js "javascript async await"');
	console.log('  search.js "rust programming" -n 10 --content');
	console.log('  search.js "AI news" --category news --freshness pw');
	console.log('  search.js "react hooks" --domain github.com --domain stackoverflow.com');
	console.log('  search.js "transformer papers" --deep --highlights');
	console.log('  search.js "complex AI topic" --deep-reasoning --content');
	console.log('  search.js "quick lookup" --instant');
	process.exit(1);
}

const HOST = "api.exa.ai";
const OP = "search";

// PRE — recall on the query itself + domain hints
const recallTags = [];
for (const d of includeDomains) {
	const h = extractHost(d) || d;
	if (h) recallTags.push(`domain-${h.replace(/\./g, "-")}`);
}
recallAndEmit(query, { host: HOST, op: OP, tags: recallTags });

const apiKey = process.env.EXA_API_KEY;
// Keyless fallback: when no Exa key is configured, degrade to a free
// DuckDuckGo HTML search instead of hard-failing. Exa (when keyed) gives
// richer ranking/freshness/content; DDG covers the no-key case with the SAME
// output contract so downstream agents don't care which backend answered.
const useExa = !!apiKey;

function parseFreshness(value) {
	const now = new Date();
	const map = { pd: 1, pw: 7, pm: 30, py: 365 };

	if (map[value]) {
		const start = new Date(now);
		start.setDate(start.getDate() - map[value]);
		return { start_published_date: start.toISOString() };
	}

	const match = value.match(/^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/);
	if (match) {
		return {
			start_published_date: new Date(match[1]).toISOString(),
			end_published_date: new Date(match[2]).toISOString(),
		};
	}
	return {};
}

async function searchExa() {
	const body = {
		query,
		num_results: numResults,
		type: searchType,
	};

	if (fetchContent || useHighlights) {
		body.contents = {};
		if (useHighlights) {
			body.contents.highlights = { max_characters: 4000 };
		} else {
			body.contents.text = { max_characters: 5000 };
		}
	}

	if (freshness) Object.assign(body, parseFreshness(freshness));
	if (category) body.category = category;
	if (includeDomains.length > 0) body.include_domains = includeDomains;
	if (excludeDomains.length > 0) body.exclude_domains = excludeDomains;

	const response = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		const e = new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
		e.statusCode = response.status;
		throw e;
	}

	return response.json();
}

// ── Keyless DuckDuckGo fallback ──────────────────────────────────────────────
// Scrapes the DDG HTML endpoint (no API key). Returns the SAME { results: [...] }
// shape searchExa() produces so the emit loop below is backend-agnostic. This is
// the same engine jawz-web uses; good enough for discovery + snippets, and the
// agent can always fetch the returned URLs for full content.
function stripHtml(s) {
	return String(s || "")
		.replace(/<[^>]+>/g, "")
		.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
		.replace(/\s+/g, " ").trim();
}

function decodeDdgUrl(href) {
	if (!href) return "";
	const m = href.match(/[?&]uddg=([^&]+)/);
	if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
	if (href.startsWith("//")) return "https:" + href;
	return href;
}

async function searchDdg() {
	// DDG supports site: operators inline; fold domain include/exclude into the query.
	let q = query;
	if (includeDomains.length > 0) q += " " + includeDomains.map((d) => `site:${d}`).join(" OR ");
	for (const d of excludeDomains) q += ` -site:${d}`;

	const dfMap = { pd: "d", pw: "w", pm: "m", py: "y" };
	const df = freshness && dfMap[freshness] ? dfMap[freshness] : "";

	const form = new URLSearchParams({ q, kl: "us-en" });
	if (df) form.set("df", df);

	const response = await fetch("https://html.duckduckgo.com/html/", {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36",
		},
		body: form.toString(),
	});
	if (!response.ok) {
		const e = new Error(`HTTP ${response.status}: ${response.statusText}`);
		e.statusCode = response.status;
		throw e;
	}
	const html = await response.text();

	// Each organic result: an anchor with class result__a (title+link) followed by
	// a result__snippet. Walk the anchors in order and pair the nearest snippet.
	const results = [];
	const anchorRe = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
	const snippetRe = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
	const snippets = [];
	let sm;
	while ((sm = snippetRe.exec(html)) !== null) snippets.push(stripHtml(sm[1]));
	let am, i = 0;
	while ((am = anchorRe.exec(html)) !== null && results.length < numResults) {
		const url = decodeDdgUrl(am[1]);
		const title = stripHtml(am[2]);
		if (!url || !title) { i++; continue; }
		results.push({ url, title, text: snippets[i] || "" });
		i++;
	}
	return { results };
}

// Main
try {
	const data = useExa ? await searchExa() : await searchDdg();
	const results = data.results || [];

	if (results.length === 0) {
		console.error("No results found.");
		process.exit(0);
	}

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		console.log(`--- Result ${i + 1} ---`);
		console.log(`Title: ${r.title || "(no title)"}`);
		console.log(`Link: ${r.url}`);
		if (r.publishedDate) console.log(`Published: ${r.publishedDate}`);
		if (r.author) console.log(`Author: ${r.author}`);
		if (r.score != null) console.log(`Score: ${r.score.toFixed(3)}`);
		if (r.highlights && r.highlights.length > 0) {
			console.log(`Highlights:\n${r.highlights.join("\n---\n")}`);
		}
		if (r.text) console.log(`Content:\n${r.text}`);
		console.log("");
	}
} catch (e) {
	failAndExit({
		host: HOST, op: OP,
		err: e,
		cmd: `search.js ${query.slice(0, 60)}`,
		args: { query: query.slice(0, 200), numResults, searchType, includeDomains, excludeDomains, fetchContent, useHighlights },
	});
}
