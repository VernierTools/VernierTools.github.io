bl_info = {
    "name": "Material-less Object Counter",
    "author": "Mikat",
    "version": (1, 1, 0),
    "blender": (4, 2, 0),
    "location": "Editor Headers (3D View / Shader / Outliner / Properties) and View3D > Sidebar (N) > No Material",
    "description": "Counts objects without materials (no slots or only empty slots), "
                   "lists them for quick selection, with type filters, hidden/faceless "
                   "toggles, select-all and zoom-to-object. The header button can be "
                   "shown in several editors.",
    "category": "3D View",
}

import bpy
from bpy.app.handlers import persistent
from bpy.props import StringProperty, BoolProperty, EnumProperty, PointerProperty
from mathutils import Vector

# ----------------------------------------------------------------------------
# ビューレイヤーごとに「未割り当てオブジェクトの一覧」をキャッシュする。
# 値は (name, type, status) タプルのリスト（カウントは len で得る）。
#
# 設計上の要点：全オブジェクト走査と to_mesh() による面判定は「重い処理」なので、
# UI 描画関数の中では絶対に行わない。集計はデバウンスしたタイマー（_do_recount →
# _recompute_visible）内でのみ実行してここへ格納し、ヘッダー／パネルの draw は
# このキャッシュを読むだけ（Read-only）にする。これにより、マウス移動などで
# 高頻度に走る再描画中に重い評価が走ってフリーズする問題を避ける。
#
# キーは _vl_key()＝(scene.session_uid, view_layer.name)。ViewLayer は ID 型では
# ないため session_uid を持たない。一方 as_pointer() は削除→再確保でアドレスが
# 使い回され、無関係な別データのキャッシュを誤って引く危険がある。そこで ID で
# ある Scene の session_uid（リネーム・再確保をまたいで不変）とビューレイヤー名を
# 組み合わせた安定キーを用いる。
_result_cache = {}

# オブジェクトの「面あり/なし」判定結果のキャッシュ。キー = obj.session_uid
# （ID 型なので有効。as_pointer と違い削除→再確保での誤ヒットが無い）。
# 面の有無はジオメトリで決まり、フィルター設定には依存しないため、設定トグルでは
# 破棄せず、ジオメトリが変わりうる depsgraph 更新時（_on_depsgraph_update）と
# ファイル読み込み時にのみ破棄する。これにより Include Faceless の切り替えは
# 再計算ゼロ（キャッシュ命中）で即反映される。
_faces_cache = {}

