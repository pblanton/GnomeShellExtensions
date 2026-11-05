# GNOME Shell Extensions

A collection of GNOME Shell extensions by Phillip Blanton ([blanton.us](https://blanton.us)). Each extension lives in its own directory, named by its UUID, and can be installed independently.

## Extensions

| Extension | Description | Shell versions |
|-----------|-------------|----------------|
| [bullion-ticker@blanton.us](bullion-ticker@blanton.us) | Desktop widget tracking gold, silver, platinum, palladium, indices and stocks, with price, daily change and expandable charts | 45 to 50 |

Each extension's directory has its own `README.md` with features, settings and data sources.

## Bullion Ticker
A customizable GNOME Shell desktop widget that tracks gold, silver, platinum,
palladium, stock indices and individual stocks. Each row shows the live price
and the day's change (green up, red down). Click a row to drop a chart down
below it: 1D, 3D, 1W, 1M or 1Y.

![capture_2026-11-05_115303.png](bullion-ticker%40blanton.us/repo_files/capture_2026-11-05_115303.png)

## Installing an extension

This repository holds several extensions, so don't clone it into your extensions directory. Clone it somewhere else, then copy the extension you want into `~/.local/share/gnome-shell/extensions/`.

Replace `UUID` with the extension's directory name (for example `bullion-ticker@blanton.us`):

    git clone <this-repo-url> ~/src/GnomeShellExtensions
    mkdir -p ~/.local/share/gnome-shell/extensions/UUID
    cp -r ~/src/GnomeShellExtensions/UUID/* ~/.local/share/gnome-shell/extensions/UUID/
    glib-compile-schemas ~/.local/share/gnome-shell/extensions/UUID/schemas

Then reload the shell and enable it:

- **X11:** Alt+F2, type `r`, Enter
- **Wayland:** log out and back in

```
gnome-extensions enable UUID
```

Extensions without a `schemas` directory don't need the `glib-compile-schemas` step.

## Development

Each extension is self-contained:

    <uuid>/
    ├── metadata.json
    ├── extension.js
    ├── prefs.js
    ├── stylesheet.css
    └── schemas/

To work on one in place, symlink it instead of copying:

    ln -s "$PWD/UUID" ~/.local/share/gnome-shell/extensions/UUID

Logs:

    journalctl -b -o cat /usr/bin/gnome-shell

## Adding a new extension

Create a new directory named with the extension's UUID (`name@domain`), add the standard files above, and add a row to the table in this README.

## License

Licensed under the [GNU General Public License v2.0 or later](LICENSE) (SPDX: `GPL-2.0-or-later`). Each extension directory carries its own copy of the license so it can be packaged on its own.
