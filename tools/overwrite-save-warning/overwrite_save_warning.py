# SPDX-License-Identifier: GPL-3.0-or-later
#
# Project Save Overwrite Warning — Blender add-on
# Copyright (C) 2025 Mikat
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.

bl_info = {
    "name": "Project Save Overwrite Warning",
    "author": "Mikat",
    "version": (1, 1, 0),
    "blender": (4, 2, 0),
    "location": "Ctrl/Cmd+S / Ctrl/Cmd+Shift+S / File menu",
    "description": "Warns before overwriting an existing .blend: a live warning "
                   "inside the File Browser, plus a confirmation dialog when you "
                   "save over an existing file. Cancelling the dialog re-opens "
                   "the save browser at the same folder. Quick saves stay silent.",
    "category": "System",
}

import bpy
import os
import sys


# Seeded once per session: the first guarded Save As pulls its defaults from
# preferences, after which the user's last-used choices are kept (see invoke()).
_prefs_seeded = False


# ===========================================================================
# Overwrite Save Warning
#   Always confirm before overwriting an existing .blend in the file browser.
#   Quick saves that don't open the browser stay silent. Covers File > Save As.
# ===========================================================================

# Ctrl+S: unsaved files go through the guarded Save As; saved files overwrite silently.
class WM_OT_save_guard(bpy.types.Operator):
    bl_idname = "wm.save_guard"
    bl_label = "Save (Guarded)"

    def invoke(self, context, event):
        if not bpy.data.filepath:
            # No destination yet -> this opens the browser, so route through the guard.
            bpy.ops.wm.save_as_guard('INVOKE_DEFAULT')
        else:
            # Already saved -> plain quick save, no browser, no warning.
            bpy.ops.wm.save_mainfile()
        return {'FINISHED'}


# Save As: always opens the browser; confirms when the target already exists.
class WM_OT_save_as_guard(bpy.types.Operator):
    bl_idname = "wm.save_as_guard"
    bl_label = "Save As (Guarded)"

    filepath: bpy.props.StringProperty(subtype='FILE_PATH')
    filter_glob: bpy.props.StringProperty(default="*.blend", options={'HIDDEN'})
    copy: bpy.props.BoolProperty(
        name="Save Copy",
        description="Save a copy of the file without making it the active file",
        default=False, options={'SKIP_SAVE'}
    )
    check_existing: bpy.props.BoolProperty(default=True, options={'HIDDEN'})

    # --- Native save options (not HIDDEN, so they appear in the browser side panel) ---
    compress: bpy.props.BoolProperty(
        name="Compress",
        description="Compress the Blender file on saving",
        default=False
    )
    relative_remap: bpy.props.BoolProperty(
        name="Remap Relative",
        description="Remap relative paths when saving to a different directory",
        default=True
    )

    # Transient flag driving the in-browser overwrite warning. SKIP_SAVE keeps it
    # from sticking between invocations / showing up in the redo panel.
    will_overwrite: bpy.props.BoolProperty(
        default=False, options={'HIDDEN', 'SKIP_SAVE'}
    )

    # When set, re-open the browser at this path instead of the current file's
    # location. Used by the overwrite dialog's Cancel to send the user back to
    # the same folder. SKIP_SAVE so a normal Save As never inherits it.
    reopen_filepath: bpy.props.StringProperty(
        default="", options={'HIDDEN', 'SKIP_SAVE'}
    )

    def _resolve_path(self):
        """Absolute target path with the .blend extension completed."""
        raw = self.filepath
        if not raw:
            return ""
        path = bpy.path.abspath(raw)
        if not path.lower().endswith(".blend"):
            path += ".blend"
        return path

    def check(self, context):
        # The File Browser calls this whenever the path or file name changes.
        # Returning True asks the browser to redraw so the warning stays live.
        try:
            exists = bool(self._resolve_path()) and os.path.isfile(self._resolve_path())
        except Exception:
            exists = False
        if exists != self.will_overwrite:
            self.will_overwrite = exists
            return True
        return False

    def draw(self, context):
        # Rendered in the File Browser's right-hand options panel. Because we
        # define draw(), we lay out the save options ourselves and append the
        # overwrite warning *before* the browser closes.
        layout = self.layout
        layout.prop(self, "compress")
        layout.prop(self, "relative_remap")
        layout.prop(self, "copy")
        if self.will_overwrite:
            box = layout.box()
            col = box.column(align=True)
            col.alert = True
            col.label(text="This file already exists.", icon='ERROR')
            col.label(text="Saving will overwrite it.")

    def invoke(self, context, event):
        if self.copy and not self.reopen_filepath:
            # File > Save Copy... -> defer to the native, unguarded behavior so it
            # keeps Blender's own Save Copy UX. The in-panel "Save Copy" checkbox
            # of a normal guarded Save As is handled through execute() instead.
            bpy.ops.wm.save_as_mainfile('INVOKE_DEFAULT', copy=True)
            return {'FINISHED'}

        if self.reopen_filepath:
            # Re-opened after the user declined an overwrite. Keep their folder
            # and the options they already had; don't reset from preferences.
            self.filepath = self.reopen_filepath
        else:
            global _prefs_seeded
            if not _prefs_seeded:
                # Seed defaults from preferences once per session; afterwards keep
                # whatever the user last chose. Blender persists non-SKIP_SAVE
                # operator properties between invocations, so a temporary toggle
                # (e.g. turning Compress off) is no longer forgotten next time.
                # The group is "filepaths" (plural); getattr guards version diffs.
                prefs = context.preferences.filepaths
                self.compress = getattr(prefs, "use_file_compression", False)
                self.relative_remap = getattr(prefs, "use_relative_paths", True)
                _prefs_seeded = True
            self.filepath = bpy.data.filepath or "untitled.blend"

        # Prime the warning flag so it is already correct on first draw.
        self.check(context)
        context.window_manager.fileselect_add(self)
        return {'RUNNING_MODAL'}

    def execute(self, context):
        # Normalize to an absolute path with the extension completed.
        path = self._resolve_path()
        if not path:
            self.report({'WARNING'}, "No file path given")
            return {'CANCELLED'}

        # Keep the property in sync with the completed absolute path.
        self.filepath = path

        if os.path.isfile(path):
            # Existing file (the red state) -> confirm, passing the save options along.
            bpy.ops.wm.confirm_overwrite(
                'INVOKE_DEFAULT',
                filepath=self.filepath,
                compress=self.compress,
                relative_remap=self.relative_remap,
                copy=self.copy
            )
        else:
            # New file -> save directly.
            bpy.ops.wm.save_as_mainfile(
                filepath=self.filepath,
                compress=self.compress,
                relative_remap=self.relative_remap,
                copy=self.copy
            )

        return {'FINISHED'}


