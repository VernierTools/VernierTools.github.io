bl_info = {
    "name": "Editor Subtabs",
    "author": "Mikat",
    "version": (1, 6, 0),
    "blender": (4, 5, 0),
    "location": "Preferences > Add-ons; sub-tabs appear in the chosen editor's header",
    "description": (
        "Create named groups of editor switch targets. Each group swaps targets uniquely "
        "across all groups. Reorder with the list arrows, choose an icon/name display mode "
        "per group, and export/import as JSON."
    ),
    "category": "Interface",
}

import json
import time

import bpy
from bpy.props import (
    BoolProperty,
    CollectionProperty,
    IntProperty,
    StringProperty,
    EnumProperty,
)
from bpy.types import AddonPreferences, Operator, Panel, PropertyGroup
from bpy_extras.io_utils import ExportHelper, ImportHelper

# Identifier used both for the AddonPreferences bl_idname and for looking the
# add-on up in context.preferences.addons. Keeping a single source of truth
# avoids a mismatch between the legacy (single-file) and 4.2+ extension layouts.
ADDON_ID = __package__ if __package__ else __name__

# Settings schema version written into exported JSON files.
SETTINGS_VERSION = 2

# --------------------------------------------------------------------------
# Editor definitions
# --------------------------------------------------------------------------

EDITOR_ITEMS_ENUM = [
    ("VIEW_3D", "3D Viewport", "3D Viewport", "VIEW3D", 1),
    ("IMAGE_EDITOR", "Image Editor", "Image Editor", "IMAGE_DATA", 2),
    ("UV", "UV Editor", "UV Editor", "UV", 3),
    ("ShaderNodeTree", "Shader Editor", "Shader Editor", "NODE_MATERIAL", 4),
    ("GeometryNodeTree", "Geometry Nodes", "Geometry Nodes", "GEOMETRY_NODES", 5),
    ("CompositorNodeTree", "Compositor", "Compositor", "NODE_COMPOSITING", 6),
    ("TextureNodeTree", "Texture Node", "Texture Node", "NODE_TEXTURE", 7),
    ("TIMELINE", "Timeline", "Timeline", "TIME", 8),
    ("DOPESHEET", "Dope Sheet", "Dope Sheet", "ACTION", 9),
    ("FCURVES", "Graph Editor", "Graph Editor", "GRAPH", 10),
    ("DRIVERS", "Drivers", "Drivers", "DRIVER", 23),
    ("NLA_EDITOR", "Nonlinear Animation", "Nonlinear Animation", "NLA", 11),
    ("SEQUENCE_EDITOR", "Video Sequencer", "Video Sequencer", "SEQUENCE", 12),
    ("CLIP_EDITOR", "Movie Clip Editor", "Movie Clip Editor", "TRACKER", 13),
    ("TEXT_EDITOR", "Text Editor", "Text Editor", "TEXT", 14),
    ("CONSOLE", "Python Console", "Python Console", "CONSOLE", 15),
    ("INFO", "Info", "Info", "INFO", 16),
    ("OUTLINER", "Outliner", "Outliner", "OUTLINER", 17),
    ("PROPERTIES", "Properties", "Properties", "PROPERTIES", 18),
    ("FILES", "File Browser", "File Browser", "FILEBROWSER", 19),
    ("ASSETS", "Asset Browser", "Asset Browser", "ASSET_MANAGER", 20),
    ("PREFERENCES", "Preferences", "Preferences", "PREFERENCES", 21),
    ("SPREADSHEET", "Spreadsheet", "Spreadsheet", "SPREADSHEET", 22),
]

# Short labels used on the header buttons when names are shown. The full names
# are too long to sit comfortably in a header, so these abbreviations are used.
EDITOR_ABBREV = {
    "VIEW_3D": "3D",
    "IMAGE_EDITOR": "Img",
    "UV": "UV",
    "ShaderNodeTree": "Shdr",
    "GeometryNodeTree": "Geo",
    "CompositorNodeTree": "Comp",
    "TextureNodeTree": "Tex",
    "TIMELINE": "Time",
    "DOPESHEET": "Dope",
    "FCURVES": "Graph",
    "DRIVERS": "Drv",
    "NLA_EDITOR": "NLA",
    "SEQUENCE_EDITOR": "Seq",
    "CLIP_EDITOR": "Clip",
    "TEXT_EDITOR": "Text",
    "CONSOLE": "Con",
    "INFO": "Info",
    "OUTLINER": "Outl",
    "PROPERTIES": "Props",
    "FILES": "Files",
    "ASSETS": "Assets",
    "PREFERENCES": "Prefs",
    "SPREADSHEET": "Sheet",
}

DISPLAY_MODE_ITEMS = [
    ("ICON", "Icon Only", "Show only the editor icon"),
    ("ICON_TEXT", "Icon + Name", "Show the editor icon and its short name"),
    ("TEXT", "Name Only", "Show only the editor's short name"),
]

