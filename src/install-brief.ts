/** Pinned integration-layer commit of the external Codex Router provider/picker project. */
export const DEFAULT_ROUTER_COMMIT = "8701ef788aa8cb0948f299538747fb01029d32b8";

/** Shell-expanded at execution time so every run gets its own trial root. */
export const DEFAULT_TRIAL_ROOT = "$HOME/Documents/jev-router-trial-$(date +%Y%m%d-%H%M%S)";

export const DEFAULT_PICKER_LABEL = "Jev Auto Router";
export const DEFAULT_PROXY_PORT = 8787;

/** Inputs for the agent-executable install brief; secrets never appear here. */
export interface InstallBriefInput {
  trialRoot: string;
  repoPath: string;
  routerCommit: string;
  proxyPort: number;
  baseline: string;
  upstreamBaseUrl?: string;
  pickerLabel: string;
}

/**
 * Validate brief parameters. `params` keys: baseline, repoPath, trialRoot,
 * routerCommit, port, upstreamBaseUrl, pickerLabel. Values are user-supplied
 * configuration only; an API key must never be passed through this surface.
 */
export function parseInstallBriefInput(
  params: Record<string, string | undefined>,
  fallbackRepoPath?: string,
): InstallBriefInput {
  const baseline = params.baseline?.trim();
  if (!baseline) throw new Error("baseline is required as <model>/<effort>");
  if (!/^[^/\s]+\/[^/\s]+$/.test(baseline)) {
    throw new Error(`baseline must be <model>/<effort>, got: ${baseline}`);
  }
  const repoPath = params.repoPath?.trim() || fallbackRepoPath?.trim();
  if (!repoPath) throw new Error("repoPath is required (the local Jev Auto Router checkout)");
  const portRaw = params.port?.trim() || String(DEFAULT_PROXY_PORT);
  const proxyPort = Number(portRaw);
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`port must be an integer from 1 to 65535, got: ${portRaw}`);
  }
  const routerCommit = params.routerCommit?.trim() || DEFAULT_ROUTER_COMMIT;
  if (!/^[0-9a-f]{7,40}$/.test(routerCommit)) {
    throw new Error(`routerCommit must be a git commit hash, got: ${routerCommit}`);
  }
  let upstreamBaseUrl: string | undefined;
  const upstreamRaw = params.upstreamBaseUrl?.trim();
  if (upstreamRaw) {
    let parsed: URL;
    try {
      parsed = new URL(upstreamRaw);
    } catch {
      throw new Error(`upstreamBaseUrl must be a valid http(s) URL, got: ${upstreamRaw}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`upstreamBaseUrl must use http(s), got: ${upstreamRaw}`);
    }
    const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
    if (loopback && Number(parsed.port || 80) === proxyPort) {
      throw new Error("upstreamBaseUrl must not point at the router itself: the caller edge must be non-recursive");
    }
    upstreamBaseUrl = parsed.origin;
  }
  const trialRoot = params.trialRoot?.trim() || DEFAULT_TRIAL_ROOT;
  const pickerLabel = params.pickerLabel?.trim() || DEFAULT_PICKER_LABEL;
  return { trialRoot, repoPath, routerCommit, proxyPort, baseline, upstreamBaseUrl, pickerLabel };
}

/** Render the markdown install brief an agent executes to expose jev/auto in the Codex picker. */
export function renderInstallBrief(input: InstallBriefInput): string {
  const proxyUrl = `http://127.0.0.1:${input.proxyPort}`;
  const upstreamLine = input.upstreamBaseUrl
    ? `本简报预填 caller edge：\`${input.upstreamBaseUrl}\`（仍必须按上面两条核实非递归）。`
    : `由 status 输出确定后，替换下方 \`JEV_UPSTREAM_BASE_URL\` 的 \`<caller-edge-base-url>\`。`;
  const upstreamEnvValue = input.upstreamBaseUrl ?? "<caller-edge-base-url>";
  return `# 在 Codex 模型选择器中启用「${input.pickerLabel}」——本地试用安装简报

> 本简报由 Jev Auto Router 本地配置页生成，交给 Codex 或其他 agent 按步执行。
> 目标：Codex 模型选择器在保留全部原生 GPT 模型的同时，出现「${input.pickerLabel}」条目；
> 选择它时，请求以 \`model=jev/auto\` 进入本仓库的本地路由代理（shadow 模式）；
> 手动选择真实模型时完全绕过代理，走原有通道。
> 任何一步失败：立即停止并报告现状，不要改用其他安装方式，不要跳步。

## 边界约束（必须遵守）

- 不覆盖现有 Codex 配置；不把任何模型设为永久默认。
- 密钥只写入 \`${input.trialRoot}/private/\` 下权限 600 的文件；不进命令行参数、Git、截图或日志。
- 只使用外部仓库的「provider / 模型选择器接入层」；**不安装、不启用它的 Jev 决策服务与运行时策略**
  （route lease、Astra 强制策略、配额回退、retry/重放一律排除；上游输出开始后不得重试）。
- 本安装为 shadow 模式：Jev 只记录 would-be 路线，实际执行使用固定基线 \`${input.baseline}\`。
- 全程可回滚：第 7 步必须恢复到安装前状态。

## 第 1 步：准备试用目录并备份 Codex 配置

\`\`\`sh
export TRIAL_ROOT="${input.trialRoot}"
mkdir -p "$TRIAL_ROOT"/{backup,logs,private,source}
chmod 700 "$TRIAL_ROOT/private"
cp -p "$HOME/.codex/config.toml" "$TRIAL_ROOT/backup/config.toml"
/usr/bin/shasum -a 256 "$TRIAL_ROOT/backup/config.toml" > "$TRIAL_ROOT/backup/config.sha256"
/usr/bin/shasum -a 256 -c "$TRIAL_ROOT/backup/config.sha256"   # 必须输出 OK
grep -E '^(model|model_provider|model_reasoning_effort)' "$HOME/.codex/config.toml" || true
\`\`\`

本阶段不修改任何 Codex 文件。

## 第 2 步：固定接入仓库版本，先读脚本再动手

\`\`\`sh
git clone https://github.com/0xNatoshi/jev-codex-router "$TRIAL_ROOT/source/jev-codex-router"
git -C "$TRIAL_ROOT/source/jev-codex-router" checkout ${input.routerCommit}
\`\`\`

先读完以下文件再继续；**不要运行仓库根目录的安装脚本**（该版本存在 discovery 与 ChatGPT session 启用的顺序冲突）：

- \`$TRIAL_ROOT/source/jev-codex-router/README.md\`
- \`$TRIAL_ROOT/source/jev-codex-router/install.sh\`
- \`$TRIAL_ROOT/source/jev-codex-router/server/INSTALL.md\`

## 第 3 步：安装本地 Codex Router（仅接入层）

\`\`\`sh
export ROUTER_ROOT="$TRIAL_ROOT/source/jev-codex-router/router"
cd "$ROUTER_ROOT"
npm ci --include=dev --ignore-scripts
./install.sh --no-provider --no-tray
"$ROUTER_ROOT/bin/codex-router" status
"$ROUTER_ROOT/bin/codex-router" doctor || true
\`\`\`

不要加 \`--no-discovery\`。若因「没有 provider」返回非零，但 status 显示 Router 已启动、4200–4203 正在监听，属预期，继续下一步。

## 第 4 步：启动本仓库的 Jev Router 代理（${proxyUrl}）

\`\`\`sh
cd "${input.repoPath}"
npm ci
npm run build
umask 077
touch "$TRIAL_ROOT/private/jev.env"
chmod 600 "$TRIAL_ROOT/private/jev.env"
\`\`\`

用编辑器在 \`$TRIAL_ROOT/private/jev.env\` 写入一行（密钥由用户自填，不要回显到终端日志）：

\`\`\`text
JEV_API_KEY=<用户的 TypeSafe Jev API Key>
\`\`\`

确定非递归 caller edge：

1. 运行 \`"$ROUTER_ROOT/bin/codex-router" status\`，找到接入 Router 的已认证上游 edge base URL；
2. 它必须指向接入 Router 自身的地址，**绝不能是 \`${proxyUrl}\`（代理自身，递归禁止）**。

${upstreamLine}

启动代理（若本代理已在运行，先停止旧进程再启动）：

\`\`\`sh
pkill -f "dist/src/index.js" || true
cd "${input.repoPath}"
set -a; . "$TRIAL_ROOT/private/jev.env"; set +a
JEV_BASELINE="${input.baseline}" \\
JEV_UPSTREAM_BASE_URL="${upstreamEnvValue}" \\
JEV_MODE=shadow \\
JEV_PORT=${input.proxyPort} \\
nohup npm start > "$TRIAL_ROOT/logs/proxy.log" 2>&1 &
curl -fsS "${proxyUrl}/health"
\`\`\`

\`/health\` 中 \`baselineRequestable\` 必须为 \`true\`（\`${input.baseline}\` 必须是当前 caller edge 已实测可请求的固定回退组合）；否则停止并报告。

## 第 5 步：把 provider 指向本代理并显示模型条目

**关键替换**：外部仓库默认把 jev provider 指向它自带的本地 Jev 服务（通常 \`http://127.0.0.1:4319\`）。
本安装必须把 provider base URL 改为 \`${proxyUrl}\`（本仓库代理），并且**不执行** \`server/install-service.sh\`（不安装其 Jev 服务）。
先读 \`server/configure-model.mjs\` 与 \`server/configure-auth.mjs\`，确认 base URL 的写入位置；若脚本不支持自定义地址，手工把生成的 provider 配置改写为 \`${proxyUrl}\`。

\`\`\`sh
cd "$TRIAL_ROOT/source/jev-codex-router"
export JEV_ENV_FILE="$TRIAL_ROOT/private/jev.env"
node server/configure-model.mjs        # provider 显示名用「${input.pickerLabel}」，base URL 指向 ${proxyUrl}
node server/configure-auth.mjs
"$ROUTER_ROOT/bin/codex-router" refresh-catalog
"$ROUTER_ROOT/bin/control" picker set jev/auto show
"$ROUTER_ROOT/bin/codex-router" chatgpt-session enable
"$ROUTER_ROOT/bin/control" service restart   # 注册 provider 后必须重启父 Router
"$ROUTER_ROOT/bin/codex-router" status       # 模型目录中应出现 jev/auto
\`\`\`

## 第 6 步：验证（全部通过才算成功）

1. 退出并重新打开 Codex：模型选择器在原生 GPT 模型之外显示「${input.pickerLabel}」。
2. 选择「${input.pickerLabel}」执行一个简单任务：
   - \`curl -s ${proxyUrl}/decisions\` 出现 \`model=jev/auto\` 的调用记录；
   - 该记录包含 Jev 的 proposed（would-be）组合与 \`shadow_mode\` 原因，实际执行为基线 \`${input.baseline}\`；
   - 工具调用之后的后续模型调用继续正常流式返回。
3. 手动选择一个真实模型（例如 \`gpt-6-luna\`）：任务正常完成，且 \`/decisions\` 无新增 \`jev/auto\` 记录（真实模型绕过证明）。
4. \`"$ROUTER_ROOT/bin/codex-router" doctor\` 通过；\`git -C "$TRIAL_ROOT/source/jev-codex-router" status --short\` 无源码改动。

## 第 7 步：回滚（恢复到安装前状态）

\`\`\`sh
"$ROUTER_ROOT/bin/control" picker set jev/auto hide
"$ROUTER_ROOT/bin/codex-router" chatgpt-session disable   # 若安装前未启用
"$ROUTER_ROOT/bin/control" service stop
pkill -f "dist/src/index.js" || true
cp -p "$TRIAL_ROOT/backup/config.toml" "$HOME/.codex/config.toml"
/usr/bin/shasum -a 256 -c "$TRIAL_ROOT/backup/config.sha256"   # 必须输出 OK
\`\`\`

重启 Codex，确认模型选择器恢复原状、原生模型可用；确认无误后再删除试用目录：

\`\`\`sh
rm -rf "$TRIAL_ROOT"
\`\`\`
`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Local config page: collects brief parameters and renders the generated markdown. Never receives secrets. */
export function renderInstallPage(repoPath: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Jev Auto Router — 安装简报生成器</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 2rem 1rem; line-height: 1.6; }
  main { max-width: 52rem; margin: 0 auto; }
  form { display: grid; gap: 0.75rem; margin: 1.5rem 0; }
  label { display: grid; gap: 0.25rem; font-size: 0.9rem; }
  input { font: inherit; padding: 0.4rem 0.6rem; border-radius: 6px; border: 1px solid currentColor; opacity: 0.9; }
  button { font: inherit; padding: 0.5rem 1.2rem; border-radius: 6px; border: 1px solid currentColor; cursor: pointer; }
  #error { color: #c0392b; white-space: pre-wrap; }
  #copy { margin: 1rem 0; }
  pre { border: 1px solid currentColor; opacity: 0.9; border-radius: 8px; padding: 1rem; overflow-x: auto; white-space: pre-wrap; }
</style>
</head>
<body>
<main>
<h1>Jev Auto Router 安装简报</h1>
<p>填写试用参数，生成一份可交给 Codex 执行的安装简报。执行成功后，Codex 模型选择器会在保留原生 GPT 模型的同时出现「Jev Auto Router」条目；选择它即进入本仓库的逐调用路由（shadow 模式），手动选择真实模型不受影响。<strong>本页面不接收任何密钥。</strong></p>
<form id="form">
  <label>固定回退基线（&lt;model&gt;/&lt;effort&gt;，必须是 caller edge 已实测可请求的组合）
    <input name="baseline" required placeholder="gpt-6-sol/medium">
  </label>
  <label>本仓库路径
    <input name="repoPath" value="${escapeHtml(repoPath)}">
  </label>
  <label>代理端口
    <input name="port" value="${String(DEFAULT_PROXY_PORT)}">
  </label>
  <label>Caller edge URL（留空则由安装简报第 4 步现场确定并核验非递归）
    <input name="upstreamBaseUrl" placeholder="http://127.0.0.1:4200">
  </label>
  <label>接入仓库 commit（固定版本）
    <input name="routerCommit" value="${DEFAULT_ROUTER_COMMIT}">
  </label>
  <label>Picker 显示名
    <input name="pickerLabel" value="${escapeHtml(DEFAULT_PICKER_LABEL)}">
  </label>
  <label>试用目录（默认每次运行生成带时间戳的新目录）
    <input name="trialRoot" placeholder="${escapeHtml(DEFAULT_TRIAL_ROOT)}">
  </label>
  <button type="submit">生成简报</button>
</form>
<p id="error" hidden></p>
<div id="result" hidden>
  <button id="copy" type="button">复制简报</button>
  <pre id="brief"></pre>
</div>
</main>
<script>
  var form = document.getElementById("form");
  var errorBox = document.getElementById("error");
  var result = document.getElementById("result");
  var brief = document.getElementById("brief");
  form.addEventListener("submit", function (event) {
    event.preventDefault();
    var params = new URLSearchParams(new FormData(form));
    fetch("/install/brief?" + params.toString())
      .then(function (response) {
        if (!response.ok) return response.json().then(function (payload) { throw new Error(payload.error || "invalid input"); });
        return response.text();
      })
      .then(function (text) {
        errorBox.hidden = true;
        brief.textContent = text;
        result.hidden = false;
      })
      .catch(function (error) {
        result.hidden = true;
        errorBox.textContent = String(error.message || error);
        errorBox.hidden = false;
      });
  });
  document.getElementById("copy").addEventListener("click", function () {
    navigator.clipboard.writeText(brief.textContent || "");
  });
</script>
</body>
</html>
`;
}

// CLI entry (CJS-safe): print a brief without requiring the proxy to run.
declare const require: { main?: unknown } | undefined;
try {
  const req = typeof require !== "undefined" ? require : undefined;
  if (req && (req as { main?: unknown }).main === module) {
    const args: Record<string, string> = {};
    for (let i = 2; i < process.argv.length - 1; i += 1) {
      const arg = process.argv[i];
      if (arg.startsWith("--")) args[arg.slice(2)] = process.argv[i + 1];
    }
    try {
      const input = parseInstallBriefInput(args, process.cwd());
      process.stdout.write(renderInstallBrief(input));
    } catch (error) {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
} catch {
  // Imported as a library: do nothing.
}
