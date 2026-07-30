import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { SnapshotProvider, UsageViewModel } from "./types.js";

function setSecurityHeaders(response: ServerResponse, nonce: string): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
}

function writeJson(response: ServerResponse, status: number, value: object): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
}

function html(view: UsageViewModel, nonce: string): string {
  const official = view.officialCredit.status === "available"
    ? `<dl><dt>Limit</dt><dd>${escapeHtml(view.officialCredit.limit)}</dd><dt>Used</dt><dd>${escapeHtml(view.officialCredit.used)}</dd><dt>Remaining credit</dt><dd>${escapeHtml(view.officialCredit.remaining)}</dd><dt>Remaining</dt><dd>${escapeHtml(String(view.officialCredit.remainingPercent))}%</dd><dt>Resets</dt><dd>${escapeHtml(view.officialCredit.resetsAt)}</dd></dl>`
    : "<p>Official credit is unavailable.</p>";
  const estimates = view.estimatedCreditAttribution.length > 0
    ? `<table><thead><tr><th>Model</th><th>Estimated credits</th></tr></thead><tbody>${view.estimatedCreditAttribution.map((row) => `<tr><td>${escapeHtml(row.model)}</td><td>${escapeHtml(row.credits)}</td></tr>`).join("")}</tbody></table>`
    : "<p>Estimated credit attribution is unavailable.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Auto Router</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;max-width:48rem;margin:3rem auto;padding:0 1rem;color:#1d1d1f}section{border:1px solid #ddd;border-radius:.5rem;padding:1rem;margin:1rem 0}h1{font-size:1.5rem}h2{font-size:1.1rem}dl{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1rem}dt{font-weight:600}dd{margin:0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.4rem;border-bottom:1px solid #ddd}</style></head><body><h1>Codex Auto Router</h1><button id="refresh" type="button">Refresh</button><section id="official-credit"><h2>Official Credit</h2>${official}</section><section id="estimated-credit-attribution"><h2>Estimated Credit Attribution by model</h2>${estimates}</section><section id="attribution-quality"><h2>Attribution Quality</h2><p>${escapeHtml(view.attributionQuality.message)}</p></section><script nonce="${nonce}">const text=(value)=>String(value);const block=(id,title,lines)=>{const section=document.getElementById(id);section.replaceChildren();const heading=document.createElement("h2");heading.textContent=title;section.append(heading);for(const line of lines){const item=document.createElement("p");item.textContent=line;section.append(item)}};document.getElementById("refresh").addEventListener("click",async()=>{const response=await fetch("/api/refresh",{method:"POST"});if(!response.ok)return;const view=await response.json();const credit=view.officialCredit;block("official-credit","Official Credit",credit.status==="available"?["Limit: "+text(credit.limit),"Used: "+text(credit.used),"Remaining credit: "+text(credit.remaining),"Remaining: "+text(credit.remainingPercent)+"%","Resets: "+text(credit.resetsAt)]:["Official credit is unavailable."]);block("estimated-credit-attribution","Estimated Credit Attribution by model",view.estimatedCreditAttribution.length?view.estimatedCreditAttribution.map(row=>text(row.model)+": "+text(row.credits)):["Estimated credit attribution is unavailable."]);block("attribution-quality","Attribution Quality",[text(view.attributionQuality.message)])});</script></body></html>`;
}

function authority(server: Server): string | undefined {
  const address = server.address();
  return address && typeof address !== "string" ? `127.0.0.1:${address.port}` : undefined;
}

function isCurrentLoopbackHost(request: IncomingMessage, server: Server): boolean {
  return request.headers.host?.toLowerCase() === authority(server)?.toLowerCase();
}

function isCurrentLoopbackOrigin(request: IncomingMessage, server: Server): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin.toLowerCase() === `http://${authority(server)}`.toLowerCase();
}

function hasBody(request: IncomingMessage): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean): void => { if (!settled) { settled = true; resolve(result); } };
    request.once("end", () => finish(false));
    request.once("error", () => finish(true));
    request.on("data", (chunk: Buffer) => { if (chunk.length > 0) finish(true); });
  });
}

export function createDashboardServer(provider: SnapshotProvider): Server {
  let server: Server;
  server = createServer(async (request, response) => {
    const nonce = randomBytes(16).toString("base64");
    setSecurityHeaders(response, nonce);
    if (!isCurrentLoopbackHost(request, server) || !isCurrentLoopbackOrigin(request, server)) {
      response.statusCode = 403;
      response.end();
      return;
    }
    const method = request.method ?? "GET";
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if ((path === "/" && method !== "GET") || (path === "/api/usage" && method !== "GET") || (path === "/api/refresh" && method !== "POST")) {
      response.statusCode = 405;
      response.setHeader("allow", path === "/api/refresh" ? "POST" : "GET");
      response.end();
      return;
    }
    if (path !== "/" && path !== "/api/usage" && path !== "/api/refresh") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (path === "/api/refresh" && await hasBody(request)) {
      response.statusCode = 400;
      response.end();
      return;
    }
    try {
      const view = await provider.refresh();
      if (path === "/") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(html(view, nonce));
      } else {
        writeJson(response, 200, view);
      }
    } catch {
      writeJson(response, 500, { error: "Unexpected dashboard failure." });
    }
  });
  return server;
}