# Modifier combinations offered for scroll-switching. Unlike a held letter key,
# Ctrl/Shift/Alt are matched exactly, so they suppress the editor's built-in
# plain-wheel actions (zoom/scroll). Ctrl+Alt is rarely bound by defaults.
SCROLL_MOD_ITEMS = [
    ("SHIFT_ALT", "Shift + Alt / Option",
     "Hold Shift+Alt (Option on Mac) and roll the wheel. Rarely clashes with "
     "Blender's built-in wheel zoom/pan"),
    ("CTRL_ALT", "Ctrl + Alt / Option",
     "Hold Ctrl+Alt (Option on Mac) and roll the wheel. Note: Ctrl+scroll can "
     "trigger the system screen-zoom on macOS"),
    ("CTRL_SHIFT", "Ctrl + Shift",
     "Hold Ctrl+Shift and roll the wheel. Note: Ctrl+scroll can trigger the "
     "system screen-zoom on macOS"),
    ("ALT", "Alt / Option (may not switch)",
     "Hold Alt (Option on Mac). Warning: Blender already uses Alt+Wheel for "
     "zoom / proportional size in many editors, so switching may not work there"),
    ("SHIFT", "Shift (may not switch)",
     "Hold Shift. Warning: Blender already uses Shift+Wheel to pan in many "
     "editors, so switching may not work there"),
]

# (ctrl, shift, alt) for each combo above.
SCROLL_MOD_FLAGS = {
    "CTRL": (True, False, False),
    "SHIFT": (False, True, False),
    "ALT": (False, False, True),
    "CTRL_ALT": (True, False, True),
    "CTRL_SHIFT": (True, True, False),
    "SHIFT_ALT": (False, True, True),
}

EDITOR_ORDER = [item[0] for item in EDITOR_ITEMS_ENUM]
EDITOR_SET = set(EDITOR_ORDER)
EDITOR_LOOKUP = {item[0]: (item[1], item[2], item[3]) for item in EDITOR_ITEMS_ENUM}

# Sentinel target meaning "no editor assigned". An EnumProperty must always hold
# one of its items, so an explicit empty option is used to represent a blank slot.
NONE_TARGET = "NONE"
SLOT_ENUM_ITEMS = [
    (NONE_TARGET, "None", "No editor assigned to this slot", 'BLANK1', 0),
] + EDITOR_ITEMS_ENUM

HEADER_CLASSES = [
    "VIEW3D_HT_header",
    "IMAGE_HT_header",
    "NODE_HT_header",
    "OUTLINER_HT_header",
    "PROPERTIES_HT_header",
    "DOPESHEET_HT_header",
    "GRAPH_HT_header",
    "SEQUENCER_HT_header",
    "TEXT_HT_header",
    "INFO_HT_header",
    "NLA_HT_header",
    "CLIP_HT_header",
    "CONSOLE_HT_header",
    "USERPREF_HT_header",
    "SPREADSHEET_HT_header",
    "FILEBROWSER_HT_header",
]
# NOTE: Timeline (ui_type 'TIMELINE') is the Dope Sheet space in timeline mode,
# so DOPESHEET_HT_header already draws our buttons there. TIME_HT_editor_buttons
# and TIME_HT_header are intentionally NOT hooked: DOPESHEET_HT_header internally
# calls TIME_HT_editor_buttons in timeline mode, so hooking it too would draw the
# sub-tabs twice (a duplicate set of buttons in the Timeline header only).

# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------

def _get_prefs(context=None):
    context = context or bpy.context
    try:
        addon = context.preferences.addons.get(ADDON_ID)
    except (AttributeError, KeyError):
        return None
    if addon is None:
        return None
    return addon.preferences

def get_total_slots(prefs):
    if not prefs:
        return 0
    # Only real editors are limited (each is unique); empty "None" slots are free.
    return sum(
        1
        for group in prefs.groups
        for slot in group.slots
        if slot.target != NONE_TARGET
    )

def _group_for_area(prefs, area):
    if prefs is None or area is None:
        return None
    for group in prefs.groups:
        if not group.enabled:
            continue
        for slot in group.slots:
            if slot.target == area.ui_type:
                return group
    return None

def _area_under_mouse(window, x, y):
    """Return the area whose rectangle contains the window-space point (x, y)."""
    if window is None or window.screen is None:
        return None
    for area in window.screen.areas:
        if area.x <= x < area.x + area.width and area.y <= y < area.y + area.height:
            return area
    return None

def _slot_labels(slot_target):
    label, desc, icon = EDITOR_LOOKUP.get(slot_target, (slot_target, slot_target, "QUESTION"))
    return label, desc, icon

def _abbrev(slot_target):
    return EDITOR_ABBREV.get(slot_target, slot_target)

def _tag_redraw_all():
    wm = bpy.context.window_manager
    if wm is None:
        return
    for win in wm.windows:
        if win.screen is None:
            continue
        for area in win.screen.areas:
            area.tag_redraw()

# --------------------------------------------------------------------------
# Settings serialization (JSON export / import)
# --------------------------------------------------------------------------