# 設定が未登録(テキストエディタ実行直後など)のときに使うデフォルト対象タイプ。
_DEFAULT_TYPES = {'MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'VOLUME'}

# リスト表示用：オブジェクトタイプ → アイコン。
_TYPE_ICONS = {
    'MESH': 'OUTLINER_OB_MESH',
    'CURVE': 'OUTLINER_OB_CURVE',
    'SURFACE': 'OUTLINER_OB_SURFACE',
    'META': 'OUTLINER_OB_META',
    'FONT': 'OUTLINER_OB_FONT',
    'VOLUME': 'OUTLINER_OB_VOLUME',
}

# フィルター用：(オブジェクトタイプ, 設定プロパティ名, アイコン)。
_TYPE_PROPS = (
    ('MESH', 'use_mesh', 'OUTLINER_OB_MESH'),
    ('CURVE', 'use_curve', 'OUTLINER_OB_CURVE'),
    ('SURFACE', 'use_surface', 'OUTLINER_OB_SURFACE'),
    ('META', 'use_meta', 'OUTLINER_OB_META'),
    ('FONT', 'use_font', 'OUTLINER_OB_FONT'),
    ('VOLUME', 'use_volume', 'OUTLINER_OB_VOLUME'),
)


def _enabled_types(settings):
    """チェックが入っているオブジェクトタイプの集合を返す。"""
    return {t for (t, attr, _icon) in _TYPE_PROPS if getattr(settings, attr)}


# ----------------------------------------------------------------------------
# ヘッダーボタンを表示できるエディター定義。
# 各エントリ: (設定プロパティ名, ヘッダー型名, エリアタイプ, ポップオーバー idname,
#              表示可否を絞る述語 or None)
# 述語は context.space_data を受け取り、表示してよいとき True を返す。
# ----------------------------------------------------------------------------
def _is_shader_space(space):
    # ノードエディターは Shader/Geometry/Compositor 等で共有のため、
    # シェーダーツリーのときだけ表示する。
    return getattr(space, "tree_type", None) == 'ShaderNodeTree'


_EDITORS = (
    ("show_in_view3d",     "VIEW3D_HT_header",     'VIEW_3D',
     "VIEW3D_PT_no_material_popover",     None),
    ("show_in_shader",     "NODE_HT_header",       'NODE_EDITOR',
     "NODE_PT_no_material_popover",       _is_shader_space),
    ("show_in_outliner",   "OUTLINER_HT_header",   'OUTLINER',
     "OUTLINER_PT_no_material_popover",   None),
    ("show_in_properties", "PROPERTIES_HT_header", 'PROPERTIES',
     "PROPERTIES_PT_no_material_popover", None),
)

# area.type → ポップオーバー idname / 述語 の逆引き。
_POPOVER_BY_AREA = {atype: pid for (_a, _h, atype, pid, _p) in _EDITORS}
_PREDICATE_BY_AREA = {atype: pred for (_a, _h, atype, _pid, pred) in _EDITORS}
# 再描画対象のエリアタイプ集合。
_REDRAW_AREA_TYPES = {atype for (_a, _h, atype, _pid, _pred) in _EDITORS}
# デフォルトで表示するエディター（prefs 未取得時のフォールバック）。
_DEFAULT_EDITOR_ATTR = "show_in_view3d"


# ----------------------------------------------------------------------------
# 判定ロジック
# ----------------------------------------------------------------------------
def _object_status(obj):
    """オブジェクトのマテリアル状態を返す。

    戻り値:
      None        … マテリアルを持てない型 / 既に割り当て済み（=カウント対象外）
      'NO_SLOT'   … マテリアルスロットが 1 つも無い
      'EMPTY_SLOT'… スロットはあるが全て空（中身が None）
    """
    data = getattr(obj, "data", None)
    if data is None or not hasattr(data, "materials"):
        return None
    slots = obj.material_slots
    if not slots:
        return 'NO_SLOT'
    if all(slot.material is None for slot in slots):
        return 'EMPTY_SLOT'
    return None


def _get_depsgraph(context=None):
    """評価済みデプスグラフを取得（取れなければ None）。
    描画/オペレーター実行中は安全に取得できる。ハンドラ内からは呼ばない。"""
    ctx = context or bpy.context
    try:
        return ctx.evaluated_depsgraph_get()
    except Exception:
        return None


def _curve_face_status(obj):
    """カーブ/サーフェス/テキストが面を持つかを、to_mesh を使わず安価に推定する。

    戻り値: True=面あり確定 / False=面なし確定 / None=判定不能（to_mesh が必要）。

    プレーンなカーブ（ベベル・押し出し・2Dフィルなし）は面を生成しないので、
    ここで即 False を返して重い to_mesh を回避する。ビューポートに効くモディファイア
    があると面が増減しうるので None（to_mesh に委譲）にする。"""
    data = getattr(obj, "data", None)
    if data is None:
        return False

    # ビューポートで有効なモディファイアがあると面が増減しうる → 確定できない。
    mods = getattr(obj, "modifiers", None)
    if mods and any(getattr(m, "show_viewport", False) for m in mods):
        return None

    # SURFACE / FONT はここでは確定させず to_mesh に委ねる（本数が少ないため）。
    if obj.type != 'CURVE':
        return None

    # 押し出し（側壁ができる）
    if getattr(data, "extrude", 0.0) > 0.0:
        return True

    # ベベル（丸/プロファイルは深さ、オブジェクトモードはベベルオブジェクト）
    bevel_mode = getattr(data, "bevel_mode", 'ROUND')
    if bevel_mode == 'OBJECT':
        if getattr(data, "bevel_object", None) is not None:
            return True
    else:  # 'ROUND' / 'PROFILE'
        if getattr(data, "bevel_depth", 0.0) > 0.0:
            return True

    # 2D かつフィルあり かつ 閉じた（cyclic）スプラインがある → フタ面ができる。
    # （3D カーブはベベル/押し出しが無ければフィル設定だけでは面にならない。）
    if getattr(data, "dimensions", '3D') == '2D' and \
       getattr(data, "fill_mode", 'NONE') != 'NONE':
        splines = getattr(data, "splines", None)
        if splines:
            for sp in splines:
                if getattr(sp, "use_cyclic_u", False):
                    return True
        return False

    # いずれも無ければ面は生成されない（NurbsPath 等のプレーンなカーブ）。
    return False


def _has_faces(obj, depsgraph=None):
    """オブジェクトが面（ポリゴン）を持つか（結果を obj.session_uid でキャッシュ）。

    面の有無はジオメトリのみで決まりフィルター設定に依存しないため、キャッシュは
    depsgraph 更新（ジオメトリ変化）とファイル読み込みでのみ破棄する。これにより
    Include Faceless のトグルは再計算ゼロで即反映される。"""
    try:
        key = obj.session_uid
    except Exception:
        key = None
    if key is not None:
        cached = _faces_cache.get(key)
        if cached is not None:        # False も有効値なので None(=未計算)と区別
            return cached
    result = _compute_has_faces(obj, depsgraph)
    if key is not None:
        _faces_cache[key] = result
    return result


def _compute_has_faces(obj, depsgraph=None):
    """面（ポリゴン）の有無を実際に計算する（_has_faces のキャッシュ本体）。

    メッシュは評価後（モディファイア適用後）のポリゴン数で判定する。これにより、
    ベースが頂点だけでも Skin / Screw / Build などで面が生成されるオブジェクトは
    正しく「面あり」と判定され、カウント対象になる。

    カーブ系はまず to_mesh を使わない安価判定（_curve_face_status）で確定を試み、
    判定不能なものだけ to_mesh() で実体化して確かめる。評価後も data は Curve の
    ままで polygons を持たないため、ベベル/押し出し/2Dフィルで面が生成されるかを
    知るには（安価判定で決まらなければ）to_mesh が必要になる。

    メタボール/ボリューム等は常に面（または実体）を持つため True 扱い。
    （メタボールの非basis要素は to_mesh() で空になり誤判定するので、ここでは
    判定に含めない。）
    """
    data = getattr(obj, "data", None)

    # --- メッシュ：polygons を直接読む（最速パス） ---
    if getattr(data, "polygons", None) is not None:
        if depsgraph is not None:
            try:
                eval_obj = obj.evaluated_get(depsgraph)
                eval_polys = getattr(getattr(eval_obj, "data", None), "polygons", None)
                if eval_polys is not None:
                    return len(eval_polys) > 0
            except Exception:
                pass
        # デプスグラフが取れない場合のフォールバック：評価前データの面数。
        return len(data.polygons) > 0

    # --- カーブ系：まず安価判定、ダメなら to_mesh ---
    if obj.type in {'CURVE', 'SURFACE', 'FONT'}:
        quick = _curve_face_status(obj)
        if quick is not None:
            return quick  # to_mesh 不要（プレーンなカーブ等はここで即決）
        if depsgraph is None:
            return True  # 評価できないときは安全側（面あり）に倒す
        eval_obj = obj.evaluated_get(depsgraph)
        try:
            # 評価後オブジェクトに対する to_mesh() は、その時点でモディファイアも
            # カーブのベベル/押し出し/フィルも適用済みの結果を返す。depsgraph 引数は
            # preserve_all_data_layers=True（頂点グループ等の保持）専用で、面数を
            # 数えるだけの用途では不要。むしろ True 指定は既知の副作用（変換が
            # 二重適用される）を招くため、既定の False のまま引数なしで呼ぶのが安全。
            mesh = eval_obj.to_mesh()
            return mesh is not None and len(mesh.polygons) > 0
        except Exception:
            # to_mesh() が使えない/失敗した場合は面ありとして扱う。
            return True
        finally:
            # to_mesh() の一時メッシュは必ず解放する。
            try:
                eval_obj.to_mesh_clear()
            except Exception:
                pass

    # --- メタボール/ボリューム等：面ありとして扱う ---
    return True


def iter_no_material_objects(view_layer, settings=None, depsgraph=None):
    """設定（タイプフィルター・非表示・面なしの扱い）を反映して、指定ビューレイヤー内の
    未割り当てオブジェクトを (obj, status) のタプルで返すジェネレータ。

    走査対象を view_layer.objects にすることで、可視判定 visible_get() の基準
    （＝そのビューレイヤー）と母集団が一致する。scene.objects を使うと、ビューレイヤーから
    除外されたコレクションのオブジェクトまで母集団に入り、マルチビューレイヤー環境で
    カウントが直感とズレる原因になっていた。"""
    if settings is not None:
        types = _enabled_types(settings)
        include_hidden = settings.include_hidden
        include_faceless = settings.include_faceless
    else:
        types = set(_DEFAULT_TYPES)
        include_hidden = False
        include_faceless = False

    # 面の有無を評価後で見るためのデプスグラフ（1 回だけ取得）。
    # 面なしを含める設定なら面判定自体が不要なので取得を省く。
    if not include_faceless and depsgraph is None:
        depsgraph = _get_depsgraph()

    for obj in view_layer.objects:
        if obj.type not in types:
            continue
        if not include_hidden:
            try:
                if not obj.visible_get(view_layer=view_layer):
                    continue
            except Exception:
                continue
        # デフォルトでは面の無いオブジェクト（空メッシュ等）は数えない。
        # ただしモディファイアで面が生成されるものは「面あり」として拾う。
        if not include_faceless and not _has_faces(obj, depsgraph):
            continue
        status = _object_status(obj)
        if status is not None:
            yield obj, status


# ----------------------------------------------------------------------------
# キャッシュ / 集計 / 再描画 / デバウンス
# ----------------------------------------------------------------------------
# 集計（重い処理）はここに集約する。UI 描画は _get_results()/_get_count() で
# キャッシュを読むだけにし、未計算なら _request_recount() を投げて仮表示に留める。
# 実際の走査・to_mesh 評価はデバウンスした _do_recount()（タイマー）内で行う。

_RECOUNT_DEBOUNCE = 0.2  # 秒。高頻度な depsgraph 更新を間引く間隔。

# 保留中タイマーの登録簿（unregister 時に確実に掃除するため。指摘2）。
_pending_timers = set()
_recount_armed = False
# depsgraph_update_post ハンドラの実行中だけ True。ハンドラ内では to_mesh() 等の
# 重い評価を同期実行してはいけない（再帰評価・クラッシュを招く）ため、フォールバック
# 経路での同期集計をこのフラグで抑止する。
_in_depsgraph_handler = False


def _timers_register(func, first_interval):
    _pending_timers.add(func)
    try:
        bpy.app.timers.register(func, first_interval=first_interval)
    except Exception:
        _pending_timers.discard(func)
        raise


def _timers_done(func):
    _pending_timers.discard(func)


def _timers_clear():
    """保留中の全タイマーを解除（アドオン無効化時の掃除）。"""
    global _recount_armed
    for func in list(_pending_timers):
        try:
            if bpy.app.timers.is_registered(func):
                bpy.app.timers.unregister(func)
        except Exception:
            pass
    _pending_timers.clear()
    _recount_armed = False


def _vl_key(scene, view_layer):
    """結果キャッシュのキー。ViewLayer は ID ではなく session_uid を持たないため、
    ID である Scene の session_uid（リネーム・再確保をまたいで不変）とビューレイヤー名
    を組み合わせて安定キーにする（as_pointer のポインタ再利用による誤ヒットを回避）。"""
    scene_uid = getattr(scene, "session_uid", 0) if scene is not None else 0
    return (scene_uid, view_layer.name)


def _scan_results(scene, view_layer, depsgraph):
    """1 ビューレイヤーを走査し、(name, type, status) タプルのリストを返す。
    ここが重い処理（全走査＋面判定の to_mesh）。必ずタイマー/オペレーター内から呼ぶ。
    ライブなオブジェクト参照ではなく文字列タプルで保持するので、後でオブジェクトが
    削除されてもキャッシュが不正参照にならない。"""
    settings = getattr(scene, "no_material_settings", None) if scene else None
    return [(obj.name, obj.type, status)
            for obj, status in iter_no_material_objects(view_layer, settings, depsgraph)]


def _recompute_visible():
    """現在ウィンドウに表示中の各 (scene, view_layer) について結果を計算し、
    _result_cache を更新する。重い評価はこの関数の中（タイマー文脈）だけで行う。"""
    wm = getattr(bpy.context, "window_manager", None)
    windows = list(wm.windows) if wm else []
    if not windows:
        # ウィンドウが取れない場合はアクティブコンテキストのみ集計。
        scene = getattr(bpy.context, "scene", None)
        vl = getattr(bpy.context, "view_layer", None)
        if vl is not None:
            try:
                _result_cache[_vl_key(scene, vl)] = _scan_results(scene, vl, _get_depsgraph())
            except Exception:
                pass
        return
    seen = set()
    for window in windows:
        scene = getattr(window, "scene", None)
        vl = getattr(window, "view_layer", None)
        if vl is None:
            continue
        key = _vl_key(scene, vl)
        if key in seen:
            continue
        seen.add(key)
        try:
            # ウィンドウごとに正しい評価済みデプスグラフを使う。
            with bpy.context.temp_override(window=window):
                dg = _get_depsgraph()
                _result_cache[key] = _scan_results(scene, vl, dg)
        except Exception:
            # temp_override が使えない場合はアクティブなデプスグラフで代替。
            try:
                _result_cache[key] = _scan_results(scene, vl, _get_depsgraph())
            except Exception:
                pass


def _get_results(scene, view_layer):
    """集計済みの一覧を返す。未計算なら再集計を要求して None を返す
    （描画側は重い評価を行わず、仮表示にする）。"""
    if view_layer is None:
        return []
    items = _result_cache.get(_vl_key(scene, view_layer))
    if items is None:
        _request_recount()
        return None
    return items


def _get_count(scene, view_layer):
    """集計済みならカウント、未計算なら None（＝集計中）を返す。"""
    items = _get_results(scene, view_layer)
    return None if items is None else len(items)


def _do_recount():
    """デバウンス発火：表示中ビューレイヤーを集計してキャッシュへ格納し、再描画。"""
    global _recount_armed
    _recount_armed = False
    _timers_done(_do_recount)
    _recompute_visible()
    _tag_redraw()
    return None  # 一度きり


def _request_recount():
    """高頻度な更新を 1 回の再集計へ束ねる（先頭で 1 度だけタイマーを張る）。"""
    global _recount_armed
    if _recount_armed:
        return
    _recount_armed = True
    try:
        _timers_register(_do_recount, _RECOUNT_DEBOUNCE)
    except Exception:
        # タイマーが使えない場合は即時フォールバックで集計。ただし depsgraph ハンドラ
        # 内では重い評価を同期実行しない（再帰評価・クラッシュ回避）。
        _recount_armed = False
        if not _in_depsgraph_handler:
            try:
                _recompute_visible()
            except Exception:
                pass
        _tag_redraw()


def _tag_redraw():
    """カウント更新後、ボタンを表示しうる全エディターのヘッダー/パネルを再描画指示。"""
    try:
        wm = bpy.context.window_manager
    except Exception:
        wm = None
    if not wm:
        return
    for window in wm.windows:
        screen = getattr(window, "screen", None)
        if not screen:
            continue
        for area in screen.areas:
            if area.type in _REDRAW_AREA_TYPES:
                area.tag_redraw()


@persistent
def _on_depsgraph_update(scene, depsgraph):
    # ハンドラ内ではフルスキャンしない。デバウンスして再計算を間引くことで、
    # 重いシーンでオブジェクトをドラッグ中の「再描画ごとのフル走査」を避ける（指摘1）。
    global _in_depsgraph_handler
    screen = getattr(bpy.context, "screen", None)
    if screen and screen.is_animation_playing:
        # アニメーション再生中はそもそも更新しない（再生をカクつかせない）。
        return
    # ジオメトリが変わった可能性があるので面判定キャッシュを破棄する。
    # （設定トグルは depsgraph 更新を起こさないためここを通らず、キャッシュは残る＝
    #   Include Faceless の切り替えは再計算ゼロで即反映される。）
    _faces_cache.clear()
    _in_depsgraph_handler = True
    try:
        _request_recount()
    finally:
        _in_depsgraph_handler = False


@persistent
def _on_load(*args):
    # ファイルを開いたらキャッシュを破棄（次回参照時に再集計される）。
    _result_cache.clear()
    _faces_cache.clear()


# ----------------------------------------------------------------------------
# 共通ユーティリティ
# ----------------------------------------------------------------------------
def get_settings(context):
    return getattr(context.scene, "no_material_settings", None)


def get_prefs():
    addon = bpy.context.preferences.addons.get(__name__)
    return addon.preferences if addon else None


def _selection_center(context):
    """選択オブジェクトの「評価後（モディファイア適用後）バウンディングボックス」の
    ワールド中心を返す。表示されている形状の中心と一致するので、これをオービット
    中心に据えると回転軸がぴったり中心になる。選択が無ければ None。"""
    deps = _get_depsgraph(context)
    coords = []
    for obj in context.view_layer.objects:
        if not obj.select_get():
            continue
        try:
            ob = obj.evaluated_get(deps) if deps else obj
            mw = obj.matrix_world
            bb = getattr(ob, "bound_box", None)
            if bb:
                for corner in bb:
                    coords.append(mw @ Vector(corner[:]))
            else:
                coords.append(mw.translation.copy())
        except Exception:
            try:
                coords.append(obj.matrix_world.translation.copy())
            except Exception:
                pass
    if not coords:
        return None
    xs = [c.x for c in coords]
    ys = [c.y for c in coords]
    zs = [c.z for c in coords]
    return Vector(((min(xs) + max(xs)) * 0.5,
                   (min(ys) + max(ys)) * 0.5,
                   (min(zs) + max(zs)) * 0.5))


def _schedule_pivot_snap(context, rv3d, center):
    """スムーズビュー完了後に、オービット中心(view_location)を厳密な中心へ補正する。
    補正量はごく僅か（着地誤差ぶん）なので見た目のジャンプは起きないが、これで
    回転軸が確実に中心へ揃う。"""
    try:
        ms = context.preferences.view.smooth_view  # スムーズビュー時間(ms)
    except Exception:
        ms = 200
    delay = (ms / 1000.0) + 0.02 if ms else 0.0
    target = center.copy()

    def _cb():
        _timers_done(_cb)
        try:
            rv3d.view_location = target
        except Exception:
            return None  # rv3d が無効化されていたら何もしない
        _tag_redraw()
        return None  # 一度きり

    try:
        _timers_register(_cb, delay)
    except Exception:
        # タイマーが使えない環境では即時セット（スムーズ補正は無いが中心は合う）。
        try:
            rv3d.view_location = center
        except Exception:
            pass


def _zoom_to_selected(context):
    """選択中オブジェクトにビューポートをスムーズにズームし、回転軸を厳密に中心化する。

    'INVOKE_DEFAULT' でテンキー「.」と同じスムーズビューにし、アニメーション完了後に
    オービット中心を選択範囲の正確な中心へ補正する（view_selected 単独だと最終的な
    オービット中心が厳密に中心へ着地しきらず、回転すると軸がわずかにズレるため）。"""
    center = _selection_center(context)
    for area in context.screen.areas:
        if area.type != 'VIEW_3D':
            continue
        region = next((r for r in area.regions if r.type == 'WINDOW'), None)
        if region is None:
            continue
        space = area.spaces.active
        rv3d = getattr(space, "region_3d", None)
        try:
            with context.temp_override(area=area, region=region,
                                       space_data=space, region_data=rv3d):
                bpy.ops.view3d.view_selected('INVOKE_DEFAULT')
        except Exception:
            pass
        if rv3d is not None and center is not None:
            _schedule_pivot_snap(context, rv3d, center)
        return True
    return False


def _deselect_all(context):
    """モード依存の例外を避けつつ全選択解除。失敗したら False。

    bpy.ops.object.select_all はオブジェクトモード＋適切なコンテキストを要求し、
    編集/ポーズモードでは poll に失敗するため使わない。代わりにフラグを直接落とす。
    走査対象は「現在選択中のオブジェクトのみ」に絞ることで、数万オブジェクトの
    シーンでも全走査せず軽く済む（selected_objects が取れない場合のみ全走査に退避）。"""
    try:
        selected = context.selected_objects
    except Exception:
        selected = None
    try:
        targets = selected if selected is not None else context.view_layer.objects
        for o in targets:
            o.select_set(False)
        return True
    except Exception:
        return False


# ----------------------------------------------------------------------------
# UI 描画パーツ（サイドパネルとヘッダーのポップオーバーで共有）
# ----------------------------------------------------------------------------
def _draw_status(layout, count):
    """大きめのステータス表示。未設定があれば赤い警告、全て設定済みなら
    チェックマーク（Blender のレイアウトは alert による赤しか持たないため、
    "全て設定済み" 側は緑ではなく中立色のチェックマークになる）。"""
    box = layout.box()
    row = box.row(align=True)
    label = row.row(align=True)
    if count > 0:
        label.alert = True
        label.label(text="%d without material" % count, icon='ERROR')
    else:
        label.label(text="All objects have materials", icon='CHECKMARK')
    row.operator("view3d.nomat_refresh", text="", icon='FILE_REFRESH')


def _draw_actions(layout, has_items):
    """まとめ操作のボタン列（全選択・寄せて全選択）。"""
    if not has_items:
        return
    row = layout.row(align=True)
    op = row.operator("object.nomat_select_all", text="Select All", icon='RESTRICT_SELECT_OFF')
    op.zoom = False
    op = row.operator("object.nomat_select_all", text="", icon='ZOOM_SELECTED')
    op.zoom = True


def _draw_type_filter(layout, settings):
    """オブジェクトタイプのトグル群（2 列グリッド）＋ 非表示の扱い。"""
    grid = layout.grid_flow(row_major=True, columns=2, even_columns=True, align=True)
    for (_t, attr, icon) in _TYPE_PROPS:
        grid.prop(settings, attr, icon=icon)
    layout.prop(settings, "include_hidden",
                icon='HIDE_OFF' if settings.include_hidden else 'HIDE_ON')
    layout.prop(settings, "include_faceless",
                icon='FACESEL' if settings.include_faceless else 'MESH_DATA')


def _draw_object_list(layout, items):
    """未割り当てオブジェクトの一覧。各行＝[状態][名前(選択)][ズーム]。
    items は (name, type, status) タプルのリスト（キャッシュ済みの結果）。"""
    col = layout.column(align=True)
    for name, otype, status in items:
        row = col.row(align=True)

        # 状態アイコン：NO_SLOT=スロット無し / EMPTY_SLOT=空スロットあり。
        status_icon = 'MATERIAL' if status == 'EMPTY_SLOT' else 'X'
        row.label(text="", icon=status_icon)

        type_icon = _TYPE_ICONS.get(otype, 'OBJECT_DATA')
        sel = row.operator("object.nomat_select", text=name, icon=type_icon)
        sel.obj_name = name
        sel.zoom = False

        zoom = row.operator("object.nomat_select", text="", icon='ZOOM_SELECTED')
        zoom.obj_name = name
        zoom.zoom = True


def draw_no_material_ui(layout, context):
    """サイドパネルとヘッダーのポップオーバーで共有するメイン UI。

    レイアウト順は意図的に [ステータス][操作][フィルター][リスト]。
    フィルターをリストより上に固定配置することで、タイプを切り替えても
    チェックボックスの位置が動かず、素早い連続クリックが取りこぼされない。
    """
    settings = get_settings(context)
    if settings is None:
        layout.label(text="Add-on is not fully initialized.", icon='ERROR')
        return

    # 描画内では走査・to_mesh 評価を行わず、集計済みキャッシュを読むだけにする。
    # 未計算なら _get_results が再集計を要求するので、少し待てば自動で再描画される。
    items = _get_results(context.scene, context.view_layer)
    if items is None:
        layout.label(text="Counting…", icon='TIME')
        return

    _draw_status(layout, len(items))
    _draw_actions(layout, bool(items))

    # --- フィルター（折りたたみ式・リストより上に固定） ---
    header = layout.row(align=True)
    header.prop(settings, "show_filter",
                icon='TRIA_DOWN' if settings.show_filter else 'TRIA_RIGHT',
                text="Filters", emboss=False)
    if settings.show_filter:
        _draw_type_filter(layout.box(), settings)

    # --- 一覧 ---
    if items:
        layout.separator()
        _draw_object_list(layout, items)


# ----------------------------------------------------------------------------
# オペレーター
# ----------------------------------------------------------------------------
class OBJECT_OT_nomat_select(bpy.types.Operator):
    bl_idname = "object.nomat_select"
    bl_label = "Select Object Without Material"
    bl_description = "Select this object (and zoom the viewport to it when requested)"
    bl_options = {'REGISTER', 'UNDO'}

    obj_name: StringProperty(name="Object Name")
    zoom: BoolProperty(name="Zoom To Object", default=False)

    def execute(self, context):
        obj = bpy.data.objects.get(self.obj_name)
        if obj is None:
            self.report({'WARNING'}, "Object '%s' not found" % self.obj_name)
            return {'CANCELLED'}

        # 非表示オブジェクトはビューポートで選択状態にできない（select_set が定着
        # しない）。include_hidden で一覧に出たものをクリックした場合に「押しても
        # 何も起きない」無反応にならないよう、事前に把握して後で理由を通知する。
        hidden = not obj.visible_get()

        # bpy.ops を使わず手動で解除することでモード依存のコンテキストエラーを回避。
        if not _deselect_all(context):
            self.report({'WARNING'}, "Cannot change selection in the current mode")
            return {'CANCELLED'}

        try:
            obj.select_set(True)
            context.view_layer.objects.active = obj
        except Exception:
            self.report({'WARNING'}, "Object '%s' is not selectable" % self.obj_name)
            return {'CANCELLED'}

        if hidden:
            # 可視状態は変えず、アクティブだけ設定したうえで理由を明示する。
            self.report({'WARNING'},
                        "'%s' is hidden; set as active but can't be selected in the "
                        "viewport (visibility left unchanged)" % self.obj_name)

        if self.zoom:
            # 表示 / 非表示の状態は変更せず、ビューだけ寄せる。
            _zoom_to_selected(context)
        return {'FINISHED'}


class OBJECT_OT_nomat_select_all(bpy.types.Operator):
    bl_idname = "object.nomat_select_all"
    bl_label = "Select All Unassigned"
    bl_description = "Select every listed object without a material"
    bl_options = {'REGISTER', 'UNDO'}

    zoom: BoolProperty(name="Zoom To Objects", default=False)

    def execute(self, context):
        settings = get_settings(context)
        items = list(iter_no_material_objects(context.view_layer, settings,
                                              _get_depsgraph(context)))
        if not items:
            self.report({'INFO'}, "No objects without materials")
            return {'CANCELLED'}

        if not _deselect_all(context):
            self.report({'WARNING'}, "Cannot change selection in the current mode")
            return {'CANCELLED'}

        active = None
        for obj, _status in items:
            try:
                obj.select_set(True)
                active = obj
            except Exception:
                pass

        if active is not None:
            context.view_layer.objects.active = active

        if self.zoom:
            _zoom_to_selected(context)

        self.report({'INFO'}, "Selected %d object(s)" % len(items))
        return {'FINISHED'}


class VIEW3D_OT_nomat_refresh(bpy.types.Operator):
    bl_idname = "view3d.nomat_refresh"
    bl_label = "Refresh"
    bl_description = "Recount objects without materials"

    def execute(self, context):
        # 手動更新：結果・面判定とも作り直す（集計はオペレーター文脈なので同期実行してよい）。
        _faces_cache.clear()
        _result_cache.clear()
        _recompute_visible()
        _tag_redraw()
        return {'FINISHED'}


# ----------------------------------------------------------------------------
# N パネル（サイドバー）
# ----------------------------------------------------------------------------
class VIEW3D_PT_no_material(bpy.types.Panel):
    bl_label = "No Material"
    bl_idname = "VIEW3D_PT_no_material"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "No Material"

    def draw(self, context):
        draw_no_material_ui(self.layout, context)


class VIEW3D_PT_no_material_settings(bpy.types.Panel):
    bl_label = "Header Button"
    bl_idname = "VIEW3D_PT_no_material_settings"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "No Material"
    bl_parent_id = "VIEW3D_PT_no_material"
    # デフォルトで展開しておく（DEFAULT_CLOSED を付けない）。

    def draw(self, context):
        layout = self.layout
        prefs = get_prefs()
        if prefs is None:
            # テキストエディタから直接実行した場合などはアドオン設定にアクセスできない。
            layout.label(text="Install as an add-on to change this.", icon='INFO')
            return
        _draw_header_settings(layout, prefs)


# ----------------------------------------------------------------------------
# ヘッダー用ポップオーバー
# ----------------------------------------------------------------------------
# bl_region_type='HEADER' のパネルはサイドバーに表示されず、
# layout.popover() から呼んだときだけヘッダーボタンの直下に固定表示される。
# （Blender 標準のスナップ設定ポップオーバーと同じ仕組み）
# popover はパネルの bl_space_type が呼び出し元エディターと一致する必要があるため、
# 対象エディターごとに同じ中身のクラスを用意する（draw は共有）。
# ----------------------------------------------------------------------------
class _NoMatPopoverBase:
    bl_label = "Objects Without Materials"
    bl_region_type = 'HEADER'
    bl_ui_units_x = 17  # ポップオーバーの横幅（約 340px 相当）を固定して安定させる。

    def draw(self, context):
        draw_no_material_ui(self.layout, context)


class VIEW3D_PT_no_material_popover(_NoMatPopoverBase, bpy.types.Panel):
    bl_idname = "VIEW3D_PT_no_material_popover"
    bl_space_type = 'VIEW_3D'


class NODE_PT_no_material_popover(_NoMatPopoverBase, bpy.types.Panel):
    bl_idname = "NODE_PT_no_material_popover"
    bl_space_type = 'NODE_EDITOR'


class OUTLINER_PT_no_material_popover(_NoMatPopoverBase, bpy.types.Panel):
    bl_idname = "OUTLINER_PT_no_material_popover"
    bl_space_type = 'OUTLINER'


class PROPERTIES_PT_no_material_popover(_NoMatPopoverBase, bpy.types.Panel):
    bl_idname = "PROPERTIES_PT_no_material_popover"
    bl_space_type = 'PROPERTIES'


# ----------------------------------------------------------------------------
# ヘッダー描画
# ----------------------------------------------------------------------------
def _draw_header(self, context):
    # 同じ描画関数を複数エディターのヘッダーに append/prepend する。
    # 呼び出し元エディターに応じて正しいポップオーバーを選ぶ。
    area = getattr(context, "area", None)
    atype = area.type if area else None
    pid = _POPOVER_BY_AREA.get(atype)
    if pid is None:
        return
    pred = _PREDICATE_BY_AREA.get(atype)
    if pred is not None and not pred(context.space_data):
        return  # 例：ノードエディターでもシェーダー以外では出さない。

    scene = context.scene
    if scene is None:
        return
    count = _get_count(scene, context.view_layer)
    if count is None:
        # まだ集計できていない：描画内で重い評価はせず、仮表示に留める
        # （集計が済めば自動で再描画されて実数に切り替わる）。
        self.layout.popover(panel=pid, text="…", icon='TIME')
        return
    icon = 'ERROR' if count > 0 else 'CHECKMARK'
    # ポップオーバー（ボタン直下に固定展開）でリストを表示する。
    self.layout.popover(panel=pid, text=str(count), icon=icon)


def _remove_all_headers():
    """登録しうる全エディターのヘッダーから描画関数を外す。"""
    for (_attr, hname, _atype, _pid, _pred) in _EDITORS:
        ht = getattr(bpy.types, hname, None)
        if ht is None:
            continue
        try:
            ht.remove(_draw_header)
        except Exception:
            pass


def _apply_header():
    """設定（位置＋対象エディター）に合わせてボタンを付け替える。
    位置 RIGHT=末尾(右) / LEFT=先頭(左)。表示先は各エディターのトグルで決まる
    （全てオフならどこにも表示されない）。"""
    _remove_all_headers()

    prefs = get_prefs()
    position = prefs.header_position if prefs else 'RIGHT'

    for (attr, hname, _atype, _pid, _pred) in _EDITORS:
        if prefs is not None:
            enabled = getattr(prefs, attr, False)
        else:
            enabled = (attr == _DEFAULT_EDITOR_ATTR)
        if not enabled:
            continue
        ht = getattr(bpy.types, hname, None)
        if ht is None:
            continue
        if position == 'RIGHT':
            ht.append(_draw_header)
        elif position == 'LEFT':
            ht.prepend(_draw_header)


# ----------------------------------------------------------------------------
# プロパティ / 設定
# ----------------------------------------------------------------------------
def _settings_update(self, context):
    # 設定変更は Scene 全体（全ビューレイヤー）に影響する。実際の集計は UI 描画では
    # 行わず、デバウンスしたタイマー内でまとめて行う。これにより、トグルのたびに
    # メインスレッドが固まって「素早い連続クリック（オン→即オフ）が取りこぼされる」
    # ことを防ぐ。既存の結果はクリアせず上書きするので、切り替え時に一瞬 "Counting…"
    # へちらつかない（最大 0.2 秒だけ旧集計が残るのみ）。
    _request_recount()
    _tag_redraw()


class NoMatSettings(bpy.types.PropertyGroup):
    show_filter: BoolProperty(
        name="Filters",
        description="Expand the filter section",
        default=False,
    )

    use_mesh: BoolProperty(name="Mesh", description="Include mesh objects",
                           default=True, update=_settings_update)
    use_curve: BoolProperty(name="Curve", description="Include curve objects",
                            default=True, update=_settings_update)
    use_surface: BoolProperty(name="Surface", description="Include surface objects",
                              default=True, update=_settings_update)
    use_meta: BoolProperty(name="Metaball", description="Include metaball objects",
                           default=True, update=_settings_update)
    use_font: BoolProperty(name="Text", description="Include text objects",
                           default=True, update=_settings_update)
    use_volume: BoolProperty(name="Volume", description="Include volume objects",
                             default=True, update=_settings_update)

    include_hidden: BoolProperty(
        name="Include Hidden Objects",
        description="Also count and list objects that are hidden in the viewport",
        default=False,
        update=_settings_update,
    )

    include_faceless: BoolProperty(
        name="Include Faceless Objects",
        description="Also count objects that have no faces even after modifiers "
                    "(e.g. empty meshes or vertex/edge-only meshes). Objects whose "
                    "modifiers generate faces, such as Skin, are always counted",
        default=False,
        update=_settings_update,
    )


def _header_update(self, context):
    _apply_header()
    _tag_redraw()


def _draw_header_settings(layout, prefs):
    """ヘッダーボタンの位置と対象エディターの設定 UI（prefs 画面と N パネルで共有）。"""
    layout.prop(prefs, "header_position")

    col = layout.column(align=True)
    col.label(text="Show button in:")
    col.prop(prefs, "show_in_view3d")
    col.prop(prefs, "show_in_shader")
    col.prop(prefs, "show_in_outliner")
    col.prop(prefs, "show_in_properties")


class NoMatPreferences(bpy.types.AddonPreferences):
    bl_idname = __name__

    header_position: EnumProperty(
        name="Position",
        description="Which side of the header to place the counter button on",
        items=[
            ('RIGHT', "Right", "Show the button on the right side of the header"),
            ('LEFT', "Left", "Show the button on the left side of the header"),
        ],
        default='RIGHT',
        update=_header_update,
    )

    show_in_view3d: BoolProperty(
        name="3D Viewport",
        description="Show the counter button in the 3D Viewport header",
        default=True,
        update=_header_update,
    )
    show_in_shader: BoolProperty(
        name="Shader Editor",
        description="Show the counter button in the Shader Editor header",
        default=False,
        update=_header_update,
    )
    show_in_outliner: BoolProperty(
        name="Outliner",
        description="Show the counter button in the Outliner header",
        default=False,
        update=_header_update,
    )
    show_in_properties: BoolProperty(
        name="Properties",
        description="Show the counter button in the Properties editor header",
        default=False,
        update=_header_update,
    )

    def draw(self, context):
        layout = self.layout
        _draw_header_settings(layout, self)
        layout.label(text="The list and filters live in the sidebar (N) > 'No Material' tab.",
                     icon='INFO')


# ----------------------------------------------------------------------------
# 登録
# ----------------------------------------------------------------------------
classes = (
    NoMatSettings,
    NoMatPreferences,
    OBJECT_OT_nomat_select,
    OBJECT_OT_nomat_select_all,
    VIEW3D_OT_nomat_refresh,
    VIEW3D_PT_no_material,            # 親パネルを先に登録
    VIEW3D_PT_no_material_settings,
    VIEW3D_PT_no_material_popover,
    NODE_PT_no_material_popover,
    OUTLINER_PT_no_material_popover,
    PROPERTIES_PT_no_material_popover,
)


def register():
    for cls in classes:
        bpy.utils.register_class(cls)

    bpy.types.Scene.no_material_settings = PointerProperty(type=NoMatSettings)

    # 設定値（位置＋対象エディター）に従ってヘッダーボタンを配置。
    _apply_header()

    # 二重登録を防ぎつつハンドラを追加。
    if _on_depsgraph_update not in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.append(_on_depsgraph_update)
    if _on_load not in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.append(_on_load)


def unregister():
    if _on_load in bpy.app.handlers.load_post:
        bpy.app.handlers.load_post.remove(_on_load)
    if _on_depsgraph_update in bpy.app.handlers.depsgraph_update_post:
        bpy.app.handlers.depsgraph_update_post.remove(_on_depsgraph_update)

    _timers_clear()    # 保留中のデバウンス/ピボット補正タイマーを解除（指摘2）
    _remove_all_headers()  # 全エディターのヘッダーから除去

    # 未登録状態でも例外を出さないようにガード。
    if hasattr(bpy.types.Scene, "no_material_settings"):
        del bpy.types.Scene.no_material_settings

    for cls in reversed(classes):
        try:
            bpy.utils.unregister_class(cls)
        except Exception:
            pass

    _result_cache.clear()
    _faces_cache.clear()


if __name__ == "__main__":
    register()
