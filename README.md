# GNOME Shell Extensions

A collection of GNOME Shell extensions by Phillip Blanton ([blanton.us](https://blanton.us)). Each extension lives in its own directory, named by its UUID, and can be installed independently.

## Extensions

| Extension | Description | Shell versions |
|-----------|-------------|----------------|
| [bullion-ticker@blanton.us](bullion-ticker@blanton.us) | Desktop widget tracking gold, silver, platinum, palladium, indices and stocks, with price, daily change and expandable charts | 45 to 50 |

Each extension's directory has its own `README.md` with features, settings and data sources.

## Installing an extension

Replace `UUID` with the extension's directory name (for example `bullion-ticker@blanton.us`):

    git clone https://github.com/YOUR-USER/YOUR-REPO.git && D=~/.local/share/gnome-shell/extensions/UUID && mkdir -p "$D" && cp -r YOUR-REPO/UUID/* "$D" && glib-compile-schemas "$D/schemas"

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

TBD. Extensions published to extensions.gnome.org must use a GPL-compatible license (GPL-2.0-or-later is the usual choice).