def serialize_prefs(prefs):
    """Build a plain dict describing all groups and slots, ready for json.dump."""
    return {
        "addon": "Editor Subtabs",
        "version": SETTINGS_VERSION,
        "groups": [
            {
                "name": group.name,
                "enabled": group.enabled,
                "alignment": group.alignment,
                "display_mode": group.display_mode,
                "scroll_switch": group.scroll_switch,
                "slots": [slot.target for slot in group.slots],
            }
            for group in prefs.groups
        ],
    }

def apply_imported_data(prefs, data):
    """Validate `data` and rebuild prefs.groups from it.

    Returns (ok: bool, message: str). Invalid or duplicate targets are skipped
    rather than raising, so a partially corrupt file still imports cleanly while
    keeping the global "each target used once" invariant intact.
    """
    if not isinstance(data, dict):
        return False, "Invalid file: the root element is not an object."

    groups_data = data.get("groups")
    if not isinstance(groups_data, list):
        return False, "Invalid file: 'groups' is missing or not a list."

    valid_modes = {item[0] for item in DISPLAY_MODE_ITEMS}

    used_targets = set()
    cleaned_groups = []
    skipped_invalid = 0
    skipped_duplicate = 0

    for group_data in groups_data:
        if not isinstance(group_data, dict):
            continue

        name = group_data.get("name", "Group")
        if not isinstance(name, str) or not name:
            name = "Group"

        alignment = group_data.get("alignment", "RIGHT")
        if alignment not in ("LEFT", "RIGHT"):
            alignment = "RIGHT"

        display_mode = group_data.get("display_mode", "ICON")
        if display_mode not in valid_modes:
            display_mode = "ICON"

        enabled = group_data.get("enabled", True)
        if not isinstance(enabled, bool):
            enabled = True

        scroll_switch = group_data.get("scroll_switch", True)
        if not isinstance(scroll_switch, bool):
            scroll_switch = True

        raw_slots = group_data.get("slots", [])
        if not isinstance(raw_slots, list):
            raw_slots = []

        cleaned_slots = []
        for target in raw_slots:
            if not isinstance(target, str):
                skipped_invalid += 1
                continue
            if target == NONE_TARGET:
                cleaned_slots.append(NONE_TARGET)
                continue
            if target not in EDITOR_SET:
                skipped_invalid += 1
                continue
            if target in used_targets:
                skipped_duplicate += 1
                continue
            used_targets.add(target)
            cleaned_slots.append(target)

        cleaned_groups.append((name, enabled, alignment, display_mode, scroll_switch, cleaned_slots))

    if not cleaned_groups:
        return False, "No valid groups were found in the file."

    global _is_updating
    _is_updating = True
    try:
        prefs.groups.clear()
        for name, enabled, alignment, display_mode, scroll_switch, slots in cleaned_groups:
            group = prefs.groups.add()
            group.name = name
            group.enabled = enabled
            group.alignment = alignment
            group.display_mode = display_mode
            group.scroll_switch = scroll_switch
            for target in slots:
                slot = group.slots.add()
                slot.target = target
                slot.prev_target = target
    finally:
        _is_updating = False

    message = f"Imported {len(cleaned_groups)} group(s)."
    extras = []
    if skipped_invalid:
        extras.append(f"{skipped_invalid} unknown target(s)")
    if skipped_duplicate:
        extras.append(f"{skipped_duplicate} duplicate(s)")
    if extras:
        message += " Skipped " + ", ".join(extras) + "."
    return True, message

# --------------------------------------------------------------------------
# Data blocks & Update Logic
# --------------------------------------------------------------------------

_is_updating = False

# Trackpad scroll accumulation (pixels) and the time of the last pan event.
_tp_accum = 0.0
_tp_last_time = 0.0

def update_slot_target(self, context):
    """When the user picks an editor already used elsewhere, empty that slot."""
    global _is_updating
    if _is_updating:
        return

    _is_updating = True
    try:
        prefs = _get_prefs(context)
        if not prefs:
            return

        new_target = self.target
        old_target = self.prev_target

        if new_target == old_target:
            return

        # Only real editors are unique; "None" may appear any number of times.
        # If the chosen editor is already used in another slot, clear that slot
        # rather than swapping. The invariant guarantees at most one match.
        cleared_label = None
        if new_target != NONE_TARGET:
            done = False
            for group in prefs.groups:
                for slot in group.slots:
                    if slot != self and slot.target == new_target:
                        slot.target = NONE_TARGET
                        slot.prev_target = NONE_TARGET
                        cleared_label = _slot_labels(new_target)[0]
                        done = True
                        break
                if done:
                    break

        self.prev_target = new_target

        if cleared_label:
            prefs.notice = (
                f"'{cleared_label}' was already in use, so the duplicate slot "
                f"was set to None."
            )
        else:
            prefs.notice = ""

        _tag_redraw_all()
    finally:
        _is_updating = False


class EditorSubtabSlot(PropertyGroup):
    target: EnumProperty(
        name="Target",
        items=SLOT_ENUM_ITEMS,
        default=NONE_TARGET,
        update=update_slot_target,
    )
    # Hidden property to keep track of the previous state for clean updates
    prev_target: StringProperty(default=NONE_TARGET)


