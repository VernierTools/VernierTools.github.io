bl_info = {
    "name": "Parent and Reveal Folder",
    "author": "Mikat",
    "version": (1, 0, 0),
    "blender": (4, 2, 0),
    "location": "File Browser path bar",
    "description": "Adds a Parent button above the File Browser path bar that "
                   "goes up to the parent directory AND selects/scrolls to the "
                   "folder you came from. Works in the editor File Browser and "
                   "in file dialogs.",
    "category": "System",
}

import bpy
import os


# ===========================================================================
# Parent: Select & Focus
#   Go up to the parent directory, then select and scroll to the folder you
#   came from. Works in the editor File Browser and in file dialogs.
# ===========================================================================

_TICK = 0.1
_TIMEOUT = 5.0
_FOCUS_REPEAT = 3

# Set to False on unregister so any in-flight timer stops on its next tick.
_registered = False


def _to_str(value):
    if isinstance(value, bytes):
        return value.decode('utf-8', 'surrogateescape')
    return value


def _file_browser_in_window(window):
    if window is None:
        return None, None
    try:
        screen = window.screen
    except Exception:
        return None, None
    for area in screen.areas:
        if area.type == 'FILE_BROWSER':
            for region in area.regions:
                if region.type == 'WINDOW':
                    return area, region
    return None, None


def _window_by_ptr(ptr):
    for w in bpy.context.window_manager.windows:
        try:
            if w.as_pointer() == ptr:
                return w
        except Exception:
            pass
    return None


class FILEBROWSER_OT_parent_select_focus(bpy.types.Operator):
    """Go to the parent directory, then select and focus the folder we came from"""
    bl_idname = "filebrowser.parent_select_focus"
    bl_label = "Parent: Select & Focus"
    bl_options = {'REGISTER'}

    @classmethod
    def poll(cls, context):
        return context.area is not None and context.area.type == 'FILE_BROWSER'

    def execute(self, context):
        window = context.window
        area = context.area if (context.area and context.area.type == 'FILE_BROWSER') else None
        region = None
        if area:
            region = next((r for r in area.regions if r.type == 'WINDOW'), None)
        if not (area and region):
            area, region = _file_browser_in_window(window)
        if not window or not area or not region:
            self.report({'WARNING'}, "File Browser not found")
            return {'CANCELLED'}

        space = area.spaces.active
        params = space.params if space else None
        if not params or not params.directory:
            self.report({'WARNING'}, "Could not read the current directory")
            return {'CANCELLED'}
        folder = os.path.basename(os.path.normpath(_to_str(params.directory)))
        if not folder:
            self.report({'INFO'}, "Already at the root directory")
            return {'CANCELLED'}

        try:
            with context.temp_override(window=window, area=area, region=region):
                bpy.ops.file.parent()
        except Exception as e:
            self.report({'WARNING'}, f"Failed to go to parent: {e}")
            return {'CANCELLED'}

        win_ptr = window.as_pointer()
        state = {"elapsed": 0.0, "found": False, "focus": 0}

        def poll_and_focus():
            # Stop immediately if the add-on was unregistered while we were running.
            if not _registered:
                return None

            win = _window_by_ptr(win_ptr)
            if win is None:
                return None
            ar, reg = _file_browser_in_window(win)
            if not ar or not reg:
                return None
            sp = ar.spaces.active
            if not sp or not sp.params:
                return None

            state["elapsed"] += _TICK

            def selected_names():
                try:
                    with bpy.context.temp_override(window=win, area=ar, region=reg):
                        return [f.name for f in bpy.context.selected_files]
                except Exception:
                    return []

            # Phase 1: keep trying to select the folder we came from until it
            # shows up in the listing (the file list may still be populating).
            if not state["found"]:
                try:
                    sp.activate_file_by_relative_path(relative_path=folder)
                except Exception:
                    pass
                if folder in selected_names():
                    state["found"] = True
                elif state["elapsed"] >= _TIMEOUT:
                    return None
                else:
                    return _TICK

            # Phase 2: scroll to the (now selected) folder. We only re-issue
            # view_selected here for scroll stability across redraws -- we do
            # NOT re-select the file, so we never fight the user. If the user
            # has clicked something else in the meantime, bail out.
            if folder not in selected_names():
                return None
            try:
                with bpy.context.temp_override(window=win, area=ar, region=reg):
                    bpy.ops.file.view_selected('INVOKE_DEFAULT')
            except Exception as e:
                print(f"[parent_button] view_selected failed: {e}")
            ar.tag_redraw()

            state["focus"] += 1
            if state["focus"] >= _FOCUS_REPEAT:
                return None
            return _TICK

        bpy.app.timers.register(poll_and_focus, first_interval=_TICK)
        return {'FINISHED'}


# Button injected above the path bar. Preferred icon with a safe fallback if
# this build doesn't accept the "large" icon as a button icon.
_ICON = 'FILE_PARENT_LARGE'
_ICON_FALLBACK = 'FILE_PARENT'


def _path_bar_button(self, context):
    row = self.layout.row(align=True)
    row.alignment = 'LEFT'   # shrink to content width (not full width)
    # Width is driven by the label text (ui_units_x is ignored in this panel and
    # scale_x snaps). Add/remove characters or spaces to resize the button.
    label = "  Parent  "
    try:
        row.operator(FILEBROWSER_OT_parent_select_focus.bl_idname,
                     text=label, icon=_ICON)
    except TypeError:
        row.operator(FILEBROWSER_OT_parent_select_focus.bl_idname,
                     text=label, icon=_ICON_FALLBACK)


# ===========================================================================
# Registration
# ===========================================================================

classes = (
    FILEBROWSER_OT_parent_select_focus,
)


def register():
    global _registered
    _registered = True

    for c in classes:
        bpy.utils.register_class(c)

    # Inject the Parent button above the path bar.
    try:
        bpy.types.FILEBROWSER_PT_directory_path.prepend(_path_bar_button)
    except Exception as e:
        print(f"[parent_button] path-bar inject failed: {e}")


def unregister():
    global _registered
    _registered = False

    try:
        bpy.types.FILEBROWSER_PT_directory_path.remove(_path_bar_button)
    except Exception:
        pass

    for c in reversed(classes):
        try:
            bpy.utils.unregister_class(c)
        except Exception:
            pass


if __name__ == "__main__":
    register()
