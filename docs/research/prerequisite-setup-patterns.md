# Prerequisite and setup patterns in mature developer tools

**Research date:** 2026-08-01
**Scope:** official repositories, first-party installation documentation, and
first-party installer source only. The examples cover Node-oriented tooling,
cross-platform CLIs, and standalone bootstrap installers relevant to a local
Node/TypeScript dashboard.

## Executive finding

The dominant pattern is **hybrid**:

1. The project documents (and sometimes offers) an OS-native way to install
   system prerequisites.
2. Once the runtime exists, a project command installs **project-local**
   dependencies deterministically.
3. System changes are explicit, visible, and usually opt-in or delegated to a
   trusted package manager. A no-package-manager/manual path remains available.

Standalone installers are common when the project owns a self-contained binary
(Dev Container CLI, rustup, uv). They are not a reason for a Node application to
pretend that `npm run setup` can install Node: npm itself cannot execute until
Node and npm already exist.

## Comparison

| Project | Prerequisites assumed; missing-prerequisite behavior | Default install and environment changes | Confirmation / authorization | macOS, Linux, Windows differences |
| --- | --- | --- | --- | --- |
| **Node Corepack** ([official README](https://github.com/nodejs/corepack/blob/main/README.md)) | Corepack is shipped with supported Node distributions; therefore a machine without Node has no `corepack` command and must install Node first. It downloads the project-declared package manager on first use; network failures are surfaced as Corepack troubleshooting errors ([README](https://github.com/nodejs/corepack/blob/main/README.md#when-building-packages), [troubleshooting](https://github.com/nodejs/corepack/blob/main/README.md#troubleshooting)). | `corepack enable` creates Yarn/pnpm shims next to the Node installation; package-manager payloads are cached per user by default (`$HOME/.cache/node/corepack` on Unix, `%LOCALAPPDATA%\node\corepack` on Windows) ([README](https://github.com/nodejs/corepack/blob/main/README.md#how-to-install), [environment variables](https://github.com/nodejs/corepack/blob/main/README.md#environment-variables)). Project-local `corepack install` does not change the global package-manager version unless `-g` is used ([README](https://github.com/nodejs/corepack/blob/main/README.md#utility-commands)). | An implicit package-manager call may show the download URL and, in an interactive TTY, ask before downloading; CI/non-interactive use does not get that prompt by default ([README](https://github.com/nodejs/corepack/blob/main/README.md#environment-variables)). | Corepack follows the host Node installation; its cache path and shim location differ on Windows versus Unix. It is a package-manager bridge, not a cross-platform Node bootstrapper ([README](https://github.com/nodejs/corepack/blob/main/README.md#how-to-install)). |
| **Volta** ([getting started](https://docs.volta.sh/guide/getting-started), [installer behavior](https://docs.volta.sh/advanced/installers)) | The Unix command assumes a shell and `curl`; Windows uses WinGet or a downloaded installer. The installer provisions Volta and can then fetch Node, so an existing Node installation is not the normal prerequisite. If the preferred downloader/package manager is absent, the docs provide the alternate direct installer ([getting started](https://docs.volta.sh/guide/getting-started)). | Unix installs binaries under user `~/.volta/bin` and updates shell startup files; Windows installs under `Program Files\Volta` and adds a system `Path` entry. Unix supports `--skip-setup`; Windows does not ([installer behavior](https://docs.volta.sh/advanced/installers#skipping-volta-setup)). `volta install node` then downloads/selects a Node version ([command reference](https://docs.volta.sh/reference/install)). | The documented Unix pipe-to-shell flow has no separate project consent prompt; it makes startup-file changes unless `--skip-setup` is supplied. Windows uses WinGet or its installer, so elevation/installer prompts belong to that channel ([getting started](https://docs.volta.sh/guide/getting-started), [installer behavior](https://docs.volta.sh/advanced/installers)). | macOS and Linux use the Unix installer; Windows uses WinGet/installer; WSL follows the Unix instructions ([getting started](https://docs.volta.sh/guide/getting-started#windows-subsystem-for-linux)). |
| **nvm-sh** ([official README](https://github.com/nvm-sh/nvm#installing-and-updating)) | Requires a POSIX shell and one of `git`, `curl`, or `wget` for the installer. It supports Unix, macOS, and Windows WSL, not native Windows. If `nvm` is not found after installation, the project says to open a new shell or source the appropriate profile ([README](https://github.com/nvm-sh/nvm#installing-and-updating), [troubleshooting](https://github.com/nvm-sh/nvm#troubleshooting-on-linux)). | The script clones nvm into `~/.nvm` (or `XDG_CONFIG_HOME`) and appends load lines to `.bashrc`, `.bash_profile`, `.zshrc`, or `.profile`. `PROFILE=/dev/null` prevents profile edits ([README](https://github.com/nvm-sh/nvm#installing-and-updating)). Node versions are then installed per user/shell with nvm. | The installer is an explicit user-run script and does not describe a confirmation dialog. Profile edits are automatic unless `PROFILE` is overridden; the project documents the exact lines it adds ([README](https://github.com/nvm-sh/nvm#installing-and-updating)). | Native Windows is outside the supported platform; Windows users are directed to WSL. Shell/profile selection and the “new shell/source profile” recovery step are Unix-specific ([README](https://github.com/nvm-sh/nvm#about), [WSL](https://github.com/nvm-sh/nvm#wsl-troubleshooting)). |
| **nvm-windows** ([official README](https://github.com/coreybutler/nvm-windows#installation--upgrades), [manual install](https://github.com/coreybutler/nvm-windows/wiki)) | It is a Windows-only Node version manager. The project recommends uninstalling an existing Node installation first to avoid PATH and permission conflicts; `nvm install`/`nvm use` commonly need administrative rights to create symlinks ([README](https://github.com/coreybutler/nvm-windows#installation--upgrades)). If an existing install or permissions block management, the documented recovery is to remove the old Node/restart an elevated shell, not to silently overwrite it ([README](https://github.com/coreybutler/nvm-windows#installation--upgrades)). | The default installer places nvm under the user roaming profile and manages a Node symlink; manual installation requires `NVM_HOME` and `NVM_SYMLINK` environment variables ([manual install](https://github.com/coreybutler/nvm-windows/wiki#manual-installation)). The selected Node version and global npm tools are managed separately per version ([README](https://github.com/coreybutler/nvm-windows#reinstall-any-global-utilities)). | The installer is a Windows GUI/installer flow. `nvm` commands run in an Administrator shell in the project’s documented usage; elevation is therefore visible and authorization is controlled by Windows/UAC rather than by a Node script ([README](https://github.com/coreybutler/nvm-windows#usage)). | Unlike nvm-sh, this is native Windows; macOS/Linux users need a different manager. A newly installed PATH/symlink may require a new terminal ([README](https://github.com/coreybutler/nvm-windows#installation--upgrades)). |
| **Dev Container CLI** ([official repository](https://github.com/devcontainers/cli#try-it-out)) | Its standalone script downloads a bundled Node runtime, so Linux/macOS users do not need preinstalled Node. The npm path instead requires Python and C/C++ to build a native dependency; creating a container also requires a supported container engine ([install script](https://github.com/devcontainers/cli#install-script), [npm install](https://github.com/devcontainers/cli#npm-install), [try it out](https://github.com/devcontainers/cli#try-it-out)). Missing build tools make the npm install fail; a missing container engine prevents `up`/`build` from doing useful work. | The script installs under `$HOME/.devcontainers/bin` and asks the user to add that directory to `PATH`; it supports a custom prefix, update, and uninstall ([install script](https://github.com/devcontainers/cli#install-script)). The npm route is a global package installation (`npm install -g @devcontainers/cli`) and therefore changes the Node global prefix, not the project’s `node_modules` ([npm install](https://github.com/devcontainers/cli#npm-install)). | The repository shows an explicit command, but no hidden elevation or confirmation step. The user controls whether to run the remote script; the npm route delegates permissions to npm. Container image pulls and registry authentication occur when a container is started, not during the CLI bootstrap ([try it out](https://github.com/devcontainers/cli#try-it-out)). | The no-Node standalone installer is documented for Linux/macOS x64 and arm64. Windows users are directed to the npm/package route or another supported runtime arrangement; the project’s install-script guarantee is not universal Windows coverage ([install script](https://github.com/devcontainers/cli#install-script)). |
| **GitHub CLI (`gh`)** ([official README](https://github.com/cli/cli#installation), [macOS](https://github.com/cli/cli/blob/trunk/docs/install_macos.md), [Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md), [Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md)) | A native binary can be downloaded without a language runtime. Package-manager paths assume Homebrew, apt/dnf, or WinGet; Linux’s official apt path even bootstraps `wget` when absent ([Linux install](https://github.com/cli/cli/blob/trunk/docs/install_linux.md#debian)). If a package manager or `sudo` is unavailable, use the precompiled release binary instead ([README](https://github.com/cli/cli#installation)). | macOS defaults to Homebrew or a release installer; Linux defaults to signed distro repositories; Windows defaults to WinGet or an `.exe`/`.msi` release ([macOS](https://github.com/cli/cli/blob/trunk/docs/install_macos.md#recommended-official), [Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md#recommended-official), [Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md#recommended-official)). Linux package installation writes keyrings/repository files system-wide; Windows installer modifies `PATH` ([Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md#debian), [Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md#winget)). | Linux package setup may prompt to import the official PGP key and uses `sudo`; the docs explicitly tell users to verify fingerprints. Windows PATH changes take effect in a new terminal. Authentication to GitHub is a later `gh auth` concern, not silently performed by installation ([Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md#recommended-official), [Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md#winget)). | Package-manager choice is OS-specific: Homebrew on macOS/Linux, apt/dnf on Linux, WinGet on Windows; all also have precompiled binaries. The official project supports macOS, Windows, and Linux ([README](https://github.com/cli/cli#installation)). |
| **rustup** ([installation book](https://rust-lang.github.io/rustup/installation/), [installer source](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)) | Unix uses `curl ... | sh`; Windows downloads/runs `rustup-init.exe`. The Rust toolchain itself is fetched by rustup, so a preexisting compiler is not required. Windows MSVC builds may need Visual Studio components; rustup-init can offer to install them ([other methods](https://rust-lang.github.io/rustup/installation/other.html), [MSVC prerequisites](https://rust-lang.github.io/rustup/installation/windows-msvc.html)). If `/tmp` is mounted `noexec`, the installer reports that it cannot execute and asks the user to move the binary ([installer source](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)). | Installs toolchains under user `~/.cargo/bin` (Unix) or `%USERPROFILE%\\.cargo\\bin` (Windows) and adds that directory to `PATH` by default; `--no-modify-path` opts out ([installation](https://rust-lang.github.io/rustup/installation/), [installer source](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh)). | The installer asks for confirmation by default; `-y/--yes` disables it. Windows prerequisite installation is offered rather than silently assumed, and the docs warn that the offered Visual Studio edition may not fit every user or enterprise ([installer source](https://github.com/rust-lang/rustup/blob/main/rustup-init.sh), [MSVC prerequisites](https://rust-lang.github.io/rustup/installation/windows-msvc.html)). | Unix uses the shell script; Windows uses an executable and MSVC/GNU host choice. Package managers such as apt and Homebrew are documented alternatives, but PATH behavior can differ from the rustup distribution ([other methods](https://rust-lang.github.io/rustup/installation/other.html)). |
| **uv** ([official installation docs](https://docs.astral.sh/uv/getting-started/installation/), [installer options](https://docs.astral.sh/uv/reference/installer/)) | The standalone installer needs `curl` or `wget` on macOS/Linux, and PowerShell on Windows. uv does **not** require an existing Python: it can download and manage Python versions itself ([installation](https://docs.astral.sh/uv/getting-started/installation/), [Python management](https://docs.astral.sh/uv/guides/install-python/)). If a wheel is unavailable and uv is built from source, Rust becomes a prerequisite; the docs provide package-manager and release-binary alternatives ([installation](https://docs.astral.sh/uv/getting-started/installation/)). | Default standalone installs go to a user executable directory and may update shell profiles so `uv` is on `PATH`. `UV_INSTALL_DIR` changes the binary location; `UV_NO_MODIFY_PATH=1` or `UV_UNMANAGED_INSTALL` prevents profile/environment edits ([installer options](https://docs.astral.sh/uv/reference/installer/)). | The docs do not describe an interactive confirmation dialog. They do make the PowerShell execution-policy bypass explicit and recommend inspecting the script before execution; profile mutation is opt-out via environment variables ([installation](https://docs.astral.sh/uv/getting-started/installation/), [installer options](https://docs.astral.sh/uv/reference/installer/)). | macOS/Linux use shell scripts, Windows uses PowerShell; Homebrew, MacPorts, WinGet, Scoop, Docker, PyPI, Cargo, and release artifacts are documented alternatives ([installation](https://docs.astral.sh/uv/getting-started/installation/)). |

## What this means for codex-auto-router

### Separate the two installation layers

`npm ci` (or an equivalent lockfile-respecting project install) is a **local
dependency** operation. It reads this repository’s lockfile and writes the
repository’s `node_modules`; it must not be described as installing Node.js or
the Codex CLI.

Node.js/npm and Codex are **system/user-level prerequisites**:

- Node/npm are needed to execute `npm run setup` in the first place.
- Codex is an external CLI with its own distribution, authentication, and
  upgrade policy. A project setup command should detect it and explain how to
  install or repair it, not silently install credentials-bearing software.

### The bootstrap paradox

`npm run setup` invokes `node scripts/setup.mjs`. If `node` or `npm` is absent,
that command cannot start; no JavaScript setup logic can repair the missing
runtime. Mature projects resolve this in one of two ways:

- publish a no-runtime/native installer (Dev Container CLI, rustup, uv), or
- make the first step a documented OS-native/package-manager action (Volta,
  nvm, GitHub CLI), then run the project’s package-manager command.

For this repository, the second approach is safer: a TypeScript dashboard does
not own a trusted Node distribution and should not download one invisibly.

### Concrete recommendation: consented hybrid setup

1. **Keep `npm run setup` as the second-stage project bootstrap.** Once Node.js
   22+ and npm are available, it should verify versions, run the locked local
   dependency install, run type checks/tests, and report a concise ready state.
2. **Put a no-Node preflight before that command in README/docs.** Detect the
   OS and give copyable official choices: an existing Node manager (Volta or
   nvm on Unix/WSL, nvm-windows or WinGet on native Windows), or the official
   Node download. Do not assume Bash on Windows.
3. **Offer repair only with explicit consent.** If a supported manager is
   already present and Node is too old, show the exact command, explain that it
   changes the user/system environment, and require an exact `yes` before
   running it. If no manager is present, stop with the official Node URL rather
   than attempting a shell-piped installer.
4. **Treat Codex as a required-but-separate check.** After Node/npm are ready,
   check `codex --version`; if absent, show the official Codex installation
   route and stop. Never install or authenticate Codex as a side effect of
   `npm ci`.
5. **Make environment changes observable and recoverable.** Print which route
   was selected, whether a profile/PATH was changed, what terminal restart is
   needed, and the exact command to re-run. Provide a manual path for locked-down
   corporate machines where sudo, WinGet, shell profiles, or downloads are
   unavailable.
6. **Keep project-local installation deterministic.** Use the repository lockfile
   and fail clearly on registry/network errors; do not turn missing system
   prerequisites into an implicit global package installation.

This yields a practical hybrid: one command after prerequisites are present,
explicit OS-native guidance before they are, and no claim that a JavaScript
script can bootstrap the runtime that would execute it.

## Primary sources

- [Corepack README](https://github.com/nodejs/corepack/blob/main/README.md)
- [Volta getting started](https://docs.volta.sh/guide/getting-started) and [installer behavior](https://docs.volta.sh/advanced/installers)
- [nvm-sh README](https://github.com/nvm-sh/nvm)
- [nvm-windows README](https://github.com/coreybutler/nvm-windows) and [manual-install wiki](https://github.com/coreybutler/nvm-windows/wiki)
- [Dev Container CLI repository](https://github.com/devcontainers/cli)
- [GitHub CLI README](https://github.com/cli/cli) plus [macOS](https://github.com/cli/cli/blob/trunk/docs/install_macos.md), [Linux](https://github.com/cli/cli/blob/trunk/docs/install_linux.md), and [Windows](https://github.com/cli/cli/blob/trunk/docs/install_windows.md) installation docs
- [The rustup book: installation](https://rust-lang.github.io/rustup/installation/) and [Windows MSVC prerequisites](https://rust-lang.github.io/rustup/installation/windows-msvc.html)
- [uv installation](https://docs.astral.sh/uv/getting-started/installation/) and [installer reference](https://docs.astral.sh/uv/reference/installer/)
