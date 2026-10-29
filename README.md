# Agent Terminal Manager

Desktop app (Windows and macOS) for managing many AI agents running in parallel across projects. Each project has one or more terminals (local, SSH, WSL) or agent sessions (OpenCode, controlled via its API). A built-in MCP server and OpenCode-based orchestrators control the sessions.

Stack: Electron, xterm.js, node-pty, `@modelcontextprotocol/sdk`, OpenCode (server mode, API v2).

## Run

```bash
npm install
npm start
```

On Windows, `build.bat` does all steps (installs dependencies if needed): `build.bat` builds the installer, portable exe and unpacked app, `build.bat dir` only the unpacked app, `build.bat test` runs the unit tests first.

Build packages (`release/`):

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

macOS packages must be built on a Mac; `.github/workflows/build.yml` builds both platforms in GitHub Actions.

Tests:

```bash
npm test
```

```bash
npm run e2e
```

The E2E script drives the real app through Playwright. Environment variables enable additional parts: `ATM_E2E_SSH=user@host:port` (SSH target with key login and tmux), `ATM_E2E_WSL=Ubuntu`, `ATM_E2E_OPENCODE=1` (agent session and orchestrator; needs a working OpenCode model).

## Usage

- **Left:** the project tree — projects with a status dot and their sessions underneath. `+` opens a session with the project's default session, `▦` toggles the tile view, `⚙` edits the project. Right-click a project or session for more actions (rename, share with MCP, mark as orchestrator, reconnect, close with or without killing the tmux session).
- **Right:** the project's sessions as tabs or tiles (2 = side by side, 3 = three columns or one large + two small, 4 = 2×2, more = grid). Clicking a tile header returns to the single view.
- **Overview:** all running sessions of all projects, grouped in frames with project name and status dot. Tiles shrink via the xterm font size, so text stays sharp. Smaller tiles have fewer rows and columns; programs receive the new size and may re-wrap. Click a tile to open the session.
- **Status:** working (yellow, output within the last *n* seconds) and waiting (green, no output for longer than the threshold — default 5 s, configurable per project — or a bell character). Switching to “waiting” triggers a desktop notification; clicking it opens the session.
- **Saved commands** per project appear as buttons above the terminal and run in the active session.
- Terminals stay connected when switching projects. Open sessions, view mode and tile layout are saved per project and restored on restart; with tmux the app re-attaches to the sessions that kept running.

### Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Ctrl/⌘ + Shift + T | new session |
| Ctrl/⌘ + 1…9 | switch project |
| Ctrl/⌘ + Tab | next session |
| Ctrl/⌘ + Shift + G | tile view |
| Ctrl/⌘ + Shift + O | overview |
| Ctrl/⌘ + Shift + W | close session |
| Ctrl/⌘ + Shift + C / V | copy / paste |

## Connections

| Type | Command |
|---|---|
| Local | PowerShell (Windows) or `$SHELL -l` (macOS) in the start directory |
| SSH | `ssh -t [-p port] [-o ServerAliveInterval=30 -o ServerAliveCountMax=3] user@host '<script>'` — the script changes into the directory and attaches to (or creates) the tmux session `atm-<project>-<session>`, running the start command on creation. Without tmux: `cd <dir> && exec $SHELL -l`. |
| WSL | `wsl.exe -d <distribution> --cd <path> [-- bash -lc '<tmux script>']` |
| Agent (OpenCode) | starts `opencode serve` (locally directly, on SSH/WSL targets inside tmux) and talks to its HTTP API; SSH targets are reached via `ssh -L`. Status (working/done), prompts, answers and tool calls come structured from the API. |

Authentication uses SSH keys, ssh-agent and your own `~/.ssh/config` only (host aliases work as hostnames). No passwords are stored; fields such as `password` are stripped on save and import.

Port forwarding per SSH project (local port → remote port) runs as a separate `ssh -N -L …` process while at least one session of the project is running.

## Files

- **Drop files onto a terminal** (from the Explorer / Finder) to copy them to the project machine, into the directory the shell is in right now. Folders work too. If a name already exists you are asked before it is replaced. On a local terminal the file paths are typed in instead.
- **Files** in the project header (or *Browse files…* in the session / project context menu) opens a file browser in the shell's current directory or the project folder. Double-click opens folders and downloads files; select several entries (Ctrl / Shift) and click **Download** to copy them into a local folder (default: Downloads). **Upload…** or dropping files onto the list copies them into the folder shown; **New folder…** creates one.

SSH and WSL transfers run over `ssh` / `wsl.exe` with the same connection settings as the terminal (key authentication, `~/.ssh/config`): files are streamed with `cat`, folders with `tar`; a file is written under a temporary name and renamed when complete. The shell's directory comes from the shell itself if it reports it (OSC 7), from tmux (`pane_current_path`), or on Linux from the shell process marked with `ATM_SID` (sessions opened with this version); otherwise the project folder is used.

