# Yemot menu configuration snapshots

These files document the active configuration stored in Yemot's IVR content system; they are reference files, not configuration files automatically read by Render.

- `root-ext.ini`: the main folder `/` is a menu that speaks only the `menu_voice` text and has no `api_link`. Key presses 1 and 2 route to subfolders 1 and 2 using Yemot's normal menu behavior.
- `1-ext.ini`: only extension 1 calls the Render endpoint `/ivr` for minyan search.

The main-folder settings were written using Yemot's `UploadTextFile` API and verified with `GetTextFile` after the update.
