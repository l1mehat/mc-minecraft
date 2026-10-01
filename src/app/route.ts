import { readFile } from "node:fs/promises";
import path from "node:path";

export const dynamic = "force-dynamic";

// Serwuje grę (index.html leży w katalogu głównym projektu – ten sam plik uruchamia też server.js)
export async function GET() {
  const html = await readFile(path.join(process.cwd(), "index.html"), "utf8");
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}
