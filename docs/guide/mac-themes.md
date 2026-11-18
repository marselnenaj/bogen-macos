# Mac themes

On a Mac, Bogen's theme target is a **Mac theme**. It has two scopes, which stay separate:

- **Desktop appearance**: wallpapers for your Mac's displays, a light and/or dark palette, and the accent and
  highlight colour the theme is meant for.
- **Your own apps**: an appearance kit for apps you build: semantic colours for light and dark, the system font,
  type sizes, spacing and corner radii.

A new Mac theme designs both unless you pick one. Make one with **New Mac theme** on Home, or ask an agent
(`mac_theme_create`).

## One theme, one file

A Mac theme is one project file. Asking an agent for the same theme again (by its name and scopes) opens that file
instead of making another; when several files could be meant, the agent asks you which one to continue. Home's **New**
buttons always start a separate new theme, because that is what you asked for there. Alternatives and redos are
**branches** inside the file (the branch menu next to the file name): another direction stays beside the main design
until you merge or discard it. Only you merge or discard a branch. Renaming the theme on a branch renames that version
only, never the file.

## What a Mac theme really changes

Bogen designs and exports. It does not change your Mac. Before you export, the theme's panel lists each part with
its status:

| Part | Status | How |
| --- | --- | --- |
| Wallpapers for each display | Supported | PNG per appearance: a preset at its native resolution, this Mac's display at its current backing pixels |
| Setting the wallpaper | Manual | System Settings › Wallpaper › Add Photo…, per display |
| Light, Dark or Auto | Manual | System Settings › Appearance; the bundle records the one the theme was made for |
| Accent and highlight colour | Manual | macOS offers a fixed set of accents; the bundle names the nearest one, and the highlight colour for Highlight colour › Other… |
| Dynamic (self-switching) wallpaper | Not offered | That needs a special HEIC file; with Auto you get a light and a dark PNG |
| Icon and widget style, folder colour and other newer Appearance options | Not offered | Not part of the bundle; set them as you like |
| Menu bar, Dock, Finder, window controls | Preview only | Drawn in the previews as illustrations; macOS draws them itself and no theme changes them |
| Your own apps' tokens | Supported | CSS custom properties, JSON design tokens and an Xcode asset catalog of colour sets |
| Building an app | Not offered | Bogen designs the interface and exports tokens; it does not compile or ship an app |

Electron, which Bogen for macOS is built on, has no API to set the wallpaper or the appearance of the system
(`nativeTheme.themeSource` only changes Bogen's own windows), so Bogen does not try.

## In the file

- Tokens are named `mac-*`: the desktop palette (`--mac-wallpaper-sky`, `--mac-wallpaper-horizon`,
  `--mac-wallpaper-glow`, `--mac-wallpaper-ink`, `--mac-accent`, `--mac-highlight`) and the app kit
  (`--mac-app-window-background`, `--mac-app-label`, `--mac-app-accent`, `--mac-app-text-body`, …). The light value is
  the token's own value; the dark value is the file's **dark** mode.
- **Wallpaper · <display> · light/dark** boards are in points; the export renders each at the display's scale, so a
  MacBook Pro 14″ preset wallpaper is 3024 × 1964 pixels, the panel's native resolution. All of them show the
  component **Mac wallpaper**: design it once.
- **Desktop preview** boards place the wallpaper under an illustrative menu bar, window and Dock.
- **App appearance · light/dark** show a sample window of your app drawn from the app tokens.

Displays come from the Mac that runs Bogen for macOS or from presets: MacBook Air 13″ and 15″, MacBook Pro 14″ and
16″, iMac 24″, Studio Display and Pro Display XDR, each at its native resolution from Apple's specifications. A display
the app reports (kept in memory only) has the size macOS renders it at now: Electron's display size times its scale
factor, the backing pixels. Under a scaled "Looks like" resolution in System Settings › Displays that is not the
panel's native resolution, and the manifest marks it `"pixels": "backing"` (presets are `"native"`).

## The export

**Export** downloads `<name>-mac-theme.zip` (an agent's `mac_theme_export` writes it into the Bogen export folder):

```
<name>/
  bogen-mac-theme.json        format dev.bogen.mac-theme, version 1
  README.md                   what to set by hand, and where
  wallpapers/<display>-<appearance>.png
  app/tokens.css              :root (light) and prefers-color-scheme: dark
  app/tokens.json             JSON design tokens, dark values under $extensions
  app/Colors.xcassets/        one colour set per colour token, Any and Dark appearance
```

It is data only: images, JSON, CSS and Markdown. Nothing in it runs.

## Omarchy themes on a Mac

A theme file made for Omarchy Linux keeps its format when it syncs to a Mac. Its banner says **Omarchy theme**, it
exports as an Omarchy theme folder, and it is never converted into a Mac theme. Installing and applying it happens on
the Omarchy device. To make a new Omarchy theme on a Mac, filter Home by **Omarchy themes**.
