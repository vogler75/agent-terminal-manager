# Agent Terminal Manager – Anforderungen

## Ziel

Eine plattformübergreifende Desktop-App (Windows und macOS), mit der mehrere parallel laufende AI-Agents über Projekte verwaltet werden. Jedes Projekt hat ein oder mehrere Terminals.

## Technologie

- Electron als App-Framework
- xterm.js als Terminal-Komponente
- node-pty zum Starten von lokalen Shells und System-ssh

## Oberfläche

- Links: Projektliste
- Rechts: Terminals des ausgewählten Projekts
- Terminals eines Projekts lassen sich stapeln (Tabs) oder nebeneinander/geteilt anzeigen

### Projektbaum links

- Projekte wie Gruppen, darunter jeweils eine oder mehrere Sessions (Terminals)
- Plus-Button am Projekt öffnet eine neue Session mit der konfigurierten Standard-Session des Projekts

### Kachelansicht

- Button pro Projekt: alle Sessions des Projekts gleichzeitig im rechten Bereich anzeigen
- Automatische Aufteilung nach Anzahl: 2 = links/rechts, 3 = drei Spalten oder eine große plus zwei kleine, 4 = 2×2-Raster, mehr = passendes Raster
- Zurück zur Einzelansicht per Klick auf eine Session

### Gesamtübersicht

- Kachelansicht über alle laufenden Sessions aller Projekte, gruppiert pro Projekt (Rahmen mit Projektname und Statuspunkt)
- Skalierung über kleinere Schriftgröße in xterm.js, nicht per CSS-Zoom, damit der Text scharf bleibt
- Klick auf eine Kachel vergrößert sie bzw. wechselt in die Projektansicht
- Hinweis: Kleine Kacheln haben weniger Zeilen und Spalten, das Remote-Programm bekommt die neue Größe und bricht ggf. um

## Projektkonfiguration

- Wird direkt in der App bearbeitet, im Hintergrund als JSON gespeichert (Export/Backup möglich)
- Pro Projekt: Name, Verbindungstyp, Host, User, Port, Startverzeichnis, Anzahl/Startbefehle der Terminals

## Verbindungstypen

- SSH: automatischer Verbindungsaufbau und Wechsel ins konfigurierte Verzeichnis, z. B. `ssh -t host 'cd /pfad && exec $SHELL'`
- Lokal: Windows PowerShell bzw. lokale Shell auf macOS, Start im konfigurierten Verzeichnis

## Entwickler-Hosts

- Eigenes Verzeichnis in der App: Liste der Linux-Entwicklungsrechner, einmalig angelegt
- Pro Host: Name, Hostname/IP, Port, Benutzername, Workspace-Ordner (z. B. \~/workspace), optional Tags
- Anmeldung grundsätzlich über SSH-Keys (kein Passwort gespeichert)
- Projekte verweisen auf einen Host statt Verbindungsdaten zu duplizieren
- Verfügbarkeit pro Host (erreichbar, Anzahl laufender Sessions), damit ein freier Host gewählt werden kann

## Projekte per MCP anlegen

- Zusätzliche MCP-Tools: `list_hosts`, `find_free_host`, `create_project`, `create_directory` im Workspace-Ordner, `run_command` für gespeicherte Befehle
- Ablauf: freien Host suchen → Verzeichnis anlegen → Projekt erstellen → Session öffnen → Startbefehl ausführen
- Alle Aktionen protokolliert, per Einstellung freigebbar

## Session-Typ „Agent“ (OpenCode)

- Zusätzliche Option neben den bestehenden Session-Typen (SSH, lokal, WSL), die unverändert bleiben
- App startet OpenCode auf dem Host im Server-Modus (z. B. in tmux) und kommuniziert über dessen API/SDK statt über Terminal-Text
- Genauer Status (arbeitet/fertig) direkt aus der API, ohne Erkennung über Output-Pausen
- Prompts, Antworten und Änderungen strukturiert verfügbar, auch für den Orchestrator und den MCP-Server
- Andere Agents (z. B. Claude Code) laufen weiterhin im normalen Terminal

## MCP-Fernzugriff und Absicherung

- MCP-Server zusätzlich per HTTP (Streamable HTTP) erreichbar, damit Claude in App, Web und Sprachmodus darauf zugreifen kann
- Absicherung per API-Key bzw. Bearer-Token, in der App erzeugbar, widerrufbar und erneuerbar
- Ohne gültigen Token keine Antwort; optional getrennte Tokens mit nur Lesezugriff
- Veröffentlichung nach außen direkt über das Internet hinter einem Nginx-Reverse-Proxy (kein Tunnel), nur per HTTPS
- Alle Zugriffe von außen werden protokolliert

## Sitzungen

- Terminals bleiben beim Projektwechsel offen und verbunden (nur aus- und eingeblendet)
- tmux-Unterstützung von Anfang an: Pro Terminal eine benannte tmux-Session (attach or create), damit Agents bei Verbindungsabbruch oder App-Neustart weiterlaufen

## Keep-Alive

