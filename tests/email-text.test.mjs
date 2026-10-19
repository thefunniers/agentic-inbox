import assert from "node:assert/strict";
import test from "node:test";
import { emailBodyToText } from "../shared/email-text.ts";

test("Office email quotes contain body text, not CSS, comments or head metadata", () => {
	const html = `<!doctype html><html><head><title>Internal title</title>
		<!--[if gte mso 9]><xml><o:PixelsPerInch>96</o:PixelsPerInch></xml><![endif]-->
		<style>/*email layout style */ .offer { color: red }</style>
		<script>throw new Error('must not run')</script></head>
		<body><p>Dear applicant,</p><p>Your <strong>offer</strong> is ready.</p></body></html>`;
	assert.equal(emailBodyToText(html), "Dear applicant,\n\nYour offer is ready.");
});

test("entities decode once, including Chinese, supplementary characters and literal markup", () => {
	assert.equal(emailBodyToText("<p>录取 &amp; O&rsquo;Brien &#x1f389; &#128512; &lt;script&gt; &amp;lt;</p>"),
		"录取 & O’Brien 🎉 😀 <script> &lt;");
});

test("paragraphs, line breaks, list items and table cells remain separated", () => {
	assert.equal(emailBodyToText("<div>Hello<br>World</div><p>Next paragraph</p><ul><li>First</li><li>Second</li></ul><table><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></table>"),
		"Hello\nWorld\n\nNext paragraph\n\nFirst\nSecond\nA B\nC D");
});

test("quoted attributes, mixed-case tags and hidden subtrees cannot leak into quotes", () => {
	assert.equal(emailBodyToText(`<DIV title="1 > 0">Hello <span>world</span></DIV>
		<STYLE>.hidden { display: none }</STYLE><template><div>hidden template</div></template>
		<xml><version>96</version></xml><script>bad()</script><p>Goodbye</p>`),
		"Hello world\n\nGoodbye");
});

test("incomplete non-content blocks are discarded through the end of input", () => {
	assert.equal(emailBodyToText("<p>Visible</p><style>never closed { color: red }"), "Visible");
	assert.equal(emailBodyToText("<head><title>Internal"), "");
	assert.equal(emailBodyToText("<p>Visible</p><!-- unfinished private comment"), "Visible");
});

test("plain text keeps its line breaks, angle-bracket addresses and comparisons", () => {
	const plain = "Hello <person@example.com>\n\n2 < 3 and 4 > 1";
	assert.equal(emailBodyToText(plain), plain);
	assert.equal(emailBodyToText(""), "");
});
