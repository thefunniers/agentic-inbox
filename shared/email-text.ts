// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

import { Parser } from "htmlparser2";

const NON_CONTENT_TAGS = new Set([
	"head", "title", "style", "script", "template", "noscript",
	"iframe", "object", "svg", "math", "xml",
]);

const BLOCK_TAGS = new Set([
	"address", "article", "aside", "blockquote", "div", "dl", "dt", "dd",
	"fieldset", "figcaption", "figure", "footer", "form", "header",
	"h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "main", "nav",
	"ol", "p", "pre", "section", "table", "tr", "ul",
]);

/**
 * Extract readable email text without a browser DOM. Never render the source:
 * comments, head metadata, scripts and styles cannot become quoted content.
 * Callers embedding this text in HTML must still escape it.
 */
export function emailBodyToText(body: string): string {
	if (!body) return "";
	// Plain-text emails may contain addresses in angle brackets or comparisons.
	if (!/<(?:!doctype\b|!--|\/?[a-z][a-z0-9:-]*(?:\s[^<>]*|)\/?>)/i.test(body)) {
		return body.trim();
	}

	const parts: string[] = [];
	let ignoredDepth = 0;
	const lineBreak = (count = 1) => {
		const trailing = parts.at(-1)?.match(/\n*$/)?.[0].length ?? 0;
		if (trailing < count) parts.push("\n".repeat(count - trailing));
	};
	const parser = new Parser({
		onopentag(name) {
			if (ignoredDepth > 0 || NON_CONTENT_TAGS.has(name)) {
				ignoredDepth++;
				return;
			}
			if (name === "br" || BLOCK_TAGS.has(name)) {
				lineBreak(name === "p" ? 2 : 1);
			}
		},
		ontext(text) {
			if (ignoredDepth === 0) parts.push(text);
		},
		onclosetag(name) {
			if (ignoredDepth > 0) {
				ignoredDepth--;
				return;
			}
			if (BLOCK_TAGS.has(name)) lineBreak(name === "p" ? 2 : 1);
			else if (name === "td" || name === "th") parts.push(" ");
		},
	}, { decodeEntities: true });
	parser.end(body);

	return parts.join("")
		.replace(/\r\n?/g, "\n")
		.replace(/[\t\f\v \u00a0]+/g, " ")
		.replace(/ *\n */g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