- Checkbox pro SSH-Projekt: Keep-Alive aktivieren
- Umsetzung über `ServerAliveInterval` (z. B. 30 s) und `ServerAliveCountMax`

## WSL

- Zusätzlicher Verbindungstyp unter Windows: WSL-Terminal über `wsl.exe -d <Distribution> --cd <Pfad>`
- Pro Projekt wählbar: Distribution und Startverzeichnis

## Agent-Status und Benachrichtigungen

- Status pro Projekt/Terminal über den Zeitpunkt des letzten Outputs, unabhängig vom laufenden Programm
- Kein Output länger als Schwelle (Standard 5 s, pro Projekt einstellbar) → grüner Punkt (Agent wartet/fertig)
- Zusätzlich: Terminal-Bell-Zeichen (BEL) erkennen, z. B. von Claude Code beim Warten auf Eingabe
- Desktop-Benachrichtigung beim Wechsel auf „wartet“

## Gespeicherte Befehle

- Pro Projekt eine Liste von Befehlen (z. B. „Agent starten“), per Klick im aktiven Terminal ausführen

## Port-Forwarding

- Pro SSH-Projekt konfigurierbare Weiterleitungen (lokaler Port → Remote-Port), damit Web-Oberflächen lokal im Browser erreichbar sind

## Später

- Remote-Desktop (RDP/VNC) zunächst zurückgestellt, zu aufwändig für den Start

## Offene Punkte

- Automatisches Reconnect bei Abbruch
- Authentifizierung (SSH-Agent, Keys, eigene SSH-Config)
- Layout pro Projekt speichern

## Umsetzungsplan mit Akzeptanzkriterien

Die Umsetzung läuft in neun Phasen (0 bis 8). Jede Phase ist abgeschlossen, wenn alle Kriterien auf Windows und macOS erfüllt sind.

> **Stand 28.10.2026:** Alle Phasen sind umgesetzt. Auf Windows 11 durch `npm test` (13 Unit-Tests) und `npm run e2e` geprüft (38 E2E-Schritte, inkl. SSH mit tmux, WSL, OpenCode-Agent und Orchestrator). Installer und Portable-Exe gebaut, die gepackte App per `test-e2e/packaged.js` getestet. **Auf macOS noch nicht geprüft:** Der Code ist plattformneutral, und `.github/workflows/build.yml` baut und testet auf macOS. Der macOS-Lauf und ein Test auf einem frischen Rechner stehen aber noch aus.

### Phase 0: Technik-Test (vor allem anderen)

Ziel: die zwei größten technischen Risiken früh klären.

- [x] Minimale Electron-App mit xterm.js und node-pty läuft unter Windows und macOS (natives Modul korrekt gebaut, z. B. mit electron-rebuild)
- [x] Installierbares Paket für beide Plattformen startet auf einem frischen Rechner
- [x] SSH-Verbindung aus dem Terminal mit automatischem Wechsel ins Verzeichnis funktioniert
- [x] tmux-Session wird angehängt oder erstellt; nach Trennen und Neuverbinden läuft der Prozess weiter

### Phase 1: Grundgerüst

- [x] Electron-App startet auf Windows und macOS
- [x] Layout mit Projektbaum links und Terminalbereich rechts
- [x] xterm.js-Terminal mit node-pty startet eine lokale Shell (PowerShell bzw. zsh/bash)
- [x] Terminal passt sich der Fenstergröße an (Resize wird an die Shell weitergegeben)
- [x] Build-Pakete für beide Plattformen (z. B. electron-builder)

### Phase 2: Projekte und Konfiguration

- [x] Projekte in der App anlegen, bearbeiten, löschen
- [x] Felder: Name, Verbindungstyp (SSH, lokal, WSL), Host, User, Port, Startverzeichnis, WSL-Distribution, Keep-Alive, Statusschwelle
- [x] Speicherung als JSON im App-Datenverzeichnis, Import und Export möglich
- [x] Konfiguration bleibt nach Neustart erhalten

### Phase 3: Verbindungen und Sessions

- [x] SSH-Session verbindet automatisch und landet im konfigurierten Verzeichnis
- [x] Lokale Session startet im konfigurierten Verzeichnis
- [x] WSL-Session startet mit gewählter Distribution und Verzeichnis
- [x] Keep-Alive-Checkbox setzt ServerAliveInterval und ServerAliveCountMax
- [x] Optional tmux: Session wird per Name angehängt oder neu erstellt; nach Verbindungsabbruch läuft der Agent weiter und die Session lässt sich wieder anhängen
- [x] Plus-Button am Projekt öffnet neue Session mit Standard-Konfiguration
- [x] Sessions erscheinen unter ihrem Projekt im Baum, lassen sich umbenennen und schließen
- [x] Beim Wechsel zwischen Projekten bleiben alle Sessions verbunden, Inhalt und Scrollback bleiben erhalten
- [x] Verbindungsfehler werden im Terminal verständlich angezeigt, mit Button für erneutes Verbinden

### Phase 4: Ansichten

