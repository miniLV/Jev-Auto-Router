import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Server } from "node:http";
import { randomBytes } from "node:crypto";
import type { SnapshotProvider, UsageViewModel } from "./types.js";

function setSecurityHeaders(response: ServerResponse, nonce: string): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("content-security-policy", `default-src 'none'; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
}

function writeJson(response: ServerResponse, status: number, value: object): void {
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] as string);
}

const MODEL_COLORS = ["#22d3ee", "#34d399", "#a78bfa", "#fbbf24", "#fb923c", "#60a5fa"];
const DONUT_RADIUS = 76;
const DONUT_CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

function displayCredit(value: string): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return value;
  const minor = BigInt(`${match[1]}${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}`);
  const rounded = (minor + 5n) / 10n;
  const whole = rounded / 100n;
  const fraction = (rounded % 100n).toString().padStart(2, "0");
  return `${whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function percent(value: number): string {
  return `${(Math.max(0, Math.min(1, value)) * 100).toFixed(1)}%`;
}

function rankedRows(view: UsageViewModel): UsageViewModel["estimatedCreditAttribution"] {
  return [...view.estimatedCreditAttribution].sort((left, right) => right.share - left.share || left.model.localeCompare(right.model));
}

function resetProgress(resetsAt: string): { countdown: string; remainingPercent: number } {
  const resetAt = Date.parse(resetsAt);
  if (!Number.isFinite(resetAt)) return { countdown: "—", remainingPercent: 0 };
  const now = Date.now();
  const remainingMinutes = Math.max(0, Math.ceil((resetAt - now) / 60_000));
  const reset = new Date(resetAt);
  const start = Date.UTC(reset.getUTCFullYear(), reset.getUTCMonth() - 1, 1);
  return {
    countdown: remainingMinutes === 0 ? "Reset due" : `${Math.floor(remainingMinutes / 1_440)}d ${Math.floor((remainingMinutes % 1_440) / 60)}h ${remainingMinutes % 60}m`,
    remainingPercent: Math.max(0, Math.min(100, ((resetAt - now) / (resetAt - start)) * 100))
  };
}

function donutArcs(view: UsageViewModel): string {
  let offset = 0;
  return rankedRows(view).map((row, index) => {
    const length = Math.max(0, Math.min(1, row.share)) * DONUT_CIRCUMFERENCE;
    const arc = `<circle class="donut-arc" data-model="${escapeHtml(row.model)}" data-share="${percent(row.share)}" tabindex="0" cx="100" cy="100" r="${DONUT_RADIUS}" stroke="${MODEL_COLORS[index % MODEL_COLORS.length]}" stroke-dasharray="${length} ${DONUT_CIRCUMFERENCE - length}" stroke-dashoffset="${-offset}" transform="rotate(-90 100 100)"/>`;
    offset += length;
    return arc;
  }).join("");
}

function modelList(view: UsageViewModel): string {
  if (view.estimatedCreditAttribution.length === 0) return "<p class=\"empty-state\">Model attribution is unavailable.</p>";
  return rankedRows(view).map((row, index) => `<div class="model-row" data-model="${escapeHtml(row.model)}" data-share="${percent(row.share)}" tabindex="0"><span class="model-dot" style="background:${MODEL_COLORS[index % MODEL_COLORS.length]}"></span><span class="model-name">${escapeHtml(row.model)}</span><span class="model-share">${percent(row.share)}</span><strong>${escapeHtml(displayCredit(row.credits))}<small> CR</small></strong></div>`).join("");
}

function html(view: UsageViewModel, nonce: string): string {
  const officialCredit = view.officialCredit.status === "available" ? view.officialCredit : undefined;
  const primaryRow = rankedRows(view)[0];
  const used = officialCredit ? displayCredit(officialCredit.used) : "—";
  const remaining = officialCredit ? displayCredit(officialCredit.remaining) : "—";
  const left = officialCredit ? `${officialCredit.remainingPercent}%` : "—";
  const usedPercent = officialCredit ? Math.max(0, Math.min(100, 100 - officialCredit.remainingPercent)) : 0;
  const reset = officialCredit ? resetProgress(officialCredit.resetsAt) : undefined;
  const official = officialCredit
    ? `<div class="credit-figure"><span>Official used</span><strong>${escapeHtml(used)} <small>CR</small></strong><p>of ${escapeHtml(displayCredit(officialCredit.limit))} CR limit</p></div><div style="display:flex;justify-content:space-between;margin:0 0 8px;color:#8ea1bc;font-size:11px;letter-spacing:.08em;text-transform:uppercase"><span>Credit used</span><strong>${usedPercent.toFixed(1)}% used · ${escapeHtml(left)} left</strong></div><div class="meter" aria-label="${usedPercent.toFixed(1)}% credit used"><span style="transform:scaleX(${usedPercent / 100})"></span></div><div class="credit-meta"><div><span>Used</span><strong>${escapeHtml(used)} CR</strong></div><div><span>Remaining</span><strong>${escapeHtml(remaining)} CR</strong></div><div><span>Reset in</span><strong>${escapeHtml(reset?.countdown ?? "—")}</strong></div></div><div style="margin-top:22px"><div style="display:flex;justify-content:space-between;margin:0 0 8px;color:#8ea1bc;font-size:11px;letter-spacing:.08em;text-transform:uppercase"><span>Time to reset</span><strong>${escapeHtml(reset?.countdown ?? "—")} remaining</strong></div><div class="meter" aria-label="${reset?.remainingPercent.toFixed(1) ?? "0"}% of monthly cycle remaining"><span style="transform:scaleX(${(reset?.remainingPercent ?? 0) / 100});background:linear-gradient(90deg,#fbbf24,#fb923c)"></span></div><p style="margin:8px 0 0;color:#8ea1bc;font-size:12px">Monthly reset: ${escapeHtml(officialCredit.resetsAt.slice(0, 10))}</p></div>`
    : "<p class=\"empty-state\">Official credit is unavailable.</p>";
  const modelMix = view.estimatedCreditAttribution.length > 0
    ? `<div class="mix-layout"><div class="donut-wrap"><svg id="model-donut" viewBox="0 0 200 200" role="img" aria-label="Estimated credit share by model"><circle class="donut-track" cx="100" cy="100" r="${DONUT_RADIUS}"/>${donutArcs(view)}</svg><div class="donut-center"><span>Selected model</span><strong id="donut-model">${escapeHtml(primaryRow?.model ?? "—")}</strong><em id="donut-share">${percent(primaryRow?.share ?? 0)}</em></div></div><div class="model-list">${modelList(view)}</div></div>`
    : "<p class=\"empty-state\">Model attribution is unavailable.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Codex Auto Router</title><style nonce="${nonce}">
*{box-sizing:border-box}body{min-width:320px;margin:0;color:#e6edf7;background:#08111f;background-image:linear-gradient(rgba(148,163,184,.055) 1px,transparent 1px),linear-gradient(90deg,rgba(148,163,184,.055) 1px,transparent 1px);background-size:28px 28px;font:15px/1.45 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}.shell{width:min(1060px,calc(100% - 32px));margin:0 auto;padding:58px 0 72px}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:24px;margin-bottom:34px}.eyebrow{margin:0 0 10px;color:#22d3ee;font-size:12px;font-weight:700;letter-spacing:.16em}.topbar h1{margin:0;color:#f8fafc;font-size:clamp(28px,4vw,44px);letter-spacing:-.06em;line-height:1}.topbar h1 span{color:#a78bfa}.topbar p{max-width:560px;margin:12px 0 0;color:#94a3b8}.refresh{flex:0 0 auto;border:1px solid rgba(34,211,238,.55);border-radius:7px;padding:10px 15px;color:#cffafe;background:rgba(34,211,238,.08);font:inherit;font-weight:700;cursor:pointer}.refresh:hover{background:rgba(34,211,238,.17)}.grid{display:grid;grid-template-columns:1.04fr .96fr;gap:18px}.card{overflow:hidden;border:1px solid rgba(148,163,184,.2);border-radius:12px;background:rgba(10,21,38,.88);box-shadow:0 20px 55px rgba(0,0,0,.18)}.card-head{display:flex;align-items:center;justify-content:space-between;padding:17px 20px;border-bottom:1px solid rgba(148,163,184,.14)}.card-head h2{margin:0;color:#dce8f8;font-size:13px;letter-spacing:.1em;text-transform:uppercase}.status{color:#34d399;font-size:11px;font-weight:700;letter-spacing:.1em}.official-body{padding:26px 20px}.credit-figure span,.credit-meta span,.quality-label{display:block;color:#7d91ad;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.credit-figure strong{display:block;margin-top:5px;color:#f8fafc;font-size:clamp(36px,5vw,58px);letter-spacing:-.075em;line-height:1}.credit-figure small{color:#a78bfa;font-size:.32em;letter-spacing:0}.credit-figure p{margin:10px 0 25px;color:#8ea1bc}.meter{height:10px;overflow:hidden;border:1px solid rgba(148,163,184,.25);border-radius:999px;background:#111e32}.meter span{display:block;width:100%;height:100%;border-radius:inherit;transform-origin:left;background:linear-gradient(90deg,#a78bfa,#22d3ee)}.credit-meta{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}.credit-meta strong{display:block;margin-top:5px;color:#dce8f8;font-size:13px}.mix{grid-column:1/-1}.mix-body{padding:22px 20px 12px}.mix-layout{display:grid;grid-template-columns:240px minmax(0,1fr);align-items:center;gap:28px}.donut-wrap{position:relative;width:220px;height:220px;margin:auto}.donut-wrap svg{width:100%;height:100%;overflow:visible}.donut-track,.donut-arc{fill:none;stroke-width:24}.donut-track{stroke:#17263d}.donut-arc{stroke-linecap:butt}.donut-center{position:absolute;inset:55px 38px;display:flex;flex-direction:column;justify-content:center;text-align:center}.donut-center span{color:#7d91ad;font-size:10px;text-transform:uppercase}.donut-center strong{margin:4px 0;color:#dce8f8;font-size:13px;overflow-wrap:anywhere}.donut-center em{color:#22d3ee;font-style:normal;font-size:18px;font-weight:700}.model-list{display:grid}.model-row{display:grid;grid-template-columns:10px minmax(0,1fr) 58px 132px;align-items:center;gap:10px;padding:12px 0;border-bottom:1px solid rgba(148,163,184,.13)}.model-row:last-child{border:0}.model-dot{width:8px;height:8px;border-radius:50%;box-shadow:0 0 12px currentColor}.model-name{overflow:hidden;color:#dce8f8;text-overflow:ellipsis;white-space:nowrap}.model-share{color:#93a7c3;text-align:right}.model-row strong{color:#f8fafc;text-align:right}.model-row small{color:#a78bfa;font-size:10px}.quality{grid-column:1/-1;display:flex;gap:16px;padding:18px 20px}.quality-mark{width:3px;flex:none;border-radius:99px;background:#fbbf24}.quality p{margin:5px 0 0;color:#aebfd4}.empty-state{margin:0;color:#94a3b8}@media(max-width:700px){.shell{width:min(100% - 24px,1060px);padding-top:30px}.topbar{display:block}.refresh{margin-top:20px}.grid{grid-template-columns:1fr}.mix-layout{grid-template-columns:1fr;gap:12px}.credit-meta{grid-template-columns:1fr}.model-row{grid-template-columns:10px minmax(0,1fr) 52px 100px}.quality{grid-column:auto}}
</style></head><body><main class="shell"><header class="topbar"><div><p class="eyebrow">LOCAL USAGE · LIVE SNAPSHOT</p><h1>Credit <span>Atlas</span></h1><p>Official account credit, with a local estimate of where model usage is concentrated.</p></div><div style="display:flex;flex-wrap:wrap;gap:10px;justify-content:flex-end"><button id="export-json" class="refresh" type="button">Export JSON</button><button id="refresh" class="refresh" type="button">Refresh snapshot</button></div></header><div class="grid"><section id="official-credit" class="card"><header class="card-head"><h2>Official Credit</h2><span class="status">AUTHORITATIVE</span></header><div class="official-body">${official}</div></section><section id="estimated-credit-attribution" class="card mix"><header class="card-head"><h2>Model credit mix</h2><span class="status">ESTIMATED</span></header><div class="mix-body">${modelMix}</div></section><section id="attribution-quality" class="card quality"><span class="quality-mark"></span><div><span class="quality-label">Attribution quality</span><p>${escapeHtml(view.attributionQuality.message)}</p></div></section></div></main><script nonce="${nonce}">const members=[...document.querySelectorAll("[data-model]")];const model=document.getElementById("donut-model");const share=document.getElementById("donut-share");const initialModel=${JSON.stringify(primaryRow?.model ?? "—")};const initialShare=${JSON.stringify(percent(primaryRow?.share ?? 0))};const clear=()=>{for(const item of members){item.style.opacity="";item.style.transform="";item.style.background="";item.style.strokeWidth=""}if(model)model.textContent=initialModel;if(share)share.textContent=initialShare};const select=(name)=>{for(const item of members){const active=item.dataset.model===name;item.style.opacity=active?"1":".2";if(item.classList.contains("model-row")){item.style.transform=active?"translateX(5px)":"";item.style.background=active?"rgba(34,211,238,.09)":""}else item.style.strokeWidth=active?"30":"24"}const selected=members.find(item=>item.dataset.model===name);if(model)model.textContent=name;if(share)share.textContent=selected?.dataset.share??"—"};for(const item of members){item.addEventListener("pointerenter",()=>select(item.dataset.model));item.addEventListener("pointerleave",clear);item.addEventListener("focus",()=>select(item.dataset.model));item.addEventListener("blur",clear)}const exportButton=document.getElementById("export-json");exportButton.addEventListener("click",async()=>{exportButton.disabled=true;exportButton.textContent="Preparing…";try{const response=await fetch("/api/usage");if(!response.ok)throw new Error("Unable to export usage");const usage=await response.json();const exportedAt=new Date().toISOString();const blob=new Blob([JSON.stringify({exportedAt,...usage},null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const link=document.createElement("a");link.href=url;link.download="codex-usage-"+exportedAt.replace(/[.:]/g,"-")+".json";link.click();URL.revokeObjectURL(url)}finally{exportButton.disabled=false;exportButton.textContent="Export JSON"}});document.getElementById("refresh").addEventListener("click",()=>location.reload());</script></body></html>`;
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