class EditorSubtabGroup(PropertyGroup):
    name: StringProperty(name="Group Name", default="Group")
    enabled: BoolProperty(
        name="Enabled",
        default=True,
        description=(
            "Show this group's buttons in the editor header. "
            "When disabled, the buttons are hidden"
        ),
        update=lambda self, context: _tag_redraw_all(),
    )
    alignment: EnumProperty(
        name="Alignment",
        items=[
            ("LEFT", "Left", "Display on the left side of the header"),
            ("RIGHT", "Right", "Display on the right side of the header"),
        ],
        default="RIGHT",
        description="Display position in the header",
        update=lambda self, context: _tag_redraw_all(),
    )
    display_mode: EnumProperty(
        name="Display",
        items=DISPLAY_MODE_ITEMS,
        default="ICON",
        description="How each switch button is shown in the header",
        update=lambda self, context: _tag_redraw_all(),
    )
    scroll_switch: BoolProperty(
        name="Wheel Switch",
        default=True,
        description=(
            "Allow the modifier + mouse wheel to cycle this group's slots when "
            "the cursor is over one of its editors"
        ),
    )
    slots: CollectionProperty(type=EditorSubtabSlot)

# --------------------------------------------------------------------------
# Operators
# --------------------------------------------------------------------------

class SUBTAB_OT_group_add(Operator):
    bl_idname = "screen.subtab_group_add"
    bl_label = "Add Group"
    bl_options = {'INTERNAL', 'UNDO'}

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        group = prefs.groups.add()
        group.name = f"Group {len(prefs.groups)}"

        # Add an initial slot if the unique-editor limit isn't reached.
        if get_total_slots(prefs) < len(EDITOR_ORDER):
            slot = group.slots.add()
            used_targets = {s.target for g in prefs.groups for s in g.slots if s != slot}
            avail = [t for t in EDITOR_ORDER if t not in used_targets]
            if avail:
                global _is_updating
                _is_updating = True
                slot.target = avail[0]
                slot.prev_target = avail[0]
                _is_updating = False

        _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_group_remove(Operator):
    bl_idname = "screen.subtab_group_remove"
    bl_label = "Remove Group"
    bl_options = {'INTERNAL', 'UNDO'}

    index: IntProperty(default=-1)

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        idx = self.index if self.index >= 0 else len(prefs.groups) - 1
        if 0 <= idx < len(prefs.groups):
            prefs.groups.remove(idx)
            _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_group_move(Operator):
    bl_idname = "screen.subtab_group_move"
    bl_label = "Move Group"
    bl_options = {'INTERNAL', 'UNDO'}

    index: IntProperty()
    direction: IntProperty()

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        idx1 = self.index
        idx2 = self.index + self.direction
        if 0 <= idx1 < len(prefs.groups) and 0 <= idx2 < len(prefs.groups):
            prefs.groups.move(idx1, idx2)
            _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_slot_add(Operator):
    bl_idname = "screen.subtab_slot_add"
    bl_label = "Add Slot"
    bl_options = {'INTERNAL', 'UNDO'}

    group_index: IntProperty(default=-1)

    @classmethod
    def poll(cls, context):
        prefs = _get_prefs(context)
        return prefs is not None and get_total_slots(prefs) < len(EDITOR_ORDER)

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        if get_total_slots(prefs) >= len(EDITOR_ORDER):
            self.report({'WARNING'}, "Maximum number of unique editors reached.")
            return {'CANCELLED'}

        if not (0 <= self.group_index < len(prefs.groups)):
            return {'CANCELLED'}

        group = prefs.groups[self.group_index]
        slot = group.slots.add()

        used_targets = {s.target for g in prefs.groups for s in g.slots if s != slot}
        avail = [t for t in EDITOR_ORDER if t not in used_targets]

        if avail:
            global _is_updating
            _is_updating = True
            slot.target = avail[0]
            slot.prev_target = avail[0]
            _is_updating = False

        _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_slot_remove(Operator):
    bl_idname = "screen.subtab_slot_remove"
    bl_label = "Remove Slot"
    bl_options = {'INTERNAL', 'UNDO'}

    group_index: IntProperty(default=-1)
    slot_index: IntProperty(default=-1)

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        if not (0 <= self.group_index < len(prefs.groups)):
            return {'CANCELLED'}

        group = prefs.groups[self.group_index]
        if 0 <= self.slot_index < len(group.slots):
            group.slots.remove(self.slot_index)
            _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_slot_move(Operator):
    bl_idname = "screen.subtab_slot_move"
    bl_label = "Move Slot"
    bl_options = {'INTERNAL', 'UNDO'}

    group_index: IntProperty(default=-1)
    slot_index: IntProperty(default=-1)
    direction: IntProperty()

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        if not (0 <= self.group_index < len(prefs.groups)):
            return {'CANCELLED'}

        group = prefs.groups[self.group_index]
        idx1 = self.slot_index
        idx2 = self.slot_index + self.direction
        if 0 <= idx1 < len(group.slots) and 0 <= idx2 < len(group.slots):
            group.slots.move(idx1, idx2)
            _tag_redraw_all()
        return {'FINISHED'}


