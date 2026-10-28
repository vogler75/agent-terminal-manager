# Agent Terminal Manager

Desktop-App (Windows und macOS) zum Verwalten vieler parallel laufender AI-Agents über Projekte. Jedes Projekt hat ein oder mehrere Terminals (lokal, SSH, WSL) oder Agent-Sessions (OpenCode über API). Ein eingebauter MCP-Server und Orchestratoren auf Basis von OpenCode steuern die Sessions.

Technik: Electron, xterm.js, node-pty, `@modelcontextprotocol/sdk`, OpenCode (Server-Modus, API v2).

## Starten

```bash
npm install
npm start
```

Pakete bauen (`release/`):

```bash
npm run dist:win
```

```bash
npm run dist:mac
```

macOS-Pakete müssen auf einem Mac gebaut werden; `.github/workflows/build.yml` baut beide Plattformen in GitHub Actions.

Tests:

```bash
npm test
```

```bash
npm run e2e
```

Das E2E-Skript steuert die echte App per Playwright. Mit Umgebungsvariablen werden zusätzliche Teile getestet: `ATM_E2E_SSH=user@host:port` (SSH-Ziel mit Key-Login und tmux), `ATM_E2E_WSL=Ubuntu`, `ATM_E2E_OPENCODE=1` (Agent-Session und Orchestrator, braucht ein funktionierendes OpenCode-Modell).

## Bedienung

- **Links** der Projektbaum: Projekte mit Statuspunkt, darunter ihre Sessions. `+` öffnet eine Session mit der Standard-Session des Projekts, `▦` schaltet die Kachelansicht, `⚙` bearbeitet das Projekt. Rechtsklick auf Projekt oder Session öffnet weitere Aktionen (umbenennen, für MCP freigeben, als Orchestrator markieren, neu verbinden, schließen mit oder ohne Beenden der tmux-Session).
- **Rechts** die Sessions des Projekts als Tabs oder Kacheln (2 = nebeneinander, 3 = drei Spalten oder 1 groß + 2 klein, 4 = 2×2, mehr = Raster). Klick auf den Kachelkopf führt zurück zur Einzelansicht.
- **Übersicht**: alle laufenden Sessions aller Projekte, gruppiert mit Rahmen, Projektname und Statuspunkt. Verkleinert wird über die xterm-Schriftgröße (scharfer Text). Kleinere Kacheln haben weniger Zeilen und Spalten; die Programme bekommen die neue Größe und brechen ggf. um. Klick öffnet die Session.
- **Status**: arbeitet (gelb, Output in den letzten *n* Sekunden), wartet (grün, kein Output länger als die Schwelle — Standard 5 s, pro Projekt einstellbar — oder Bell-Zeichen). Beim Wechsel auf „wartet“ gibt es eine Desktop-Benachrichtigung; Klick öffnet die Session.
- **Gespeicherte Befehle** pro Projekt erscheinen als Knöpfe über dem Terminal und laufen in der aktiven Session.
- Terminals bleiben beim Projektwechsel verbunden. Offene Sessions, Ansicht und Kachel-Aufteilung werden pro Projekt gespeichert und beim Neustart wiederhergestellt; mit tmux hängt sich die App an die weiterlaufenden Sessions an.

### Tastenkürzel

| Kürzel | Aktion |
|---|---|
| Strg/⌘ + Shift + T | neue Session |
| Strg/⌘ + 1…9 | Projekt wechseln |
| Strg/⌘ + Tab | nächste Session |
| Strg/⌘ + Shift + G | Kachelansicht |
| Strg/⌘ + Shift + O | Gesamtübersicht |
| Strg/⌘ + Shift + W | Session schließen |
| Strg/⌘ + Shift + C / V | Kopieren / Einfügen |

## Verbindungen

| Typ | Aufruf |
|---|---|
| Lokal | PowerShell (Windows) bzw. `$SHELL -l` (macOS) im Startverzeichnis |
| SSH | `ssh -t [-p port] [-o ServerAliveInterval=30 -o ServerAliveCountMax=3] user@host '<script>'` — das Skript wechselt ins Verzeichnis und hängt sich an die tmux-Session `atm-<projekt>-<session>` an oder legt sie an (mit Startbefehl). Ohne tmux: `cd <dir> && exec $SHELL -l`. |
| WSL | `wsl.exe -d <Distribution> --cd <Pfad> [-- bash -lc '<tmux-script>']` |
| Agent (OpenCode) | startet `opencode serve` (lokal direkt, auf SSH/WSL-Zielen in tmux) und spricht über die HTTP-API; SSH-Ziele werden per `ssh -L` erreicht. Status (arbeitet/fertig), Prompts, Antworten und Tool-Aufrufe kommen strukturiert aus der API. |

