// Terminal color schemes. "default" is TermClaw's own; the others follow the well-known palettes.
// contrast = xterm minimumContrastRatio: text colors are lightened/darkened until they are readable
// on their background (e.g. ls' blue on green for other-writable folders).

const ansi = (normal, bright) => {
  const names = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
  const t = {};
  names.forEach((n, i) => { t[n] = normal[i]; t['bright' + n[0].toUpperCase() + n.slice(1)] = bright[i]; });
  return t;
};

export const SCHEMES = [
  {
    id: 'default', name: 'TermClaw (default)',
    theme: {
      background: '#14161b', foreground: '#d7dae0', cursor: '#5b9dff', selectionBackground: '#3a4a6b',
      ...ansi(['#1b1e25', '#f85149', '#3fb950', '#e3b341', '#5b9dff', '#bc8cff', '#39c5cf', '#d7dae0'],
        ['#6b7280', '#ff7b72', '#56d364', '#f2cc60', '#79b8ff', '#d2a8ff', '#56d4dd', '#ffffff']),
    },
  },
  {
    id: 'one-dark', name: 'One Dark',
    theme: {
      background: '#282c34', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451',
      ...ansi(['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf'],
        ['#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
    },
  },
  {
    id: 'dracula', name: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a',
      ...ansi(['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2'],
        ['#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
    },
  },
  {
    id: 'tokyo-night', name: 'Tokyo Night',
    theme: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', selectionBackground: '#33467c',
      ...ansi(['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6'],
        ['#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
    },
  },
  {
    id: 'nord', name: 'Nord',
    theme: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', selectionBackground: '#434c5e',
      ...ansi(['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0'],
        ['#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
    },
  },
  {
    id: 'gruvbox-dark', name: 'Gruvbox Dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', selectionBackground: '#504945',
      ...ansi(['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984'],
        ['#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
    },
  },
  {
    id: 'solarized-dark', name: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642',
      // bright black is base01 instead of base03 (the background), so dimmed text stays visible
      ...ansi(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
        ['#586e75', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
    },
  },
  {
    id: 'solarized-light', name: 'Solarized Light',
    theme: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', selectionBackground: '#eee8d5',
      ...ansi(['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5'],
        ['#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
    },
    contrast: 3,
  },
  {
    id: 'github-light', name: 'GitHub Light',
    theme: {
      background: '#ffffff', foreground: '#24292f', cursor: '#0969da', selectionBackground: '#b6d7ff',
      ...ansi(['#24292f', '#cf222e', '#116329', '#4d2d00', '#0969da', '#8250df', '#1b7c83', '#6e7781'],
        ['#57606a', '#a40e26', '#1a7f37', '#633c01', '#218bff', '#a475f9', '#3192aa', '#8c959f']),
    },
    contrast: 3,
  },
  {
    id: 'high-contrast', name: 'High contrast',
    theme: {
      background: '#000000', foreground: '#ffffff', cursor: '#ffff00', selectionBackground: '#264f78',
      ...ansi(['#000000', '#ff5c57', '#5af78e', '#f3f99d', '#57c7ff', '#ff6ac1', '#9aedfe', '#f1f1f0'],
        ['#808080', '#ff8080', '#80ff80', '#ffff80', '#80c0ff', '#ff80ff', '#80ffff', '#ffffff']),
    },
    contrast: 7,
  },
];

// Contrast ratio used when "Increase contrast" is switched on (WCAG AA for text).
export const READABLE_CONTRAST = 4.5;

export const schemeById = (id) => SCHEMES.find((s) => s.id === id) || SCHEMES[0];