class SUBTAB_OT_export_settings(Operator, ExportHelper):
    bl_idname = "screen.subtab_export_settings"
    bl_label = "Export Settings"
    bl_description = "Export all groups and slots to a JSON file"
    bl_options = {'INTERNAL'}

    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={'HIDDEN'})

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            self.report({'ERROR'}, "Add-on preferences are unavailable.")
            return {'CANCELLED'}

        data = serialize_prefs(prefs)
        try:
            with open(self.filepath, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
        except Exception as exc:
            self.report({'ERROR'}, f"Failed to write file: {exc}")
            return {'CANCELLED'}

        self.report({'INFO'}, f"Exported {len(prefs.groups)} group(s).")
        return {'FINISHED'}


class SUBTAB_OT_import_settings(Operator, ImportHelper):
    bl_idname = "screen.subtab_import_settings"
    bl_label = "Import Settings"
    bl_description = "Replace all groups and slots with the contents of a JSON file"
    bl_options = {'INTERNAL'}

    filename_ext = ".json"
    filter_glob: StringProperty(default="*.json", options={'HIDDEN'})

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            self.report({'ERROR'}, "Add-on preferences are unavailable.")
            return {'CANCELLED'}

        try:
            with open(self.filepath, 'r', encoding='utf-8') as f:
                data = json.load(f)
        except Exception as exc:
            self.report({'ERROR'}, f"Failed to read file: {exc}")
            return {'CANCELLED'}

        ok, message = apply_imported_data(prefs, data)
        if not ok:
            self.report({'ERROR'}, message)
            return {'CANCELLED'}

        _tag_redraw_all()
        self.report({'INFO'}, message)
        return {'FINISHED'}


class SUBTAB_OT_reset_defaults(Operator):
    bl_idname = "screen.subtab_reset_defaults"
    bl_label = "Reset to Defaults"
    bl_description = "Remove all groups and restore the default configuration"
    bl_options = {'INTERNAL'}

    def invoke(self, context, event):
        return context.window_manager.invoke_confirm(self, event)

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is None:
            return {'CANCELLED'}

        prefs.groups.clear()
        init_default_groups(prefs)
        prefs.notice = ""
        _tag_redraw_all()
        self.report({'INFO'}, "Reset to default groups.")
        return {'FINISHED'}


class SUBTAB_OT_dismiss_notice(Operator):
    bl_idname = "screen.subtab_dismiss_notice"
    bl_label = "Dismiss Notice"
    bl_options = {'INTERNAL'}

    def execute(self, context):
        prefs = _get_prefs(context)
        if prefs is not None:
            prefs.notice = ""
            _tag_redraw_all()
        return {'FINISHED'}


# --------------------------------------------------------------------------
# UI drawing
# --------------------------------------------------------------------------

def _draw_group_preview(layout, group):
    """Preview using real-looking (but inert) header buttons, honoring mode/align."""
    box = layout.box()
    box.active = group.enabled
    box.label(text="Header preview:")

    # Outer row controls Left/Right placement; inner aligned row holds the buttons.
    outer = box.row()
    outer.alignment = 'RIGHT' if group.alignment == 'RIGHT' else 'LEFT'
    row = outer.row(align=True)
    # Full-brightness buttons that match the real header. They stay inert because
    # they call the no-op operator (clicking does nothing).

    drawn = False
    mode = group.display_mode
    for slot in group.slots:
        if slot.target == NONE_TARGET:
            continue
        _label, _desc, icon = _slot_labels(slot.target)
        if mode == 'TEXT':
            row.operator("screen.subtab_preview_noop", text=_abbrev(slot.target))
        elif mode == 'ICON_TEXT':
            row.operator("screen.subtab_preview_noop",
                         text=_abbrev(slot.target), icon=icon)
        else:  # 'ICON'
            row.operator("screen.subtab_preview_noop", text="", icon=icon)
        drawn = True

    if not drawn:
        row.label(text="(no editors)")


def _draw_save_warning(layout):
    """Loud warning when preference saving is off, so settings won't be lost."""
    reasons = []
    try:
        if not bpy.context.preferences.use_preferences_save:
            reasons.append("'Auto-Save Preferences' (Preferences > Save & Load) is OFF")
    except Exception:
        pass
    try:
        if getattr(bpy.app, "use_userpref_skip_save_on_exit", False):
            reasons.append("Blender is running with preference-saving skipped on exit")
    except Exception:
        pass
    if not reasons:
        return

    box = layout.box()
    box.alert = True
    col = box.column(align=True)
    col.label(text="WARNING: Preferences will NOT be saved automatically.", icon='ERROR')
    col.label(text="This add-on stores its groups and slots in Preferences, so your")
    col.label(text="configuration may be LOST when Blender closes.")
    for reason in reasons:
        col.label(text="\u2022 " + reason)
    col.separator()
    col.label(text="To keep your settings, either enable 'Auto-Save Preferences',")
    col.label(text="or manually use Edit > Preferences > (menu) > Save Preferences.")
    layout.separator()


def draw_groups_ui(layout, prefs):
    if prefs is None:
        layout.label(text="Add-on preferences are unavailable.", icon='ERROR')
        return

    _draw_save_warning(layout)

    if prefs.notice:
        note = layout.box().row(align=True)
        note.label(text=prefs.notice, icon='INFO')
        note.operator("screen.subtab_dismiss_notice", text="", icon='X', emboss=False)

    layout.operator("screen.subtab_group_add", text="Add Group", icon='ADD')

    for g_idx, group in enumerate(prefs.groups):
        box = layout.box()

        # Group header: visibility, name, reorder, remove
        top = box.row(align=True)
        top.prop(
            group, "enabled", text="",
            icon='HIDE_OFF' if group.enabled else 'HIDE_ON',
            emboss=False,
        )
        top.prop(group, "name", text="")

        op_up = top.operator("screen.subtab_group_move", text="", icon='TRIA_UP')
        op_up.index = g_idx
        op_up.direction = -1
        op_down = top.operator("screen.subtab_group_move", text="", icon='TRIA_DOWN')
        op_down.index = g_idx
        op_down.direction = 1
        op_rm = top.operator("screen.subtab_group_remove", text="", icon='X')
        op_rm.index = g_idx

        # Alignment + display mode
        opts = box.row(align=True)
        opts.prop(group, "alignment", text="")
        opts.prop(group, "display_mode", text="")

        # Live preview of how this group's header buttons will look
        _draw_group_preview(box, group)

        # Per-group wheel switching (labeled toggle)
        sw = box.row()
        sw.enabled = prefs.scroll_switch_enabled
        sw.prop(group, "scroll_switch", text="Wheel Switch", icon='MOUSE_MMB', toggle=True)

        # Slots
        if len(group.slots) == 0:
            box.label(text="No slots yet.", icon='INFO')
        else:
            slot_col = box.column(align=True)
            for s_idx, slot in enumerate(group.slots):
                r = slot_col.row(align=True)
                r.prop(slot, "target", text="")

                op_sup = r.operator("screen.subtab_slot_move", text="", icon='TRIA_UP')
                op_sup.group_index = g_idx
                op_sup.slot_index = s_idx
                op_sup.direction = -1

                op_sdown = r.operator("screen.subtab_slot_move", text="", icon='TRIA_DOWN')
                op_sdown.group_index = g_idx
                op_sdown.slot_index = s_idx
                op_sdown.direction = 1

                op_sdel = r.operator("screen.subtab_slot_remove", text="", icon='X')
                op_sdel.group_index = g_idx
                op_sdel.slot_index = s_idx

        op_add = box.operator("screen.subtab_slot_add", text="Add Slot", icon='ADD')
        op_add.group_index = g_idx

    layout.separator()

    sbox = layout.box()
    sbox.prop(prefs, "scroll_switch_enabled")
    krow = sbox.row()
    krow.enabled = prefs.scroll_switch_enabled
    krow.prop(prefs, "scroll_switch_mod")

    trow = sbox.row()
    trow.enabled = prefs.scroll_switch_enabled
    trow.prop(prefs, "scroll_trackpad_step")

    rrow = sbox.row()
    rrow.enabled = prefs.scroll_switch_enabled
    rrow.prop(prefs, "scroll_reverse")

    sbox.label(
        text="Hold the modifier and scroll over an editor to cycle its group.",
        icon='MOUSE_MMB',
    )
    sbox.label(text="Mouse wheel and trackpad two-finger scroll both work.")

    io_row = layout.row(align=True)
    io_row.operator("screen.subtab_export_settings", text="Export", icon='EXPORT')
    io_row.operator("screen.subtab_import_settings", text="Import", icon='IMPORT')
    io_row.operator("screen.subtab_reset_defaults", text="Reset", icon='LOOP_BACK')

    layout.label(text="Too many items may break the header.", icon='INFO')


addon_keymaps = []

def _unregister_keymaps():
    for km, kmi in addon_keymaps:
        try:
            km.keymap_items.remove(kmi)
        except Exception:
            pass
    addon_keymaps.clear()

def _register_keymaps():
    _unregister_keymaps()
    try:
        prefs = _get_prefs()
    except Exception:
        prefs = None
    if prefs is None or not prefs.scroll_switch_enabled:
        return

    wm = bpy.context.window_manager
    if wm is None:
        return
    kc = wm.keyconfigs.addon
    if kc is None:
        return

    ctrl, shift, alt = SCROLL_MOD_FLAGS.get(prefs.scroll_switch_mod, (False, False, True))
    km = kc.keymaps.new(name="Window", space_type='EMPTY')
    for wheel, direction in (("WHEELUPMOUSE", -1), ("WHEELDOWNMOUSE", 1)):
        kmi = km.keymap_items.new(
            "screen.subtab_scroll_switch", type=wheel, value='PRESS',
            ctrl=ctrl, shift=shift, alt=alt,
        )
        kmi.properties.direction = direction
        addon_keymaps.append((km, kmi))

    # Trackpad two-finger scroll (macOS / laptops). Direction comes from the
    # pan delta, so the 'direction' property is left at 0.
    kmi = km.keymap_items.new(
        "screen.subtab_scroll_switch", type='TRACKPADPAN', value='ANY',
        ctrl=ctrl, shift=shift, alt=alt,
    )
    kmi.properties.direction = 0
    addon_keymaps.append((km, kmi))

def _update_keymaps(self, context):
    _register_keymaps()


class EditorSubtabsPrefs(AddonPreferences):
    bl_idname = ADDON_ID

    groups: CollectionProperty(type=EditorSubtabGroup)
    notice: StringProperty(default="", options={'SKIP_SAVE'})

    scroll_switch_enabled: BoolProperty(
        name="Scroll-Switch Under Cursor",
        default=True,
        description=(
            "Hold the chosen key and roll the mouse wheel to cycle the editor "
            "under the cursor through the slots of its group"
        ),
        update=_update_keymaps,
    )
    scroll_switch_mod: EnumProperty(
        name="Modifier",
        items=SCROLL_MOD_ITEMS,
        default="SHIFT_ALT",
        description="Modifier(s) to hold while rolling the wheel",
        update=_update_keymaps,
    )
    scroll_trackpad_step: IntProperty(
        name="Trackpad Step",
        default=80,
        min=20,
        max=600,
        description=(
            "Amount of two-finger scrolling (in pixels) needed per switch on a "
            "trackpad. Higher = less sensitive"
        ),
    )
    scroll_reverse: BoolProperty(
        name="Reverse Scroll Direction",
        default=False,
        description=(
            "Flip the cycling direction for BOTH the mouse wheel and the "
            "trackpad if it feels inverted"
        ),
    )

    def draw(self, context):
        layout = self.layout
        draw_groups_ui(layout, self)


class VIEW3D_PT_subtabs(Panel):
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = 'Subtabs'
    bl_label = 'Editor Subtabs'

    def draw(self, context):
        layout = self.layout
        prefs = _get_prefs(context)
        draw_groups_ui(layout, prefs)


# --------------------------------------------------------------------------
# Header drawing
# --------------------------------------------------------------------------

def _draw_subtabs_core(self, context, align_type):
    try:
        area = context.area
        prefs = _get_prefs(context)
        if area is None or prefs is None:
            return

        group = _group_for_area(prefs, area)
        if group is None or len(group.slots) == 0:
            return

        if group.alignment != align_type:
            return

        mode = group.display_mode

        layout = self.layout
        if align_type == 'RIGHT':
            layout.separator()

        row = layout.row(align=True)

        for slot in group.slots:
            if slot.target == NONE_TARGET:
                continue
            label, desc, icon = _slot_labels(slot.target)
            is_active = (area.ui_type == slot.target)

            if mode == 'TEXT':
                op = row.operator(
                    "screen.subtab_switch",
                    text=_abbrev(slot.target),
                    depress=is_active,
                )
            elif mode == 'ICON_TEXT':
                op = row.operator(
                    "screen.subtab_switch",
                    text=_abbrev(slot.target),
                    icon=icon,
                    depress=is_active,
                )
            else:  # 'ICON'
                op = row.operator(
                    "screen.subtab_switch",
                    text="",
                    icon=icon,
                    depress=is_active,
                )
            op.ui_type = slot.target

        if align_type == 'LEFT':
            layout.separator()

    except Exception as e:
        print(f"Editor Subtabs Draw Error: {e}")

def _draw_subtabs_left(self, context):
    _draw_subtabs_core(self, context, 'LEFT')

def _draw_subtabs_right(self, context):
    _draw_subtabs_core(self, context, 'RIGHT')

class SUBTAB_OT_switch(Operator):
    bl_idname = "screen.subtab_switch"
    bl_label = "Switch Editor Type"
    bl_options = {'INTERNAL'}

    ui_type: StringProperty()

    @classmethod
    def description(cls, context, properties):
        label, _desc, _icon = _slot_labels(properties.ui_type)
        return f"Switch this editor to {label}"

    def execute(self, context):
        area = context.area
        if area is None:
            return {'CANCELLED'}
        try:
            area.ui_type = self.ui_type
        except Exception as exc:
            self.report({'WARNING'}, f"Could not switch: {exc}")
            return {'CANCELLED'}
        return {'FINISHED'}


class SUBTAB_OT_preview_noop(Operator):
    # Used only to render real-looking (but inert) buttons in the settings preview.
    bl_idname = "screen.subtab_preview_noop"
    bl_label = "Preview"
    bl_options = {'INTERNAL'}

    def execute(self, context):
        return {'CANCELLED'}


def _cycle_area(area, group, direction):
    """Switch `area` to the next/previous non-empty slot of `group`."""
    targets = [s.target for s in group.slots if s.target != NONE_TARGET]
    if not targets:
        return False
    current = area.ui_type
    if current in targets:
        new_idx = (targets.index(current) + direction) % len(targets)
    else:
        new_idx = 0
    new_target = targets[new_idx]
    if new_target != current:
        try:
            area.ui_type = new_target
        except Exception:
            return False
        area.tag_redraw()
    return True


class SUBTAB_OT_scroll_switch(Operator):
    bl_idname = "screen.subtab_scroll_switch"
    bl_label = "Scroll-Switch Editor Under Cursor"
    bl_options = {'INTERNAL'}

    # -1 cycles to the previous slot, +1 to the next. Ignored for trackpad,
    # whose direction is derived from the scroll delta.
    direction: IntProperty(default=1)

    def invoke(self, context, event):
        prefs = _get_prefs(context)
        if prefs is None or not prefs.scroll_switch_enabled:
            return {'PASS_THROUGH'}

        # Resolve the area under the mouse from window-space coordinates, with a
        # fallback to the context area.
        area = _area_under_mouse(context.window, event.mouse_x, event.mouse_y)
        if area is None:
            area = context.area
        if area is None:
            return {'PASS_THROUGH'}

        group = _group_for_area(prefs, area)
        if group is None or not group.scroll_switch:
            # Not in an enabled group, or the group opted out: scroll normally.
            return {'PASS_THROUGH'}

        if not any(s.target != NONE_TARGET for s in group.slots):
            return {'PASS_THROUGH'}

        if event.type == 'TRACKPADPAN':
            return self._handle_trackpad(prefs, event, area, group)

        # Mouse wheel: one step in the keymap-provided direction.
        direction = self.direction
        if prefs.scroll_reverse:
            direction = -direction
        _cycle_area(area, group, direction)
        return {'FINISHED'}

    def _handle_trackpad(self, prefs, event, area, group):
        """Accumulate the pan delta and switch once per threshold of movement."""
        global _tp_accum, _tp_last_time
        now = time.monotonic()
        # Reset between separate gestures so momentum from one doesn't leak.
        if now - _tp_last_time > 0.3:
            _tp_accum = 0.0
        _tp_last_time = now

        _tp_accum += (event.mouse_y - event.mouse_prev_y)
        step = max(20, prefs.scroll_trackpad_step)

        while abs(_tp_accum) >= step:
            if _tp_accum > 0:
                _tp_accum -= step
                direction = 1
            else:
                _tp_accum += step
                direction = -1
            if prefs.scroll_reverse:
                direction = -direction
            _cycle_area(area, group, direction)

        # Consume the event so the view does not also pan while switching.
        return {'FINISHED'}


# --------------------------------------------------------------------------
# Default initialization
# --------------------------------------------------------------------------

def init_default_groups(prefs):
    """Safely initialize default groups when the addon is first enabled."""
    global _is_updating
    _is_updating = True
    try:
        def add_slot(group, target):
            s = group.slots.add()
            s.target = target
            s.prev_target = target

        g1 = prefs.groups.add()
        g1.name = "Group 1"
        add_slot(g1, "TIMELINE")
        add_slot(g1, "ShaderNodeTree")
        add_slot(g1, "GeometryNodeTree")
        add_slot(g1, "CompositorNodeTree")
        add_slot(g1, "FILES")

        g2 = prefs.groups.add()
        g2.name = "Group 2"
        g2.alignment = "LEFT"
        add_slot(g2, "VIEW_3D")
        add_slot(g2, "TEXT_EDITOR")
        add_slot(g2, "PREFERENCES")
    finally:
        _is_updating = False


# --------------------------------------------------------------------------
# Registration
# --------------------------------------------------------------------------

classes = (
    EditorSubtabSlot,
    EditorSubtabGroup,
    SUBTAB_OT_group_add,
    SUBTAB_OT_group_remove,
    SUBTAB_OT_group_move,
    SUBTAB_OT_slot_add,
    SUBTAB_OT_slot_remove,
    SUBTAB_OT_slot_move,
    SUBTAB_OT_export_settings,
    SUBTAB_OT_import_settings,
    SUBTAB_OT_reset_defaults,
    SUBTAB_OT_dismiss_notice,
    SUBTAB_OT_switch,
    SUBTAB_OT_preview_noop,
    SUBTAB_OT_scroll_switch,
    EditorSubtabsPrefs,
    VIEW3D_PT_subtabs,
)

def _add_to_headers():
    for name in HEADER_CLASSES:
        cls = getattr(bpy.types, name, None)
        if cls is None:
            continue
        # Remove first (idempotent) so re-running never appends duplicates,
        # without inspecting Blender's internal _draw_funcs list.
        for func in (_draw_subtabs_left, _draw_subtabs_right):
            try:
                cls.remove(func)
            except Exception:
                pass
        cls.prepend(_draw_subtabs_left)
        cls.append(_draw_subtabs_right)

def _remove_from_headers():
    for name in HEADER_CLASSES:
        cls = getattr(bpy.types, name, None)
        if cls is not None:
            try:
                cls.remove(_draw_subtabs_right)
            except Exception:
                pass
            try:
                cls.remove(_draw_subtabs_left)
            except Exception:
                pass

def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    try:
        prefs = _get_prefs()
        if prefs is not None:
            prefs.notice = ""
            if len(prefs.groups) == 0:
                init_default_groups(prefs)
    except Exception:
        pass

    _add_to_headers()
    _register_keymaps()
    _tag_redraw_all()

def unregister():
    _unregister_keymaps()
    _remove_from_headers()
    for cls in reversed(classes):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass
    _tag_redraw_all()

if __name__ == "__main__":
    register()
