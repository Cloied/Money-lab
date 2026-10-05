/**
 * Money Lab image rendering
 *
 * The agent designs an image in HTML/CSS (text, colours, shapes, SVG, its
 * own screenshots) and the server's Chrome renders it to a PNG at the size
 * a network expects: share cards, square posts, stories, banners. Free: no
 * image model, no account. The result is shown back to the agent.
 */

import fs from "fs";
import path from "path";
import { chromium } from "playwright-core";
import { isRuntimePath } from "./guard.js";

export const IMAGE_PRESETS: Record<string, [number, number]> = {
  og: [1200, 630],
  square: [1080, 1080],
  portrait: [1080, 1350],
  story: [1080, 1920],
  banner: [1500, 500],
};
const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/;

export function imagesDir(home = process.env.HOME || "/root"): string {
  return path.join(home, "images");
}

export type RenderFn = (url: string, out: string, width: number, height: number) => Promise<void>;

/** Exact-size screenshot (Chrome's own --screenshot leaves a blank band in headless mode). */
export function playwrightRender(browser: string): RenderFn {
  return async (url, out, width, height) => {
    const instance = await chromium.launch({ executablePath: browser, headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    try {
      const page = await instance.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
      await page.goto(url, { waitUntil: "load", timeout: 20_000 });
      await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => undefined);
      await page.screenshot({ path: out, clip: { x: 0, y: 0, width, height } });
    } finally {
      await instance.close();
    }
  };
}

export async function renderImage(
  input: { name: string; html?: string; file?: string; preset?: string; width?: number; height?: number },
  options: { render: RenderFn; home: string },
): Promise<string> {
  if (!NAME.test(input.name)) return "name must be 1-60 lowercase letters, digits or dashes (e.g. og-devis-plombier).";
  let [width, height] = IMAGE_PRESETS[input.preset ?? ""] ?? [Number(input.width), Number(input.height)];
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100 || width > 3000 || height > 3000) {
    return `Choose a preset (${Object.entries(IMAGE_PRESETS).map(([k, [w, h]]) => `${k} ${w}x${h}`).join(", ")}) or width and height between 100 and 3000.`;
  }
  const dir = imagesDir(options.home);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  let source: string;
  if (input.html) {
    source = path.join(dir, "src", `${input.name}.html`);
    const html = /<html[\s>]/i.test(input.html)
      ? input.html
      : `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}</style></head><body>${input.html}</body></html>`;
    fs.writeFileSync(source, html);
  } else if (input.file) {
    source = path.resolve(options.home, input.file.replace(/^~(?=$|\/)/, options.home));
    if (!source.startsWith(options.home + path.sep) || isRuntimePath(source) || !fs.existsSync(source)) return "file must be an existing HTML file in your home directory.";
  } else {
    return "Give html (the design) or file (an HTML file in your home directory).";
  }
  const out = path.join(dir, `${input.name}.png`);
  fs.rmSync(out, { force: true });
  try {
    await options.render(`file://${source}`, out, width, height);
  } catch (err: any) {
    return `Rendering failed: ${String(err?.message ?? err).split("\n")[0].slice(0, 300)}`;
  }
  if (!fs.existsSync(out)) return "Rendering failed: no image produced.";
  const kb = Math.round(fs.statSync(out).size / 1024);
  return `Image ${out} (${width}x${height}, ${kb} KB) attached below. Check the text is readable at phone size.\n[[image:${out}]]`;
}