# Overwrite confirmation dialog (saves only when OK is pressed).
class WM_OT_confirm_overwrite(bpy.types.Operator):
    bl_idname = "wm.confirm_overwrite"
    bl_label = "Overwrite existing file?"

    filepath: bpy.props.StringProperty(subtype='FILE_PATH', options={'HIDDEN'})
    compress: bpy.props.BoolProperty(default=False, options={'HIDDEN'})
    relative_remap: bpy.props.BoolProperty(default=True, options={'HIDDEN'})
    copy: bpy.props.BoolProperty(default=False, options={'HIDDEN'})

    def invoke(self, context, event):
        return context.window_manager.invoke_props_dialog(self, width=400)

    def draw(self, context):
        col = self.layout.column(align=True)
        # Red (alert) block so the danger is unmistakable; the question below
        # stays in the normal color for readability.
        warn = col.column(align=True)
        warn.alert = True
        warn.label(text="A file with this name already exists:", icon='ERROR')
        warn.label(text=f"  {os.path.basename(self.filepath)}")
        col.separator()
        col.label(text="Overwrite it?")

    def execute(self, context):
        # Save with the options carried over from the guard.
        bpy.ops.wm.save_as_mainfile(
            filepath=self.filepath,
            compress=self.compress,
            relative_remap=self.relative_remap,
            copy=self.copy
        )
        self.report({'INFO'}, "File overwritten")
        return {'FINISHED'}

    def cancel(self, context):
        # The user declined the overwrite (Cancel / Esc / click away). Re-open
        # the Save As browser at the same folder so they can pick another name.
        #
        # The re-open is deferred with a zero-delay timer on purpose: launching
        # a file selector directly from a closing popup can freeze Blender
        # (a long-standing limitation of nesting modal handlers), so we let the
        # dialog finish tearing down first, then open the browser on the next
        # tick.
        path = self.filepath
        compress = self.compress
        relative_remap = self.relative_remap
        copy = self.copy
        # Capture the window now; timer callbacks run with no guaranteed UI
        # context, so we override it explicitly when re-opening the browser.
        win = context.window

        def reopen():
            kwargs = dict(
                reopen_filepath=path,
                compress=compress,
                relative_remap=relative_remap,
                copy=copy,
            )
            try:
                if win is not None:
                    with bpy.context.temp_override(window=win):
                        bpy.ops.wm.save_as_guard('INVOKE_DEFAULT', **kwargs)
                else:
                    bpy.ops.wm.save_as_guard('INVOKE_DEFAULT', **kwargs)
            except Exception as e:
                print(f"[overwrite_warning] reopen after cancel failed: {e}")
            return None  # one-shot

        bpy.app.timers.register(reopen, first_interval=0.0)


# --- File menu override (hook layout.operator to swap in the guarded Save As) ---

_SUBLAYOUT_METHODS = {
    "row", "column", "column_flow", "grid_flow", "box", "split", "menu_pie",
}


