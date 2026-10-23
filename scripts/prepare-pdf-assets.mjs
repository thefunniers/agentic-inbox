import { cp, mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Serve PDF fonts, character maps and decoders from this app, including offline
// development. Keep their version aligned with the pinned renderer dependency.
const source = fileURLToPath(new URL("../node_modules/pdfjs-dist/", import.meta.url));
const { version } = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const destination = fileURLToPath(new URL(`../public/pdfjs/${version}/`, import.meta.url));
await mkdir(destination, { recursive: true });
for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
	await cp(join(source, directory), join(destination, directory), { recursive: true });
}