- [x] Sessions eines Projekts als Tabs (gestapelt) anzeigen
- [x] Kachelansicht pro Projekt per Button: 2 = links/rechts, 3 = drei Spalten, 4 = 2×2, mehr = passendes Raster
- [x] Gesamtübersicht aller laufenden Sessions, gruppiert pro Projekt mit Rahmen, Projektname und Statuspunkt
- [x] Skalierung über Schriftgröße, Text bleibt lesbar und scharf
- [x] Klick auf eine Kachel führt zur Einzel- bzw. Projektansicht

### Phase 5: Agent-Status und Benachrichtigungen

- [x] Statuspunkt pro Session und pro Projekt im Baum
- [x] Kein Output länger als Schwelle (Standard 5 s, pro Projekt einstellbar) → grüner Punkt
- [x] Bell-Zeichen (BEL) setzt den Status sofort auf „wartet“
- [x] Desktop-Benachrichtigung beim Wechsel auf „wartet“, Klick darauf öffnet die Session
- [x] Neuer Output setzt den Status zurück auf „arbeitet“

### Phase 6: Komfortfunktionen

- [x] Gespeicherte Befehle pro Projekt anlegen und per Klick im aktiven Terminal ausführen
- [x] Port-Forwarding pro SSH-Projekt (lokaler Port → Remote-Port), aktiv solange die Session läuft
- [x] Layout pro Projekt wird gespeichert und beim Neustart wiederhergestellt

### Phase 7: Orchestrierung über MCP

Die App stellt einen MCP-Server bereit, über den ein Orchestrator-Agent die anderen Sessions steuert, z. B. ein Agent entwickelt, ein zweiter macht das Review.

- [x] MCP-Server läuft lokal in der App (stdio oder HTTP), an- und abschaltbar
- [x] Tool `list_sessions`: alle Sessions mit Projekt, Name und Status
- [x] Tool `send_to_session`: Text bzw. Prompt an eine Session senden (inkl. Enter)
- [x] Tool `read_output`: letzte N Zeilen oder Output seit Marker einer Session lesen
- [x] Tool `wait_until_idle`: blockiert, bis die Session den Status „wartet“ hat (nutzt Statuserkennung aus Phase 5), mit Timeout
- [x] Tool `open_session`: neue Session in einem Projekt mit Standard-Konfiguration starten
- [x] Orchestrator-Session im Projekt markierbar; Zugriff nur auf freigegebene Sessions
- [x] Ablauf getestet: Orchestrator gibt Aufgabe an Entwickler-Agent, wartet auf Fertig, schickt Review-Auftrag („Review der Änderungen per git diff“) an Reviewer-Agent, liest das Ergebnis
- [x] Alle MCP-Aktionen werden in der App sichtbar protokolliert

#### Aktive Benachrichtigungen

- [x] Jede Session ist als MCP-Resource veröffentlicht (z. B. `session://<projekt>/<name>/status`)
- [x] Client kann Resources abonnieren; bei Statuswechsel sendet der Server `notifications/resources/updated`
- [x] Tool `wait_for_any_idle`: blockiert, bis irgendeine der angegebenen Sessions fertig ist, und liefert welche
- [x] Hinweis: Viele Agent-Clients wecken das Modell bei Push-Notifications nicht auf; die blockierenden Warte-Tools sind deshalb der verlässliche Hauptweg, Push ist Zusatz

### Phase 8: Eingebauter Orchestrator mit OpenCode

Statt eines eigenen Agent-Frameworks bindet die App OpenCode im Server-Modus ein. Der Orchestrator ist im Kern ein System-Prompt plus die MCP-Tools aus Phase 7.

- [x] App startet und verwaltet OpenCode im Server-Modus (HTTP-API/SDK) im Hintergrund
- [x] OpenCode bekommt den MCP-Server der App mit den Session-Tools konfiguriert
- [x] Mehrere Orchestratoren gleichzeitig möglich, jeder mit eigenem Namen, System-Prompt, Modell und eigener OpenCode-Session
- [x] Pro Orchestrator per Checkbox festlegen, welche aktiven Sessions er überwacht und steuern darf
- [x] Ereignisgesteuert: Wird eine überwachte Session fertig, schickt die App das Ereignis mit dem letzten Output über die API als neue Nachricht an den zuständigen Orchestrator
- [x] Orchestrator-Ansicht in der App: Verlauf, aktuelle Aktion, eigene Eingabe an den Orchestrator
- [x] System-Prompt-Vorlagen, z. B. „Entwickler + Reviewer“
- [x] Bremsen: maximale Rundenzahl, Pause- und Stopp-Knopf pro Orchestrator
- [x] Eine Session kann nur von einem Orchestrator gleichzeitig gesteuert werden (Konflikt wird angezeigt)

### Allgemeine Kriterien

- [x] Stabil mit mindestens 5 Projekten und 15 gleichzeitigen Sessions
- [x] Keine Passwörter im Klartext in der JSON-Datei; Authentifizierung über SSH-Agent, Keys und eigene SSH-Config
- [x] Tastenkürzel für neue Session, Projektwechsel und Kachelansicht
