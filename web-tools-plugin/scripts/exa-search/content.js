#!/usr/bin/env node

const args = process.argv.slice(2);

// Parse --highlights flag
const highlightsIndex = args.indexOf("--highlights");
const useHighlights = highlightsIndex !== -1;
if (useHighlights) args.splice(highlightsIndex, 1);

// Parse --fresh flag (livecrawl, maxAgeHours=0)
const freshIndex = args.indexOf("--fresh");
const forceFresh = freshIndex !== -1;
if (forceFresh) args.splice(freshIndex, 1);

const urls = args.filter(a => a.startsWith("http"));

if (urls.length === 0) {
	console.log("Usage: content.js <url> [url2 ...] [options]");
	console.log("\nExtracts content from URLs via Exa API.");
	console.log("\nOptions:");
	console.log("  --highlights    Return key excerpts instead of full text");
	console.log("  --fresh         Force livecrawl (ignore cache)");
	console.log("\nEnvironment:");
	console.log("  EXA_API_KEY     Required. Your Exa API key.");
	console.log("\nExamples:");
	console.log("  content.js https://example.com/article");
	console.log("  content.js https://example.com/a https://example.com/b --highlights");
	console.log("  content.js https://example.com/live-data --fresh");
	process.exit(1);
}

const apiKey = process.env.EXA_API_KEY;
if (!apiKey) {
	console.error("Error: EXA_API_KEY environment variable is required.");
	console.error("Get your API key at: https://dashboard.exa.ai/api-keys");
	process.exit(1);
}

async function getContents(urls) {
	const body = {
		urls,
	};

	if (useHighlights) {
		body.highlights = { max_characters: 4000 };
	} else {
		body.text = { max_characters: 20000 };
	}

	if (forceFresh) {
		body.maxAgeHours = 0;
	}

	const response = await fetch("https://api.exa.ai/contents", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
	}

	return response.json();
}

// Main
try {
	const data = await getContents(urls);
	const results = data.results || [];

	if (results.length === 0) {
		console.error("Could not extract content from the provided URLs.");
		process.exit(1);
	}

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		if (results.length > 1) {
			console.log(`--- Page ${i + 1} ---`);
		}
		if (r.title) {
			console.log(`# ${r.title}\n`);
		}
		console.log(`URL: ${r.url}`);
		if (r.author) {
			console.log(`Author: ${r.author}`);
		}
		if (r.publishedDate) {
			console.log(`Published: ${r.publishedDate}`);
		}
		console.log("");
		if (r.highlights && r.highlights.length > 0) {
			console.log(r.highlights.join("\n\n---\n\n"));
		} else if (r.text) {
			console.log(r.text);
		} else {
			console.log("(No content extracted)");
		}
		if (results.length > 1) console.log("");
	}
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}