Authentifizierung ausschließlich über SSH-Keys, ssh-agent und die eigene `~/.ssh/config` (Host-Aliase funktionieren als Hostname). Es werden keine Passwörter gespeichert; beim Speichern und Importieren werden Felder wie `password` entfernt.

Port-Forwarding pro SSH-Projekt (lokaler Port → Remote-Port) läuft als eigener `ssh -N -L …`-Prozess, solange mindestens eine Session des Projekts läuft.

## Entwickler-Hosts

Unter **Hosts** werden die Linux-Entwicklungsrechner einmal angelegt (Name, Hostname/IP, Port, Benutzer, Workspace-Ordner, Tags). Projekte verweisen auf einen Host. Die App prüft die Erreichbarkeit (TCP) alle 30 s und zählt die Sessions pro Host; „SSH prüfen“ zählt zusätzlich die tmux-Sessions auf dem Host.

## MCP-Server

Streamable HTTP unter `http://127.0.0.1:47900/mcp` (Bind-Adresse und Port einstellbar, an- und abschaltbar). Jede Anfrage braucht `Authorization: Bearer <token>`; Tokens werden in der App erzeugt (voll oder nur lesen), gehasht gespeichert, und lassen sich widerrufen und erneuern.

Tools:

| Tool | Zweck |
|---|---|
| `list_projects`, `list_sessions` | Projekte und Sessions mit Status |
| `send_to_session` | Text/Prompt an eine Session (mit Enter) |
| `read_output` | letzte N Zeilen oder Output seit Marker; Agent-Sessions liefern Nachrichten |
| `wait_until_idle` | blockiert bis „wartet“ (Timeout) |
| `wait_for_any_idle` | blockiert, bis eine von mehreren Sessions fertig ist |
| `open_session` | neue Session (Standard-Konfiguration, optional Agent) |
| `run_command` | gespeicherten Befehl ausführen |
| `list_hosts`, `find_free_host` | Host-Verzeichnis, freien Host finden |
| `create_directory` | Verzeichnis im Workspace-Ordner eines Hosts anlegen |
| `create_project` | Projekt auf einem Host anlegen und Session mit Startbefehl öffnen |

Ressourcen: `session://<projekt>/<name>/status`, abonnierbar (`notifications/resources/updated` bei Statuswechsel). Viele Clients wecken das Modell bei Push-Notifications nicht auf; die blockierenden Warte-Tools sind der verlässliche Weg.

Freigaben (MCP-Seite): Aktionen mit Nebenwirkung sind einzeln freischaltbar. Standardmäßig sind nur freigegebene Sessions sichtbar; als Orchestrator markierte Sessions sind nie Ziel. Alle MCP-, Orchestrator- und externen Zugriffe landen im **Protokoll** und in `audit.log` im Datenverzeichnis.

Einbinden in Claude Code:

```bash
claude mcp add --transport http atm http://127.0.0.1:47900/mcp --header "Authorization: Bearer <token>"
```

Clients, die nur stdio sprechen, nutzen die Bridge `dist/atm-mcp-stdio.js` (`ATM_MCP_TOKEN=<token> node dist/atm-mcp-stdio.js [url]`).

Zugriff von außen (Claude App, Web, Sprachmodus): direkt über das Internet hinter einem Nginx-Reverse-Proxy mit HTTPS, siehe [docs/nginx.conf](docs/nginx.conf).

## Orchestratoren (OpenCode)

Unter **Orchestratoren** lassen sich mehrere Orchestratoren anlegen, jeder mit Name, System-Prompt (Vorlagen „Entwickler + Reviewer“, „Überwachung“), Modell (`provider/model`, leer = OpenCode-Standard), maximaler Rundenzahl und per Checkbox gewählten überwachten Sessions. Beim Start startet die App einen eigenen `opencode serve`, trägt den MCP-Server der App mit einem nur für diese Sessions gültigen Token ein und legt eine OpenCode-Session mit dem System-Prompt an.

Wird eine überwachte Session fertig, schickt die App das Ereignis mit dem letzten Output als neue Nachricht an den Orchestrator (`[ATM event] …`); ist er gerade beschäftigt, wird das Ereignis eingereiht. Die Ansicht zeigt Verlauf, aktuelle Aktion, Runden und hat ein Eingabefeld. Bremsen: maximale Rundenzahl (danach Pause), Pause, Abbrechen, Stopp. Eine Session kann nur von einem Orchestrator gesteuert werden; Konflikte werden beim Speichern abgewiesen und angezeigt.

Das OpenCode-Programm wird automatisch gesucht (unter Windows auch das Plattform-Binary im npm-Paket); der Pfad lässt sich in den Einstellungen setzen.

## Daten

`config.json`, `audit.log` und Orchestrator-Arbeitsverzeichnisse liegen im App-Datenverzeichnis (Einstellungen → Datenverzeichnis öffnen). Export/Import als JSON über Einstellungen oder das Datei-Menü; Tokens werden nicht exportiert.