## Developer hosts

Under **Hosts** you register your Linux development machines once (name, hostname/IP, port, user, workspace folder, tags). Projects reference a host. The app checks reachability (TCP) every 30 s and counts sessions per host; “Check SSH” additionally counts the tmux sessions on the host.

## MCP server

Streamable HTTP at `http://127.0.0.1:47900/mcp` (bind address and port configurable, can be turned on and off). Every request needs `Authorization: Bearer <token>`: either a token created in the app (full or read-only, stored as a hash, can be revoked and renewed) or an OAuth access token (see below).

Tools:

| Tool | Purpose |
|---|---|
| `list_projects`, `list_sessions` | projects and sessions with status |
| `send_to_session` | send text/a prompt to a session (with Enter) |
| `read_output` | last N lines or output since a marker; agent sessions return messages |
| `wait_until_idle` | blocks until “waiting” (with timeout) |
| `wait_for_any_idle` | blocks until one of several sessions is done |
| `open_session` | new session (default configuration, optionally an agent) |
| `run_command` | run a saved command |
| `list_hosts`, `find_free_host` | host directory, find a free host |
| `create_directory` | create a directory in a host's workspace folder |
| `create_project` | create a project on a host and open a session with a start command |

Resources: `session://<project>/<name>/status`, subscribable (`notifications/resources/updated` on status change). Many clients don't wake the model on push notifications; the blocking wait tools are the reliable path.

Permissions (MCP page): actions with side effects can be enabled individually. By default only shared sessions are visible; sessions marked as orchestrator are never a target. All MCP, orchestrator and external requests go to the **Audit log** and to `audit.log` in the data folder.

Connect Claude Code:

```bash
claude mcp add --transport http atm http://127.0.0.1:47900/mcp --header "Authorization: Bearer <token>"
```

Clients that only speak stdio use the bridge `dist/atm-mcp-stdio.js` (`ATM_MCP_TOKEN=<token> node dist/atm-mcp-stdio.js [url]`).

Access from outside: directly over the internet behind an Nginx reverse proxy (or a tunnel) with HTTPS, see [docs/nginx.conf](docs/nginx.conf).

### OAuth sign-in (claude.ai and other web clients)

claude.ai custom connectors sign in with OAuth 2.1; they cannot send a fixed `Authorization` header. Turn on **Allow OAuth sign-in** on the MCP page, set the **Public URL** (the HTTPS URL of `/mcp` behind your proxy, e.g. `https://atm.example.com/mcp`) and pick the authorization server:

- **Built-in:** the app is its own authorization server — protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), Dynamic Client Registration and Client ID Metadata Documents, authorization code with PKCE S256, refresh tokens with rotation. When a client signs in, the app shows a dialog with the client name and the site it returns to; you approve with read-only or full access, or deny. Approved sign-ins are listed on the MCP page and can be revoked.
- **External identity provider** (authentik, Keycloak, Entra ID, …): the provider signs users in, the app only validates its JWT access tokens (signature via the provider's JWKS, issuer, expiry, and `aud`/`azp` must be one of the allowed client ids). A required group and a group with full access (claim configurable, default `groups`) control who gets in and who is read-only. **Test provider** checks discovery and keys and tells you whether clients can register automatically. authentik has no automatic client registration: create an OAuth2/OpenID provider with redirect URI `https://claude.ai/api/mcp/auth_callback` and enter its client id (and secret) under *Advanced settings* when adding the connector in claude.ai.

In claude.ai: **Customize → Connectors → Add custom connector**, URL = the public URL. claude.ai connects from Anthropic's servers (`160.79.104.0/21`), so the public URL — and an external provider — must be reachable from the internet. Serve the app on its own host name; the proxy must pass `/.well-known/oauth-*` and `/oauth/` as well as `/mcp` (see the Nginx example).

## Coding agents: install, MCP servers and skills

**Agents ▾** in the project header installs coding agents and deploys MCP servers and skills to them. Supported: Claude Code, Codex CLI, OpenCode, Antigravity CLI (agy), GitHub Copilot CLI, pi, Cursor CLI and Qwen Code.

- **Install** types the agent's official install command into the active terminal (PowerShell variant for local Windows projects, shell variant for macOS/Linux, SSH and WSL), so you see the output and can answer prompts.
- **Library** (sidebar): MCP servers (stdio command or HTTP URL; env vars and headers are stored encrypted with the OS keychain) and a skills folder with one sub-folder per skill (`<name>/SKILL.md` + files).
- **Git sources for skills** (Library → Skills): repositories (https or ssh URL, optional branch/tag and sub-folder) that the app downloads with your local git into the skills folder (`.sources/<name>`). Every folder with a `SKILL.md` becomes a skill, shown with its source and deployed like your own skills; the target machines need no Git access. **Update** fetches the newest commit; **Agents ▾ → Update skills from Git and deploy** updates the project's sources and deploys in one step. A skill name that is already taken is marked as a conflict and not deployed.
- **Project editor → Coding agents:** choose the MCP servers and skills for the project, the target agents (all installed, or a selection) and the scope: the project folder (recommended) or the user's home directory.
- **Deploy MCP & skills (update)** detects the installed agents on the project's machine and writes each agent's own config format (for example `.mcp.json` and `.claude/skills` for Claude Code, `opencode.json` for OpenCode, `~/.codex/config.toml` for Codex). Entries you added yourself are never changed; servers and skills you deselect are removed on the next deploy. What was deployed is recorded in `.agent-terminal-manager/deployed.json`. Run it again after changing the library or pulling the skills repository.

Codex and Copilot read MCP servers only from the home directory; use the user scope for them (their skills work in both scopes). Every agent is one adapter in `src/main/coding-agents/registry.js` on top of a shared interface (`base.js`); the runner (`deploy.js`) does one read and one write pass over PowerShell or `sh`, with the script sent via stdin.

### APM packages (Agent Package Manager)

[APM](https://github.com/microsoft/apm) installs packages of skills, prompts, instructions, agents and MCP servers from Git repositories into each agent's own folders (`.claude/`, `.github/`, `.agents/`, …) and pins the exact versions in `apm.lock.yaml`.

- **Library → APM packages:** references such as `microsoft/apm-sample-package`, `owner/repo/path#v1.2` (tag or commit), `plugin@marketplace` or a Git URL. Only shell-safe references are accepted.
- **Project editor → Coding agents → APM packages:** select packages per project. Project scope installs into the project folder (`apm.yml`, `apm.lock.yaml`, `apm_modules/`), user scope uses `apm -g` (`~/.apm/`).
- **Deploy MCP & skills (update)** runs APM on the project's machine: deselected packages are uninstalled (their files are removed), all selected packages are installed with `--target` set to the agents found there (Claude Code, Copilot, Codex, OpenCode, Cursor, Antigravity). The report shows APM's output.
- **Agents ▾:** *APM: check for package updates* (`apm outdated`), *APM: update packages* (`apm update --yes`, newer versions within the references, lockfile updated), *APM: list installed packages*, *Install APM* and *Update APM itself* (`apm self-update`).

## Agent sessions via ACP (Agent Client Protocol)

**+ Agent ▾** in the project header starts structured agent sessions with a chat view:

- **OpenCode (server API):** `opencode serve` over HTTP (see Connections).
- **OpenCode via ACP** (`opencode acp`) and **GitHub Copilot via ACP** (`copilot --acp`): the agent runs as a process and talks JSON-RPC over stdin/stdout. Locally it is a child process; on SSH and WSL projects it runs through the same connection (binary found with the user's PATH).

ACP sessions share the chat view and tools with the OpenCode server sessions: streamed answers and tool calls, the model picker, slash commands (`/model`, `/new`, `/stop`, `/login`, `/help` plus the agent's own commands), MCP tools (`send_to_session`, `read_output`, `wait_until_idle`) and orchestrators. When the agent asks for permission before a tool call, a card with its options appears in the chat and the session counts as *waiting* (desktop notification). The conversation and the chosen model are restored after a restart (`session/load`). **Login** opens a terminal with `opencode auth login` or `copilot login`.

The implementation is in `src/main/acp.js`; another ACP agent is one entry in `ACP_AGENTS`. ACP sessions do not run in tmux, so a dropped SSH connection ends the agent process (the conversation can be resumed with Reconnect).

## Orchestrators (OpenCode)

Under **Orchestrators** you can create several orchestrators, each with a name, system prompt (templates “Developer + reviewer”, “Watch”), model (`provider/model`, empty = OpenCode default), maximum rounds and the watched sessions picked by checkbox. On start the app launches its own `opencode serve`, registers the app's MCP server with a token valid only for those sessions, and creates an OpenCode session with the system prompt.

When a watched session finishes, the app sends the event with the latest output as a new message to the orchestrator (`[ATM event] …`); if it is busy, the event is queued. The view shows history, current action and rounds, and has an input field. Brakes: maximum rounds (then pause), pause, interrupt, stop. A session can only be controlled by one orchestrator; conflicts are rejected on save and shown.

The OpenCode program is detected automatically (on Windows including the platform binary inside the npm package); the path can be set in Settings.

## Data

`config.json`, `audit.log` and orchestrator working folders live in the app data folder (Settings → Open data folder). Export/import as JSON via Settings or the File menu; tokens are not exported.

## License

MIT — see [LICENSE](LICENSE).