class _OpPropsProxy:
    """Wraps the OperatorProperties returned for the swapped Save As item.

    A File-menu entry might set a property that native save_as_mainfile has but
    the guard operator doesn't (e.g. display_type, added by Blender or another
    add-on). Swallowing those assignments keeps a single odd property from
    raising and taking the whole menu draw down with it.
    """

    def __init__(self, props):
        object.__setattr__(self, "_props", props)

    def __setattr__(self, name, value):
        try:
            setattr(self._props, name, value)
        except (AttributeError, TypeError):
            pass

    def __getattr__(self, name):
        return getattr(self._props, name)


class _LayoutProxy:
    """Wraps a UILayout, redirecting only the wm.save_as_mainfile call."""

    def __init__(self, layout):
        object.__setattr__(self, "_layout", layout)

    def operator(self, idname, *args, **kwargs):
        swapped = idname == "wm.save_as_mainfile"
        if swapped:
            idname = "wm.save_as_guard"
        props = self._layout.operator(idname, *args, **kwargs)
        return _OpPropsProxy(props) if swapped else props

    def __getattr__(self, name):
        attr = getattr(self._layout, name)
        if name in _SUBLAYOUT_METHODS and callable(attr):
            def wrapped(*a, **k):
                return _LayoutProxy(attr(*a, **k))
            return wrapped
        return attr

    def __setattr__(self, name, value):
        setattr(self._layout, name, value)


class _MenuShim:
    """Stand-in for the self passed to draw(); only swaps out layout."""

    def __init__(self, real, layout):
        object.__setattr__(self, "_real", real)
        object.__setattr__(self, "_proxy", layout)

    @property
    def layout(self):
        return self._proxy

    def __getattr__(self, name):
        return getattr(self._real, name)


_orig_file_draw = None
_menu_error_logged = False


def _patched_file_draw(self, context):
    global _menu_error_logged
    try:
        shim = _MenuShim(self, _LayoutProxy(self.layout))
        _orig_file_draw(shim, context)
    except Exception as e:
        # Do NOT re-run the native draw here: the patched pass may have already
        # emitted some menu items, so drawing again would duplicate them (a
        # second "New", "Open", etc.). Just log once and leave the menu as-is.
        # With the property proxy above, this path should be unreachable.
        if not _menu_error_logged:
            print(f"[overwrite_warning] file-menu patch failed: {e}")
            _menu_error_logged = True


def patch_file_menu():
    global _orig_file_draw
    if _orig_file_draw is None:
        _orig_file_draw = bpy.types.TOPBAR_MT_file.draw
        bpy.types.TOPBAR_MT_file.draw = _patched_file_draw


def unpatch_file_menu():
    global _orig_file_draw
    if _orig_file_draw is None:
        return
    if bpy.types.TOPBAR_MT_file.draw is _patched_file_draw:
        # We're still the active draw -> clean restore.
        bpy.types.TOPBAR_MT_file.draw = _orig_file_draw
        _orig_file_draw = None
    # else: another add-on patched on top of us. Restoring here would clobber it,
    # and nulling _orig_file_draw would break our own still-referenced patch, so
    # we leave the chain intact (the hook simply lingers until the other is gone).


# --- Keymaps ---

addon_keymaps = []


def register_keymaps():
    wm = bpy.context.window_manager
    kc = wm.keyconfigs.addon
    if not kc:
        return

    km = kc.keymaps.new(name='Window', space_type='EMPTY')

    # Ctrl variants (all platforms). Blender's built-in "Cmd acts as Ctrl" on
    # macOS only applies to the default keyconfig, not to add-on keymaps, so the
    # Cmd shortcuts have to be registered explicitly below.
    kmi1 = km.keymap_items.new("wm.save_guard", 'S', 'PRESS', ctrl=True)
    kmi2 = km.keymap_items.new("wm.save_as_guard", 'S', 'PRESS', ctrl=True, shift=True)
    addon_keymaps.append((km, kmi1))
    addon_keymaps.append((km, kmi2))

    if sys.platform == 'darwin':
        # macOS: bind Cmd (oskey) so Cmd+S / Cmd+Shift+S hit the guard too,
        # matching what Mac users expect and overriding the native Cmd bindings.
        kmi3 = km.keymap_items.new("wm.save_guard", 'S', 'PRESS', oskey=True)
        kmi4 = km.keymap_items.new("wm.save_as_guard", 'S', 'PRESS', oskey=True, shift=True)
        addon_keymaps.append((km, kmi3))
        addon_keymaps.append((km, kmi4))


def unregister_keymaps():
    for km, kmi in addon_keymaps:
        km.keymap_items.remove(kmi)
    addon_keymaps.clear()


# ===========================================================================
# Registration
# ===========================================================================

classes = (
    WM_OT_save_guard,
    WM_OT_save_as_guard,
    WM_OT_confirm_overwrite,
)


def register():
    for c in classes:
        bpy.utils.register_class(c)

    # Overwrite save warning (keymaps + File menu hook).
    register_keymaps()
    patch_file_menu()


def unregister():
    unpatch_file_menu()
    unregister_keymaps()

    for c in reversed(classes):
        try:
            bpy.utils.unregister_class(c)
        except Exception:
            pass


if __name__ == "__main__":
    register()
