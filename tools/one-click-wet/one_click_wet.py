# SPDX-License-Identifier: GPL-3.0-or-later

bl_info = {
    "name": "One Click Wet",
    "author": "mikat",
    "version": (1, 0, 0),
    "blender": (4, 5, 0),
    "location": "3D Viewport > N Panel > Wet",
    "description": "Make your existing materials wet in one click, using their own color, bumps and height (reversible)",
    "category": "Material",
}

import bpy
from mathutils import Vector

GROUP_NAME = "OCW Wet"
TAG = "ocw_wet"
GROUP_VERSION = 14      # グループの中身を変えたら上げる。古いグループの濡れノードは挿し直す
# 濡れた姿の Principled の Specular IOR Level。素材の表面は水に覆われ、反射は「空気と素材」ではなく
# 「水と素材」の境目で起きる：F0 ≈ ((1.5-1.33)/(1.5+1.33))² ≈ 0.0036（空気なら 0.04）なので約 1/10 → 0.5 × 0.1
WET_SPECULAR = 0.05
HELPER_PREFIX = "OCW_"  # マテリアル側に足す補助ノードの名前の頭
PASS_NAME = HELPER_PREFIX + "pass"  # 元の配線の途中に挟む補助ノード（入力0 → 出力0 を元の配線に戻して外す）

# 素材ごとの濡れ方（濡れ具合 Wetness はプロファイルに含めず、Nパネルのスライダーで変える）
#   Darken         元シェーダー全体をどれだけ暗くするか
#   Film Strength  水膜（反射）の強さ
#   Film Roughness 水膜のラフネス
#   Unevenness     染み込みのムラ
#   Noise Scale    ムラの細かさ（1メートルあたり。オブジェクトの大きさやスケール適用の有無には左右されない）
#   Pool Area      水たまりになる面積の割合（0.1 = 低いほうから 10%）。適用時に測った高さの分布から、その割合の高さを水面にする。
#                  分布が二山に分かれた素材（剥がれた漆喰と下地など）でも、低い山がまるごと水たまりにならない
#   Pool Softness  水たまりの縁のぼかし幅（高さを「中央値 = 0、25〜75% が −0.5〜+0.5」にそろえた単位）
#   Peak Dryness   Midlevel より高いところをどれだけ乾かすか（暗さ・水膜を減らし、水膜を粗くする）
#   Drying Rim     乾きかけの縁の濃さ。Wetness を下げて濡れた部分が島のように残るとき、島の縁の内側を少し余分に暗くする
#                  （水が引くときに境目に残る濃い輪郭）。全部濡れているときは境目がないので出ない
#   Film Smoothing 水膜が細かい凹凸をどれだけならすか（0 = 素材の凹凸どおり、1 = 平ら）。
#                  水がすき間を埋めると反射がまとまる。アスファルトは強め、土や布は凹凸どおり
#   Wet Color Power 濡れた姿の色を何乗するか（2 = 2乗）。灰色の素材は2乗だと暗くなりきらないので強める
#   Bright Darkening 明るい色（白に近い漆喰など）だけ、さらに暗くする量。累乗では白に近い色ほど暗くなりきらないため。
#                   明るさ 0.4 から効き始め 0.9 で最大なので、木・土のような中くらい〜暗い色には効かない
# 暗くするとき：Principled が直接つながっていれば、Base Color を Wet Color Power 乗した Principled と混ぜる（素材の色のまま深くなる）。
#   それ以外は黒と混ぜる。以前は決め打ちの Absorb Color を混ぜていたが、素材の色と合わないと泥のようにくすむのでやめた
PROFILES = {
    'WOOD': {
        "label": "Wood",
        "Darken": 0.8,
        "Film Strength": 0.6,
        "Film Roughness": 0.12,
        "Unevenness": 0.2,
        "Noise Scale": 3.0,
        "Pool Area": 0.03,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.35,
        "Film Smoothing": 0.0,
        "Wet Color Power": 2.0,
        "Bright Darkening": 0.15,
        "Drying Rim": 0.5,
    },
    # 土は吸水性が高く大きく暗くなる。水は染み込むので水膜は弱く粗め、ムラは大きめ。くぼみには水が溜まる
    'SOIL': {
        "label": "Soil",
        "Darken": 0.93,
        "Film Strength": 0.2,
        "Film Roughness": 0.3,
        "Unevenness": 0.2,
        "Noise Scale": 1.5,
        "Pool Area": 0.1,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.4,
        "Film Smoothing": 0.0,
        "Wet Color Power": 2.0,
        "Bright Darkening": 0.15,
        "Drying Rim": 0.6,
    },
    # コンクリートは吸水するがムラが出やすい（打ち継ぎ・表面の密度差）。水膜は中くらい、くぼみに水が溜まる
    'CONCRETE': {
        "label": "Concrete",
        "Darken": 1.0,
        "Film Strength": 0.25,
        "Film Roughness": 0.18,
        "Unevenness": 0.2,
        "Noise Scale": 2.0,
        "Pool Area": 0.06,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.3,
        "Film Smoothing": 0.5,
        "Wet Color Power": 3.0,
        "Bright Darkening": 0.25,
        "Drying Rim": 0.6,
    },
    # アスファルトはもともと暗いので暗くなる差は小さい。濡れると鏡のように強く映り込む
    'ASPHALT': {
        "label": "Asphalt",
        "Darken": 0.55,
        "Film Strength": 0.75,
        "Film Roughness": 0.07,
        "Unevenness": 0.2,
        "Noise Scale": 1.0,
        "Pool Area": 0.08,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.1,
        "Film Smoothing": 0.85,
        "Wet Color Power": 2.0,
        "Bright Darkening": 0.1,
        "Drying Rim": 0.3,
    },
    # 石・岩は吸水が少ない。暗くなるのは控えめで、表面が濡れてつやが出る
    'STONE': {
        "label": "Stone",
        "Darken": 1.0,
        "Film Strength": 0.4,
        "Film Roughness": 0.1,
        "Unevenness": 0.2,
        "Noise Scale": 2.5,
        "Pool Area": 0.08,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.1,
        "Film Smoothing": 0.5,
        "Wet Color Power": 3.0,
        "Bright Darkening": 0.2,
        "Drying Rim": 0.4,
    },
    # レンガは土に近いほど吸水する。赤みを残して深く暗くなり、水膜はほとんど出ない
    'BRICK': {
        "label": "Brick",
        "Darken": 0.85,
        "Film Strength": 0.18,
        "Film Roughness": 0.3,
        "Unevenness": 0.2,
        "Noise Scale": 2.0,
        "Pool Area": 0.06,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.1,
        "Film Smoothing": 0.4,
        "Wet Color Power": 2.5,
        "Bright Darkening": 0.15,
        "Drying Rim": 0.5,
    },
    # 布は繊維が水を吸って大きく暗くなる。表面に水は残らないので反射はほぼなし、水たまりもできない
    'FABRIC': {
        "label": "Fabric",
        "Darken": 0.8,
        "Film Strength": 0.04,
        "Film Roughness": 0.5,
        "Unevenness": 0.05,
        "Noise Scale": 2.0,
        "Pool Area": 0.0,
        "Pool Softness": 0.15,
        "Peak Dryness": 0.2,
        "Film Smoothing": 0.0,
        "Wet Color Power": 2.0,
        "Bright Darkening": 0.2,
        "Drying Rim": 0.6,
    },
}
FLOAT_KEYS = ("Darken", "Film Strength", "Film Roughness", "Unevenness", "Noise Scale",
              "Pool Softness", "Peak Dryness", "Film Smoothing", "Drying Rim")
# Nパネルに出す入力（高さの受け渡し用の入力はアドオンが設定するので出さない）
TWEAK_KEYS = ("Wetness",) + FLOAT_KEYS

# 濡れ方（素材とは別に選ぶ）。面の向き・地面からの高さで濡れる場所を変える
MODE_KEYS = ("Shelter", "Streaks", "Rise Height", "Rise Only")
MODES = {
    # 全体が濡れている（水をかぶった・水から上げた）
    'SOAKED': {"label": "Soaked", "Shelter": 0.0, "Streaks": 0.0, "Rise Height": 0.0, "Rise Only": 0.0},
    # 雨：上向きはそのまま、縦の面は垂れた筋、下向き（軒下）は乾いたまま。地面近くは跳ね返りで濡れる
    'RAIN': {"label": "Rain", "Shelter": 0.9, "Streaks": 0.7, "Rise Height": 0.15, "Rise Only": 0.0},
    # 足元だけ：地面から 0.4m までが濡れる（跳ね返り・地面からの染み上がり）
    'GROUND': {"label": "Ground", "Shelter": 0.0, "Streaks": 0.0, "Rise Height": 0.4, "Rise Only": 1.0},
}
# オブジェクトごとに乾かす量（オブジェクトのカスタムプロパティ／メッシュの属性。0 = そのまま、1 = 乾かす）
DRY_ATTR = "ocw_dry"
# オブジェクトの一番上の高さ（ローカル Z）。雨の筋を上の縁から垂らすのに使う。適用時に記録する
TOP_ATTR = "ocw_top"
# 地面の高さ（シーンのカスタムプロパティ、m）。濡れ方の Rise Height（跳ね返り・足元）はここから測る。なければ 0
GROUND_ATTR = "ocw_ground"
# シーン全体で乾かす量（シーンのカスタムプロパティ。N パネルの Scene Wetness = 1 − これ）
SCENE_DRY_ATTR = "ocw_scene_dry"


def _float_socket(ng, name, default, lo, hi):
    s = ng.interface.new_socket(name, in_out='INPUT', socket_type='NodeSocketFloat')
    s.default_value = default
    s.min_value = lo
    s.max_value = hi


def _sock(sockets, identifier):
    """名前が重なるソケット（Mix ノードの A/B など）を identifier で取る"""
    return next(x for x in sockets if x.identifier == identifier)


def get_wet_group():
    ng = next((g for g in bpy.data.node_groups if g.get(TAG) == GROUP_VERSION), None)
    if ng:
        return ng

    wood = PROFILES['WOOD']
    ng = bpy.data.node_groups.new(GROUP_NAME, 'ShaderNodeTree')
    ng[TAG] = GROUP_VERSION
    ng.interface.new_socket("Shader", in_out='INPUT', socket_type='NodeSocketShader')
    ng.interface.new_socket("Shader", in_out='OUTPUT', socket_type='NodeSocketShader')
    _float_socket(ng, "Wetness", 1.0, 0.0, 1.0)
    for name in FLOAT_KEYS:
        lo, hi = {"Noise Scale": (0.0, 50.0)}.get(name, (0.0, 1.0))
        _float_socket(ng, name, wood[name], lo, hi)
    # 高さの受け渡し（Material Output の Displacement から拾い、水面で平らにして返す）
    _float_socket(ng, "Height", 0.0, -1e4, 1e4)
    _float_socket(ng, "Midlevel", 0.0, -1e4, 1e4)
    _float_socket(ng, "Height Gain", 1.0, 0.0, 1e6)   # 高さを「中央値 = 0、25〜75% が ±0.5」にそろえる倍率（適用時に測る）
    _float_socket(ng, "Pool Height", -1e4, -1e4, 1e4)  # 水面の高さ（Height と同じ単位）。Pool Area と測った分布から決める
    _float_socket(ng, "Use Height", 0.0, 0.0, 1.0)
    ng.interface.new_socket("Height", in_out='OUTPUT', socket_type='NodeSocketFloat')
    # 濡れ方（面の向き・地面からの高さ）。MODES のプリセットで入れる
    for name in MODE_KEYS:
        _float_socket(ng, name, 0.0, 0.0, 5.0 if name == "Rise Height" else 1.0)
    # 元のシェーダーから拾うもの：法線（Normal Map など。水膜と暗くする Diffuse を元の凹凸に沿わせる）と透明度
    ng.interface.new_socket("Normal", in_out='INPUT', socket_type='NodeSocketVector')
    _float_socket(ng, "Use Normal", 0.0, 0.0, 1.0)
    _float_socket(ng, "Alpha", 1.0, 0.0, 1.0)
    # 元の Principled を Base Color だけ2乗して複製したもの（アドオンが作る）。なければ黒で暗くする
    ng.interface.new_socket("Wet Shader", in_out='INPUT', socket_type='NodeSocketShader')
    _float_socket(ng, "Use Wet Shader", 0.0, 0.0, 1.0)

    N, L = ng.nodes, ng.links
    gi = N.new('NodeGroupInput'); gi.location = (-1400, 0)
    go = N.new('NodeGroupOutput'); go.location = (800, 0)

    def math(op, a, b, loc, c=None, clamp=False):
        m = N.new('ShaderNodeMath'); m.operation = op; m.location = loc; m.use_clamp = clamp
        for i, v in enumerate((a, b) if c is None else (a, b, c)):
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L.new(v, m.inputs[i])
        return m.outputs[0]

    def map_range(value, from_min, from_max, loc):
        m = N.new('ShaderNodeMapRange'); m.location = loc
        L.new(value, m.inputs['Value'])
        for name, v in (("From Min", from_min), ("From Max", from_max)):
            if isinstance(v, (int, float)):
                m.inputs[name].default_value = v
            else:
                L.new(v, m.inputs[name])
        return m.outputs[0]

    # --- 濡れ具合：マテリアルごとの Wetness × シーン全体の濡れ具合
    #     シーンの濡れ具合はシーンのカスタムプロパティ "ocw_scene_dry"（乾かす量）を Attribute（View Layer）で読む。
    #     属性がないと 0 になるので「乾かす量」にしてある。N パネルの Scene Wetness（キーフレーム可）が書き込む
    scene_dry = N.new('ShaderNodeAttribute'); scene_dry.location = (-1800, 200)
    scene_dry.attribute_type, scene_dry.attribute_name = 'VIEW_LAYER', SCENE_DRY_ATTR
    wetness = math('MULTIPLY', gi.outputs['Wetness'],
                   math('SUBTRACT', 1.0, scene_dry.outputs['Fac'], (-1600, 200), clamp=True), (-1400, 200))

    # --- 座標：オブジェクト座標にオブジェクトのスケールを掛けて、メートル単位にそろえる（UV不要）
    #     Noise Scale などを「1メートルあたり」にして、物の大きさやスケール適用の有無でムラの大きさが変わらないようにする。
    #     スケールは X・Y・Z の単位ベクトルをオブジェクト→ワールドに変換した長さ（回転・移動では模様は動かない）
    tc = N.new('ShaderNodeTexCoord'); tc.location = (-1800, -300)
    axis_len = []
    for i, axis in enumerate(((1, 0, 0), (0, 1, 0), (0, 0, 1))):
        vt = N.new('ShaderNodeVectorTransform'); vt.location = (-2000, -500 - 150 * i)
        vt.vector_type, vt.convert_from, vt.convert_to = 'VECTOR', 'OBJECT', 'WORLD'
        vt.inputs['Vector'].default_value = axis
        ln = N.new('ShaderNodeVectorMath'); ln.location = (-1800, -500 - 150 * i)
        ln.operation = 'LENGTH'
        L.new(vt.outputs['Vector'], ln.inputs[0])
        axis_len.append(ln.outputs['Value'])
    obj_scale = N.new('ShaderNodeCombineXYZ'); obj_scale.location = (-1600, -550)
    for i, v in enumerate(axis_len):
        L.new(v, obj_scale.inputs[i])
    coords = N.new('ShaderNodeVectorMath'); coords.location = (-1400, -400)
    coords.operation = 'MULTIPLY'
    L.new(tc.outputs['Object'], coords.inputs[0])
    L.new(obj_scale.outputs['Vector'], coords.inputs[1])
    coords = coords.outputs['Vector']

    noise = N.new('ShaderNodeTexNoise'); noise.location = (-1200, -300)
    noise.inputs['Detail'].default_value = 4.0
    L.new(coords, noise.inputs['Vector'])
    L.new(gi.outputs['Noise Scale'], noise.inputs['Scale'])

    remap = N.new('ShaderNodeMapRange'); remap.location = (-1000, -300)
    remap.inputs['From Min'].default_value = 0.4
    remap.inputs['From Max'].default_value = 0.6
    L.new(noise.outputs['Fac'], remap.inputs['Value'])
    L.new(math('SUBTRACT', 1.0, gi.outputs['Unevenness'], (-1200, -500)), remap.inputs['To Min'])
    # Wetness：全体を薄めるのではなく、ノイズをしきい値で切って「濡れた部分」の広さを変える。
    #   Wetness を下げると乾いた部分がまだらに広がり、ノイズの高い（濃く濡れていた）ところが最後まで残る。
    #   ノイズの Fac はほとんど 0.3〜0.7 に集まるので、しきい値はその範囲で動かす：0.70 − 0.40 × Wetness
    #   （2026-10-20 に 1.1 − 1.2 × Wetness で試したら、0.75 で全部濡れ・0.25 で全部乾きと中ほどで急に切り替わった）
    #   両端は確実に：Wetness 0.9〜1 で残りも濡らし、0 なら全部乾かす
    thr = math('SUBTRACT', 0.70, math('MULTIPLY', wetness, 0.40, (-1200, -700)), (-1000, -700))
    cover = map_range(noise.outputs['Fac'], math('SUBTRACT', thr, 0.03, (-800, -650)),
                      math('ADD', thr, 0.03, (-800, -750)), (-600, -700))
    cover = math('MAXIMUM', cover, map_range(wetness, 0.9, 1.0, (-600, -850)), (-400, -700))
    # 水たまりと水面の底上げは、Wetness が 0 なら消し、少しでもあれば効かせる（広さは水面の高さで変える）
    wet_on = math('MINIMUM', math('MULTIPLY', wetness, 10.0, (-1200, 950)), 1.0, (-1000, 950))
    cover = math('MULTIPLY', cover, wet_on, (-200, -700))

    # --- 濡れ方：面の向きと地面からの高さ（法線・位置はワールド。地面は Z = 0 とみなす）
    #   Shelter     下向きの面（軒下・オーバーハング）を乾かす量。雨は上から降る
    #   Streaks     縦の面を、水が垂れた縦の筋だけ濡らす量
    #   Rise Height この高さ（m）より下は向きに関係なく濡らす（跳ね返り・地面からの染み上がり）。0 で無し
    #   Rise Only   1 なら Rise Height より下だけを濡らす
    ogeo = N.new('ShaderNodeNewGeometry'); ogeo.location = (-2000, -1500)
    nz = N.new('ShaderNodeSeparateXYZ'); nz.location = (-1800, -1500)
    L.new(ogeo.outputs['Normal'], nz.inputs[0])
    nz = nz.outputs['Z']
    down = map_range(nz, -0.2, -0.7, (-1600, -1400))           # 下を向くほど 1
    up = map_range(nz, 0.6, 0.9, (-1600, -1700))               # 上を向くほど 1（水たまりはここにだけできる）
    vertical = map_range(math('ABSOLUTE', nz, 0.0, (-1800, -1650)), 0.75, 0.35, (-1600, -1550))
    # 筋：ワールドの向きにそろえた座標（回転・スケールを掛ける。移動では動かない）を Z 方向に引き伸ばしたノイズ
    wco = N.new('ShaderNodeVectorTransform'); wco.location = (-1800, -1900)
    wco.vector_type, wco.convert_from, wco.convert_to = 'VECTOR', 'OBJECT', 'WORLD'
    L.new(tc.outputs['Object'], wco.inputs['Vector'])
    stretch = N.new('ShaderNodeCombineXYZ'); stretch.location = (-1800, -2100)
    for i, k in enumerate((3.0, 3.0, 0.25)):
        L.new(math('MULTIPLY', gi.outputs['Noise Scale'], k, (-2000, -2000 - 120 * i)), stretch.inputs[i])
    sco = N.new('ShaderNodeVectorMath'); sco.location = (-1600, -1950); sco.operation = 'MULTIPLY'
    L.new(wco.outputs['Vector'], sco.inputs[0])
    L.new(stretch.outputs['Vector'], sco.inputs[1])
    snoise = N.new('ShaderNodeTexNoise'); snoise.location = (-1400, -1950)
    snoise.inputs['Scale'].default_value = 1.0
    snoise.inputs['Detail'].default_value = 2.0
    L.new(sco.outputs['Vector'], snoise.inputs['Vector'])
    streak = map_range(snoise.outputs['Fac'], 0.5, 0.56, (-1200, -1950))
    # 筋は上の縁から垂れ始め、筋ごとにばらばらの長さ（0.2〜1.6m）で終わる。上の縁からの距離は、
    # 適用時に記録したオブジェクトの一番上（ローカル Z、カスタムプロパティ "ocw_top"）からの差 × Z のスケール。
    # 記録がない（属性が 0）オブジェクトは、原点より上ならどこも距離が負になるので、今までどおり面全体に筋が付く
    top = N.new('ShaderNodeAttribute'); top.location = (-1800, -2550)
    top.attribute_type, top.attribute_name = 'OBJECT', TOP_ATTR
    oz = N.new('ShaderNodeSeparateXYZ'); oz.location = (-1800, -2700)
    L.new(tc.outputs['Object'], oz.inputs[0])
    dist = math('MULTIPLY', math('SUBTRACT', top.outputs['Fac'], oz.outputs['Z'], (-1600, -2600)), axis_len[2],
                (-1400, -2600))
    # 筋の長さ：水平方向だけのノイズ（同じ筋の中では同じ長さ）
    flat = N.new('ShaderNodeCombineXYZ'); flat.location = (-1800, -2850)
    for i in range(2):
        L.new(math('MULTIPLY', gi.outputs['Noise Scale'], 3.0, (-2000, -2850 - 120 * i)), flat.inputs[i])
    fco = N.new('ShaderNodeVectorMath'); fco.location = (-1600, -2850); fco.operation = 'MULTIPLY'
    L.new(wco.outputs['Vector'], fco.inputs[0])
    L.new(flat.outputs['Vector'], fco.inputs[1])
    lnoise = N.new('ShaderNodeTexNoise'); lnoise.location = (-1400, -2850)
    lnoise.inputs['Scale'].default_value = 1.0
    lnoise.inputs['Detail'].default_value = 0.0
    L.new(fco.outputs['Vector'], lnoise.inputs['Vector'])
    length = N.new('ShaderNodeMapRange'); length.location = (-1200, -2850)
    L.new(lnoise.outputs['Fac'], length.inputs['Value'])
    length.inputs['From Min'].default_value, length.inputs['From Max'].default_value = 0.3, 0.7
    length.inputs['To Min'].default_value, length.inputs['To Max'].default_value = 0.2, 1.6
    reach = map_range(dist, length.outputs[0], math('SUBTRACT', length.outputs[0], 0.25, (-1000, -2950)),
                      (-1000, -2800))                      # 筋の先で 25cm かけて薄くなる
    near_top = map_range(dist, 0.06, 0.02, (-1000, -2650))  # 上の縁のすぐ下は筋に関係なく濡れる
    streak = math('MAXIMUM', math('MULTIPLY', streak, reach, (-800, -2800)), near_top, (-800, -2650))
    # 縦の面の濡れ = 1 − Streaks × (1 − 筋)、下向きの面は Shelter の分だけ乾かす
    side = math('SUBTRACT', 1.0, math('MULTIPLY', gi.outputs['Streaks'],
                                      math('SUBTRACT', 1.0, streak, (-1200, -1800)), (-1000, -1800)), (-800, -1800))
    orient = math('SUBTRACT', 1.0, math('MULTIPLY', vertical, math('SUBTRACT', 1.0, side, (-800, -1650)),
                                        (-600, -1650)), (-400, -1650))
    orient = math('MULTIPLY', orient, math('SUBTRACT', 1.0, math('MULTIPLY', down, gi.outputs['Shelter'],
                                                                   (-1200, -1400)), (-1000, -1400)), (-200, -1550))
    zpos = N.new('ShaderNodeSeparateXYZ'); zpos.location = (-1800, -2300)
    L.new(ogeo.outputs['Position'], zpos.inputs[0])
    # 地面からの高さ = ワールドの Z − 地面の高さ（シーンのカスタムプロパティ "ocw_ground"。なければ 0）
    ground = N.new('ShaderNodeAttribute'); ground.location = (-2000, -2450)
    ground.attribute_type, ground.attribute_name = 'VIEW_LAYER', GROUND_ATTR
    above = math('SUBTRACT', zpos.outputs['Z'], ground.outputs['Fac'], (-1600, -2400))
    rise = map_range(above, math('ADD', gi.outputs['Rise Height'], 0.03, (-1600, -2250)),
                     math('SUBTRACT', gi.outputs['Rise Height'], 0.03, (-1600, -2350)), (-1400, -2300))
    rise = math('MULTIPLY', rise, math('GREATER_THAN', gi.outputs['Rise Height'], 0.0, (-1400, -2450)),
                (-1200, -2300))
    region = N.new('ShaderNodeMix'); region.location = (0, -1700); region.data_type = 'FLOAT'
    L.new(gi.outputs['Rise Only'], region.inputs['Factor'])
    L.new(math('MAXIMUM', orient, rise, (-200, -1750)), region.inputs['A'])
    L.new(rise, region.inputs['B'])
    region = region.outputs['Result']
    # --- オブジェクトごとの制御：オブジェクトのカスタムプロパティ／メッシュの属性 "ocw_dry"（0 = そのまま、1 = 乾かす）
    #     属性がないと Attribute ノードは 0 を返すので「乾かす量」にしてある（なければ普通に濡れる）
    keep = None
    for i, kind in enumerate(('OBJECT', 'GEOMETRY')):
        at = N.new('ShaderNodeAttribute'); at.location = (-400, -2100 - 180 * i)
        at.attribute_type, at.attribute_name = kind, DRY_ATTR
        keep = at.outputs['Fac'] if keep is None else math('MAXIMUM', keep, at.outputs['Fac'], (-200, -2150))
    keep = math('SUBTRACT', 1.0, keep, (0, -2150), clamp=True)
    cover = math('MULTIPLY', math('MULTIPLY', cover, region, (200, -1700)), keep, (400, -1700))
    # 乾きかけの縁：しきい値のすぐ内側（濡れている側）の帯。全部濡れているとき（Wetness 0.9〜1）は境目がないので出さない
    edge = map_range(noise.outputs['Fac'], math('ADD', thr, 0.06, (-600, -2600)),
                     math('ADD', thr, 0.02, (-600, -2700)), (-400, -2650))
    full = map_range(wetness, 0.9, 1.0, (-400, -2800))
    rim = math('MULTIPLY', math('MULTIPLY', edge, cover, (-200, -2650)),
               math('SUBTRACT', 1.0, full, (-200, -2800)), (0, -2700))
    rim = math('MULTIPLY', rim, math('MULTIPLY', gi.outputs['Drying Rim'], 0.55, (0, -2850)), (200, -2700))
    # 水たまり：上向きの面だけ、乾かしたオブジェクトには作らず、Rise Only なら地面の近くだけ
    pool_gate = math('MULTIPLY', math('MULTIPLY', up, keep, (200, -1900)),
                     math('ADD', math('SUBTRACT', 1.0, gi.outputs['Rise Only'], (0, -2000)),
                          math('MULTIPLY', gi.outputs['Rise Only'], rise, (0, -2050)), (200, -2000)), (400, -1900))
    mask = math('MULTIPLY', remap.outputs[0], cover, (-800, -300))
    # 水面の高さ（そろえた単位）：Pool Height をそろえた単位にして、乾くほど下げて水たまりを小さくする（Wetness 0.5 で −0.75）
    pool_norm = math('MULTIPLY', math('SUBTRACT', gi.outputs['Pool Height'], gi.outputs['Midlevel'], (-1600, 1100)),
                     gi.outputs['Height Gain'], (-1400, 1100))
    pool_level = math('SUBTRACT', pool_norm,
                      math('MULTIPLY', math('SUBTRACT', 1.0, wetness, (-1400, 1000)), 1.5,
                           (-1200, 1000)), (-1000, 1000))

    # --- 高さマスク：低いところ = 水たまり、高いところ = 乾き気味
    h = math('MULTIPLY', math('SUBTRACT', gi.outputs['Height'], gi.outputs['Midlevel'], (-1200, 500)),
             gi.outputs['Height Gain'], (-1000, 500))
    pool_hi = math('ADD', pool_level, gi.outputs['Pool Softness'], (-1000, 700))
    pool_lo = math('SUBTRACT', pool_level, gi.outputs['Pool Softness'], (-1000, 850))
    pool = map_range(h, pool_hi, pool_lo, (-800, 600))          # 低いほど 1
    pool = math('MULTIPLY', pool, gi.outputs['Use Height'], (-600, 600))
    pool = math('MULTIPLY', pool, wet_on, (-400, 600))
    pool = math('MULTIPLY', pool, pool_gate, (-200, 600))

    # 目立って盛り上がったところだけ乾かす：上位 1/4 あたり（+0.5）から乾き始め、+2 で最大
    #（0〜+1 にしたら面の半分に効いて、土や木がまだらに見えた）
    peak = map_range(h, 0.5, 2.0, (-800, 350))
    peak_dry = math('MULTIPLY', math('MULTIPLY', peak, gi.outputs['Peak Dryness'], (-600, 350)),
                    gi.outputs['Use Height'], (-400, 350))
    mask = math('MULTIPLY', mask, math('SUBTRACT', 1.0, peak_dry, (-600, -450)), (-400, -300))

    # --- 元の表面の法線：元のシェーダーの Normal（Normal Map など）を拾えたらそれ、なければ今の法線
    geo = N.new('ShaderNodeNewGeometry'); geo.location = (-800, -1100)
    base_n = N.new('ShaderNodeMix'); base_n.location = (-600, -1000)
    base_n.data_type = 'VECTOR'
    L.new(gi.outputs['Use Normal'], base_n.inputs['Factor'])
    L.new(geo.outputs['Normal'], _sock(base_n.inputs, 'A_Vector'))
    L.new(gi.outputs['Normal'], _sock(base_n.inputs, 'B_Vector'))
    base_n = _sock(base_n.outputs, 'Result_Vector')

    def opaque(shader, loc):
        """元が透明なところは透明のままにする（Alpha が 1 未満なら Transparent と混ぜる）"""
        tr = N.new('ShaderNodeBsdfTransparent'); tr.location = (loc[0] - 200, loc[1] - 150)
        m = N.new('ShaderNodeMixShader'); m.location = loc
        L.new(gi.outputs['Alpha'], m.inputs[0])
        L.new(tr.outputs[0], m.inputs[1])
        L.new(shader, m.inputs[2])
        return m.outputs[0]

    # --- 1. 暗くする：濡れた姿のシェーダーと Mix する（水たまりは最大）
    #        Wet Shader があればそれ（素材の色のまま暗く・鮮やかに）、なければ黒の Diffuse（単に暗くなる）
    absorb = N.new('ShaderNodeBsdfDiffuse'); absorb.location = (-200, -100)
    absorb.inputs['Color'].default_value = (0, 0, 0, 1)
    L.new(base_n, absorb.inputs['Normal'])
    wet_target = N.new('ShaderNodeMixShader'); wet_target.location = (0, -250)
    L.new(gi.outputs['Use Wet Shader'], wet_target.inputs[0])
    mix_dark = N.new('ShaderNodeMixShader'); mix_dark.location = (200, 100)
    dark_fac = math('MULTIPLY', math('MAXIMUM', mask, pool, (-200, 150)), gi.outputs['Darken'], (0, 150))
    L.new(dark_fac, mix_dark.inputs[0])
    L.new(gi.outputs['Shader'], mix_dark.inputs[1])
    L.new(opaque(absorb.outputs[0], (0, -100)), wet_target.inputs[1])
    L.new(gi.outputs['Wet Shader'], wet_target.inputs[2])
    L.new(wet_target.outputs[0], mix_dark.inputs[2])

    # --- 2. 水面：返す高さを水面の高さで底上げする（低いところが平らになる）
    #        実際に水が溜まるのと同じ形なので、バンプでも真のディスプレイスメントでも、Cycles でも Eevee でも平らになる
    #        水面の高さ・ぼかし幅は Height と同じ単位に戻して比べる（Midlevel + 水面 / Gain）
    level = math('ADD', gi.outputs['Midlevel'],
                 math('DIVIDE', pool_level, gi.outputs['Height Gain'], (-1000, 1100)), (-800, 1100))
    soft = math('DIVIDE', gi.outputs['Pool Softness'], gi.outputs['Height Gain'], (-800, 1250))
    filled = math('SMOOTH_MAX', gi.outputs['Height'], level, (-600, 1100), c=soft)
    fill_fac = math('MULTIPLY', math('MULTIPLY', gi.outputs['Use Height'], wet_on, (-800, 1300)), pool_gate,
                    (-600, 1300))
    fill = N.new('ShaderNodeMix'); fill.location = (-400, 1100)
    fill.data_type = 'FLOAT'
    L.new(fill_fac, fill.inputs['Factor'])
    L.new(gi.outputs['Height'], fill.inputs['A'])
    L.new(filled, fill.inputs['B'])
    L.new(fill.outputs['Result'], go.inputs['Height'])

    # 水膜の法線：元の表面の凹凸に沿わせ、細かいさざ波を足す。水たまりでは平らな今の法線にする
    #             （水たまりの平らさは上の高さで出している）
    film_n = N.new('ShaderNodeMix'); film_n.location = (-400, -1000)
    film_n.data_type = 'VECTOR'
    L.new(math('MAXIMUM', pool, gi.outputs['Film Smoothing'], (-600, -950)), film_n.inputs['Factor'])
    L.new(base_n, _sock(film_n.inputs, 'A_Vector'))
    L.new(geo.outputs['Normal'], _sock(film_n.inputs, 'B_Vector'))
    film_nn = N.new('ShaderNodeVectorMath'); film_nn.location = (-300, -1100)
    film_nn.operation = 'NORMALIZE'
    L.new(_sock(film_n.outputs, 'Result_Vector'), film_nn.inputs[0])
    fine = N.new('ShaderNodeTexNoise'); fine.location = (-400, -700)
    fine.inputs['Scale'].default_value = 60.0
    L.new(coords, fine.inputs['Vector'])
    ripple = N.new('ShaderNodeBump'); ripple.location = (-200, -800)
    ripple.inputs['Strength'].default_value = 0.03
    L.new(fine.outputs['Fac'], ripple.inputs['Height'])
    L.new(film_nn.outputs['Vector'], ripple.inputs['Normal'])
    normal = ripple.outputs['Normal']

    # --- 3. 水膜：Fresnel で重み付けした低ラフネス Glossy（Coat の代わり）
    #        高いところは粗く、水たまりはほぼ鏡面
    rough = math('ADD', gi.outputs['Film Roughness'], math('MULTIPLY', peak_dry, 0.25, (-200, -500)), (0, -500))
    rough_mix = N.new('ShaderNodeMix'); rough_mix.location = (200, -500)
    rough_mix.data_type = 'FLOAT'
    L.new(pool, rough_mix.inputs['Factor'])
    L.new(rough, rough_mix.inputs['A'])
    rough_mix.inputs['B'].default_value = 0.02

    fres = N.new('ShaderNodeFresnel'); fres.location = (200, -700)
    fres.inputs['IOR'].default_value = 1.33
    L.new(normal, fres.inputs['Normal'])

    glossy = N.new('ShaderNodeBsdfGlossy'); glossy.location = (400, -300)
    glossy.inputs['Color'].default_value = (1, 1, 1, 1)
    L.new(rough_mix.outputs['Result'], glossy.inputs['Roughness'])
    L.new(normal, glossy.inputs['Normal'])

    film = math('MAXIMUM', math('MULTIPLY', mask, gi.outputs['Film Strength'], (0, -300)), pool, (200, -300))
    film_fac = math('MULTIPLY', film, fres.outputs[0], (400, -600))

    mix_film = N.new('ShaderNodeMixShader'); mix_film.location = (600, 0)
    L.new(film_fac, mix_film.inputs[0])
    # 縁は黒の Diffuse と混ぜて少し余分に暗くする（水膜の下）
    rim_black = N.new('ShaderNodeBsdfDiffuse'); rim_black.location = (200, -1000)
    rim_black.inputs['Color'].default_value = (0, 0, 0, 1)
    L.new(base_n, rim_black.inputs['Normal'])
    mix_rim = N.new('ShaderNodeMixShader'); mix_rim.location = (400, 150)
    L.new(rim, mix_rim.inputs[0])
    L.new(mix_dark.outputs[0], mix_rim.inputs[1])
    L.new(opaque(rim_black.outputs[0], (200, -1150)), mix_rim.inputs[2])
    L.new(mix_rim.outputs[0], mix_film.inputs[1])
    L.new(opaque(glossy.outputs[0], (400, -150)), mix_film.inputs[2])
    L.new(mix_film.outputs[0], go.inputs['Shader'])
    return ng


def is_wet_node(node):
    return node.type == 'GROUP' and node.node_tree is not None and node.node_tree.get(TAG)


def target_materials(context):
    mats = []
    for ob in context.selected_objects:
        for slot in getattr(ob, "material_slots", []):
            m = slot.material
            if m and m.node_tree and m not in mats:
                mats.append(m)
    return mats


def wet_color_nodes(tree):
    """濡れた姿の色を作る補助ノード（OCW Wet Color グループ。古い版は Gamma）"""
    return [n for n in tree.nodes if n.name.startswith(HELPER_PREFIX + "wet_color")]


WET_COLOR_GROUP = "OCW Wet Color"
WET_COLOR_TAG = "ocw_wet_color"
WET_COLOR_VERSION = 1


def get_wet_color_group():
    """濡れた姿の色：彩度のある色は累乗（暗く・鮮やかに）、ほぼ無彩色は明るさだけを下げる（色かぶりを強めない）。
    明るい色は Bright Darkening の分だけさらに暗くする。
      L = 明るさ、s = 彩度 (max − min) / max、k = clamp(4s)
      濡れた色 = mix(色 × L^(Power−1), 色^Power, k) × (1 − Bright Darkening × smoothstep(0.4, 0.9, L))
    （2026-10-22：色を各チャンネル累乗するだけだと、白っぽい漆喰のわずかな赤みが強まった）"""
    g = next((x for x in bpy.data.node_groups if x.get(WET_COLOR_TAG) == WET_COLOR_VERSION), None)
    if g:
        return g
    g = bpy.data.node_groups.new(WET_COLOR_GROUP, 'ShaderNodeTree')
    g[WET_COLOR_TAG] = WET_COLOR_VERSION
    g.interface.new_socket("Color", in_out='INPUT', socket_type='NodeSocketColor')
    _float_socket(g, "Power", 2.0, 1.0, 6.0)
    _float_socket(g, "Bright Darkening", 0.0, 0.0, 1.0)
    g.interface.new_socket("Color", in_out='OUTPUT', socket_type='NodeSocketColor')
    N, L = g.nodes, g.links
    gi = N.new('NodeGroupInput'); gi.location = (-1000, 0)
    go = N.new('NodeGroupOutput'); go.location = (800, 0)

    def math(op, a, b, loc, clamp=False):
        m = N.new('ShaderNodeMath'); m.operation = op; m.location = loc; m.use_clamp = clamp
        for i, v in enumerate((a, b)):
            if isinstance(v, (int, float)):
                m.inputs[i].default_value = v
            else:
                L.new(v, m.inputs[i])
        return m.outputs[0]

    col = gi.outputs['Color']
    sep = N.new('ShaderNodeSeparateColor'); sep.location = (-800, -200)
    L.new(col, sep.inputs[0])
    r, gr, b = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    lum = math('ADD', math('ADD', math('MULTIPLY', r, 0.2126, (-600, -100)), math('MULTIPLY', gr, 0.7152, (-600, -200)),
                           (-400, -150)), math('MULTIPLY', b, 0.0722, (-600, -300)), (-200, -200))
    mx = math('MAXIMUM', math('MAXIMUM', r, gr, (-600, -450)), b, (-400, -450))
    mn = math('MINIMUM', math('MINIMUM', r, gr, (-600, -550)), b, (-400, -550))
    sat = math('DIVIDE', math('SUBTRACT', mx, mn, (-200, -500)), math('MAXIMUM', mx, 1e-4, (-200, -600)), (0, -500))
    k = math('MULTIPLY', sat, 4.0, (200, -500), clamp=True)
    # 明るさだけ下げる：色 × L^(Power−1)
    fac = math('POWER', lum, math('SUBTRACT', gi.outputs['Power'], 1.0, (-200, -300)), (0, -250))
    scaled = N.new('ShaderNodeMix'); scaled.location = (200, -200)
    scaled.data_type, scaled.blend_type = 'RGBA', 'MULTIPLY'
    _sock(scaled.inputs, 'Factor_Float').default_value = 1.0
    L.new(col, _sock(scaled.inputs, 'A_Color'))
    comb = N.new('ShaderNodeCombineColor'); comb.location = (100, -350)
    for i in range(3):
        L.new(fac, comb.inputs[i])
    L.new(comb.outputs[0], _sock(scaled.inputs, 'B_Color'))
    # 累乗：色^Power
    powered = N.new('ShaderNodeGamma'); powered.location = (200, 100)
    L.new(col, powered.inputs['Color'])
    L.new(gi.outputs['Power'], powered.inputs['Gamma'])
    blend = N.new('ShaderNodeMix'); blend.location = (400, 0)
    blend.data_type = 'RGBA'
    L.new(k, _sock(blend.inputs, 'Factor_Float'))
    L.new(_sock(scaled.outputs, 'Result_Color'), _sock(blend.inputs, 'A_Color'))
    L.new(powered.outputs['Color'], _sock(blend.inputs, 'B_Color'))
    # 明るい色はさらに暗く
    bright = N.new('ShaderNodeMapRange'); bright.location = (200, 300)
    bright.interpolation_type = 'SMOOTHSTEP'
    L.new(lum, bright.inputs['Value'])
    bright.inputs['From Min'].default_value = 0.4
    bright.inputs['From Max'].default_value = 0.9
    keep = math('SUBTRACT', 1.0, math('MULTIPLY', bright.outputs[0], gi.outputs['Bright Darkening'], (400, 300)),
                (600, 300))
    dark = N.new('ShaderNodeMix'); dark.location = (600, 0)
    dark.data_type, dark.blend_type = 'RGBA', 'MULTIPLY'
    _sock(dark.inputs, 'Factor_Float').default_value = 1.0
    L.new(_sock(blend.outputs, 'Result_Color'), _sock(dark.inputs, 'A_Color'))
    kc = N.new('ShaderNodeCombineColor'); kc.location = (600, 200)
    for i in range(3):
        L.new(keep, kc.inputs[i])
    L.new(kc.outputs[0], _sock(dark.inputs, 'B_Color'))
    L.new(_sock(dark.outputs, 'Result_Color'), go.inputs['Color'])
    return g


def set_profile(node, key):
    prof = PROFILES[key]
    for name in FLOAT_KEYS:
        node.inputs[name].default_value = prof[name]
    for n in wet_color_nodes(node.id_data):
        if n.type == 'GROUP':
            n.inputs['Power'].default_value = prof["Wet Color Power"]
            n.inputs['Bright Darkening'].default_value = prof["Bright Darkening"]
        else:                                        # 古い版（Gamma）
            n.inputs['Gamma'].default_value = prof["Wet Color Power"]
    node["ocw_profile_label"] = prof['label']
    mat = next((m for m in bpy.data.materials if m.node_tree == node.id_data), None)
    if mat is not None:
        mat.ocw_pool_area = prof["Pool Area"]     # update で水面の高さも決まる
    m = MODES.get(node.get("ocw_mode", 'SOAKED'), MODES['SOAKED'])
    node.label = f"Wet ({prof['label']}, {m['label']})"


def _bump_height(pr):
    """Principled の Normal をたどって、高さがつながった Bump の Height の元を返す
    （Bump を重ねた形・Normal Map を Bump の Normal に入れた形・Reroute もたどる）"""
    sock = pr.inputs['Normal']
    for _ in range(8):
        if not sock.is_linked:
            return None
        n = sock.links[0].from_node
        if n.type == 'REROUTE':
            sock = n.inputs[0]
        elif n.type == 'BUMP':
            if n.inputs['Height'].is_linked:
                return n.inputs['Height'].links[0].from_socket
            sock = n.inputs['Normal']
        else:
            return None
    return None


def connect_bump_height(tree, node):
    """Displacement がない素材：Bump の高さ（またはグループの Displacement Bake 出力）を濡れノードの Height に入れる
    水たまりと「盛り上がったところから乾く」を効かせるため。Displacement がないので高さを戻す先はなく、
    水たまりの平らさは水膜の法線（水たまりでは平らな法線にしている）だけで出す"""
    if not node.inputs['Shader'].is_linked:
        return False
    src = node.inputs['Shader'].links[0].from_socket
    n = src.node
    h = None
    if n.type == 'BSDF_PRINCIPLED':
        h = _bump_height(n)
    elif n.type == 'GROUP' and n.node_tree:
        # 見た目の凹凸を作っている中の Bump を先に使う。Displacement Bake は Displacement の量が 0 だと平ら（Sanctus の concrete）
        found = inner_principled(n, src)
        if len(found) == 1:
            pr, path = found[0]
            inner = _bump_height(pr)
            if inner is not None:
                h = _expose(n, path, "Height", 'NodeSocketFloat', inner)
        bake = n.outputs.get('Displacement Bake')
        if h is None and bake is not None and bake.type == 'VALUE':
            h = bake
    if h is None:
        return False
    tree.links.new(h, node.inputs['Height'])
    node.inputs['Midlevel'].default_value = 0.0
    node.inputs['Height Gain'].default_value = 1.0   # 仮の値。この後 calibrate_height で測り直す
    node.inputs['Use Height'].default_value = 1.0
    node["ocw_height_from"] = "bump"
    return True


def _unroute_height(tree, node):
    """Displacement から拾った高さが使えなかったとき（どこも同じ高さだった）に、濡れノードを高さの経路から外して元に戻す
    （Displacement ノードの Height をつなぎ直す／ベクトル直結の補助ノードを外す）"""
    h_in = node.inputs['Height']
    src = h_in.links[0].from_socket if h_in.is_linked else None
    for link in list(node.outputs['Height'].links):
        to = link.to_node
        if to.type == 'DISPLACEMENT':
            if src is not None:
                tree.links.new(src, link.to_socket)
        elif to.name.startswith(HELPER_PREFIX + "delta"):
            delta = to
            offset = delta.outputs[0].links[0].to_node if delta.outputs[0].is_linked else None
            pas = offset.outputs[0].links[0].to_node if offset and offset.outputs[0].is_linked else None
            if pas is not None and pas.name.startswith(PASS_NAME):
                _bypass(tree, pas, pas.inputs[0], pas.outputs[0])
                tree.nodes.remove(pas)
            if offset is not None:
                tree.nodes.remove(offset)
            tree.nodes.remove(delta)
    if src is not None and src.node.name.startswith(HELPER_PREFIX + "height"):
        dot = src.node
        geo = dot.inputs[0].links[0].from_node if dot.inputs[0].is_linked else None
        tree.nodes.remove(dot)
        if geo is not None and geo.name.startswith(HELPER_PREFIX + "geo") and not any(o.is_linked for o in geo.outputs):
            tree.nodes.remove(geo)
    for l in list(node.inputs['Height'].links):
        tree.links.remove(l)
    node.inputs['Use Height'].default_value = 0.0


def connect_height(tree, out, node):
    """Material Output の Displacement から高さを拾って濡れノードに通し、水面で平らにした高さを戻す
    Displacement がなければ Bump の高さを読む（connect_bump_height）"""
    disp = out.inputs['Displacement']
    if not disp.is_linked:
        node.inputs['Use Height'].default_value = 0.0
        connect_bump_height(tree, node)
        return
    src = disp.links[0].from_node
    if src.type == 'DISPLACEMENT' and src.inputs['Height'].is_linked:
        # Displacement ノード経由：高さ（スカラー）を濡れノードに通してから Displacement に戻す
        h_in = src.inputs['Height']
        prev = h_in.links[0].from_node
        if is_wet_node(prev):
            # 別の Material Output 用の濡れノードがもう挟まっている：元の高さを読むだけにする
            tree.links.new(prev.inputs['Height'].links[0].from_socket, node.inputs['Height'])
        else:
            tree.links.new(h_in.links[0].from_socket, node.inputs['Height'])
            tree.links.new(node.outputs['Height'], h_in)
        node.inputs['Midlevel'].default_value = src.inputs['Midlevel'].default_value
        node.inputs['Height Gain'].default_value = 1.0   # 仮の値。この後 calibrate_height で測り直す
    else:
        # それ以外（ベクトルが直接来ている）：法線方向の成分を高さとみなし、
        # 平らにした分だけ法線方向にずらして戻す。Displacement のベクトルはワールド空間なので法線もワールドのまま使う
        vec = disp.links[0].from_socket
        x, y = out.location.x - 800, out.location.y - 300
        geo = tree.nodes.new('ShaderNodeNewGeometry'); geo.name = HELPER_PREFIX + "geo"
        geo.location = (x, y)
        dot = tree.nodes.new('ShaderNodeVectorMath'); dot.name = HELPER_PREFIX + "height"
        dot.operation = 'DOT_PRODUCT'; dot.location = (x + 200, y)
        tree.links.new(geo.outputs['Normal'], dot.inputs[0])
        tree.links.new(vec, dot.inputs[1])
        tree.links.new(dot.outputs['Value'], node.inputs['Height'])
        delta = tree.nodes.new('ShaderNodeMath'); delta.name = HELPER_PREFIX + "delta"
        delta.operation = 'SUBTRACT'; delta.location = (x + 400, y - 150)
        tree.links.new(node.outputs['Height'], delta.inputs[0])
        tree.links.new(dot.outputs['Value'], delta.inputs[1])
        offset = tree.nodes.new('ShaderNodeVectorMath'); offset.name = HELPER_PREFIX + "offset"
        offset.operation = 'SCALE'; offset.location = (x + 600, y - 150)
        tree.links.new(geo.outputs['Normal'], offset.inputs[0])
        tree.links.new(delta.outputs['Value'], offset.inputs['Scale'])
        add = tree.nodes.new('ShaderNodeVectorMath'); add.name = PASS_NAME
        add.operation = 'ADD'; add.location = (x + 800, y)
        tree.links.new(vec, add.inputs[0])
        tree.links.new(offset.outputs['Vector'], add.inputs[1])
        tree.links.new(add.outputs['Vector'], disp)
        node.inputs['Midlevel'].default_value = 0.0
        node.inputs['Height Gain'].default_value = 10.0  # 仮の値。この後 calibrate_height で素材ごとに測り直す
    node.inputs['Use Height'].default_value = 1.0


# 元のシェーダーにこれがあると、暗くする Diffuse や水膜で不透明になってしまう
SEE_THROUGH_TYPES = {'BSDF_TRANSPARENT', 'BSDF_GLASS', 'BSDF_REFRACTION', 'HOLDOUT'}


def shader_nodes(surface):
    """Material Output の Surface の上流にあるシェーダー系ノードを (ノード, グループの中か) で返す
    Mix/Add Shader・Reroute・ノードグループの中もたどる"""
    found, seen, stack = [], set(), [(surface, False)]
    while stack:
        sock, inside = stack.pop()
        for link in sock.links:
            n = link.from_node
            if n.as_pointer() in seen:
                continue
            seen.add(n.as_pointer())
            found.append((n, inside))
            if n.type == 'GROUP' and n.node_tree:
                go = next((g for g in n.node_tree.nodes if g.type == 'GROUP_OUTPUT' and g.is_active_output), None)
                idx = list(n.outputs).index(link.from_socket)
                if go and idx < len(go.inputs):
                    stack.append((go.inputs[idx], True))
            else:
                stack += [(i, inside) for i in n.inputs if i.type == 'SHADER']
    return found


def inspect_surface(surface):
    """(Alpha を拾う Principled, Normal を拾うノード, 濡らせない理由) を返す
    Alpha と Normal はマテリアル直下のノードからしか配線できない（グループの中には線を引けない）"""
    alpha_bsdf = normal_node = None
    reasons = []
    for n, inside in shader_nodes(surface):
        if n.type in SEE_THROUGH_TYPES:
            reasons.append(n.name)
            continue
        if n.type == 'BSDF_PRINCIPLED':
            tw = n.inputs['Transmission Weight']
            if tw.is_linked or tw.default_value > 0:
                reasons.append(n.name + " (Transmission)")
            a = n.inputs['Alpha']
            if a.is_linked or a.default_value < 1.0:
                if inside or alpha_bsdf:
                    reasons.append(n.name + " (Alpha)")
                else:
                    alpha_bsdf = n
        nin = n.inputs.get('Normal')
        if not inside and normal_node is None and nin and nin.type == 'VECTOR' and nin.is_linked:
            normal_node = n
    return alpha_bsdf, normal_node, reasons


def connect_surface(tree, node, alpha_bsdf, normal_node):
    if normal_node:
        tree.links.new(normal_node.inputs['Normal'].links[0].from_socket, node.inputs['Normal'])
        node.inputs['Use Normal'].default_value = 1.0
    if alpha_bsdf:
        a = alpha_bsdf.inputs['Alpha']
        if a.is_linked:
            tree.links.new(a.links[0].from_socket, node.inputs['Alpha'])
        else:
            node.inputs['Alpha'].default_value = a.default_value


def wet_color_node(tree, loc):
    """濡れた姿の色を作る補助ノード（OCW Wet Color）。Power・Bright Darkening は set_profile が入れる"""
    g = tree.nodes.new('ShaderNodeGroup')
    g.node_tree = get_wet_color_group()
    g.name = HELPER_PREFIX + "wet_color"
    g.location = loc
    return g


def connect_wet_bsdf(tree, node, bsdf):
    """bsdf（Principled）を複製して Base Color を Wet Color Power 乗し、濡れノードの Wet Shader につなぐ
    濡れると水が繊維や粒のすき間を埋め、表面で白っぽく散る光が減る → 同じ色のまま暗く・鮮やかになる。
    色を累乗（Wet Color Power、既定は2乗）すると暗い色ほど大きく暗くなり、その分彩度も上がる"""
    wet = tree.nodes.new('ShaderNodeBsdfPrincipled')
    wet.name = HELPER_PREFIX + "wet_bsdf"
    wet.label = "Wet (darker color)"
    wet.location = (bsdf.location.x, bsdf.location.y - 700)
    for attr in ('distribution', 'subsurface_method'):
        setattr(wet, attr, getattr(bsdf, attr))
    for a, b in zip(bsdf.inputs, wet.inputs):
        if a.identifier == wet.inputs['Specular IOR Level'].identifier:
            continue
        if a.is_linked:
            tree.links.new(a.links[0].from_socket, b)
        elif hasattr(a, 'default_value'):
            b.default_value = a.default_value
    wet.inputs['Specular IOR Level'].default_value = WET_SPECULAR
    col = bsdf.inputs['Base Color']
    power = wet_color_node(tree, (wet.location.x - 250, wet.location.y))
    if col.is_linked:
        tree.links.new(col.links[0].from_socket, power.inputs['Color'])
    else:
        power.inputs['Color'].default_value = col.default_value
    tree.links.new(power.outputs['Color'], wet.inputs['Base Color'])
    tree.links.new(wet.outputs[0], node.inputs['Wet Shader'])
    node.inputs['Use Wet Shader'].default_value = 1.0


def decode_normal_bake(tree, socket, loc):
    """Sanctus の Normal Bake（接空間の法線を 0〜1 に詰めたもの）をワールドの法線に戻す
    Sanctus の normal_bake グループの逆：X = N·T、Y = N·(Ng×T)、Z = N·Ng を ×0.5+0.5 している"""
    x, y = loc
    def new(kind, name, dx, dy):
        n = tree.nodes.new(kind)
        n.name = HELPER_PREFIX + "nb_" + name
        n.location = (x + dx, y + dy)
        return n
    def vmath(op, name, dx, dy, a, b=None):
        n = new('ShaderNodeVectorMath', name, dx, dy)
        n.operation = op
        for i, v in enumerate((a, b)):
            if v is not None:
                tree.links.new(v, n.inputs[i])
        return n
    tan = new('ShaderNodeTangent', "tangent", 0, 0)
    tan.direction_type = 'UV_MAP'        # Sanctus と同じ（UV マップ名は空＝アクティブな UV）
    geo = new('ShaderNodeNewGeometry', "geo", 0, -200)
    unpack = new('ShaderNodeVectorMath', "unpack", 0, 200)   # 0〜1 → -1〜1
    unpack.operation = 'MULTIPLY_ADD'
    tree.links.new(socket, unpack.inputs[0])
    unpack.inputs[1].default_value = (2.0, 2.0, 2.0)
    unpack.inputs[2].default_value = (-1.0, -1.0, -1.0)
    sep = new('ShaderNodeSeparateXYZ', "xyz", 200, 200)
    tree.links.new(unpack.outputs['Vector'], sep.inputs[0])
    bit = vmath('CROSS_PRODUCT', "bitangent", 200, -100, geo.outputs['Normal'], tan.outputs['Tangent'])
    parts = []
    for i, (axis, vec) in enumerate((('X', tan.outputs['Tangent']), ('Y', bit.outputs['Vector']),
                                      ('Z', geo.outputs['Normal']))):
        sc = vmath('SCALE', "s" + axis, 400, 200 - 150 * i, vec)
        tree.links.new(sep.outputs[axis], sc.inputs['Scale'])
        parts.append(sc.outputs['Vector'])
    s1 = vmath('ADD', "add1", 600, 100, parts[0], parts[1])
    s2 = vmath('ADD', "add2", 750, 0, s1.outputs['Vector'], parts[2])
    norm = vmath('NORMALIZE', "normal", 900, 0, s2.outputs['Vector'])
    return norm.outputs['Vector']


def connect_bake_outputs(tree, node, group_node):
    """Sanctus などのグループが持つベイク用の出力（Normal / Color / Roughness Bake）から、
    水膜の法線と「濡れた姿」の Principled を外に組み立てる（グループの中には線を引けないため）"""
    bakes = {o.name: o for o in group_node.outputs if o.name.endswith(" Bake")}
    normal = None
    if 'Normal Bake' in bakes:
        normal = decode_normal_bake(tree, bakes['Normal Bake'],
                                    (group_node.location.x, group_node.location.y - 600))
        tree.links.new(normal, node.inputs['Normal'])
        node.inputs['Use Normal'].default_value = 1.0
    if 'Color Bake' not in bakes:
        return
    wet = tree.nodes.new('ShaderNodeBsdfPrincipled')
    wet.name = HELPER_PREFIX + "wet_bsdf"
    wet.label = "Wet (from bake outputs)"
    wet.location = (group_node.location.x + 300, group_node.location.y - 900)
    power = wet_color_node(tree, (wet.location.x - 250, wet.location.y))
    tree.links.new(bakes['Color Bake'], power.inputs['Color'])
    tree.links.new(power.outputs['Color'], wet.inputs['Base Color'])
    wet.inputs['Specular IOR Level'].default_value = WET_SPECULAR
    for bake, inp in (('Roughness Bake', 'Roughness'), ('Metallic Bake', 'Metallic')):
        if bake in bakes:
            tree.links.new(bakes[bake], wet.inputs[inp])
    if normal:
        tree.links.new(normal, wet.inputs['Normal'])
    tree.links.new(wet.outputs[0], node.inputs['Wet Shader'])
    node.inputs['Use Wet Shader'].default_value = 1.0


EXPOSE_PREFIX = "OCW "   # グループに足す出力の名前の頭（ここから中の Principled の値を外へ出す）
# 外へ出す Principled の入力と、そのためのソケットの型
EXPOSE_INPUTS = (("Base Color", 'NodeSocketColor'), ("Roughness", 'NodeSocketFloat'),
                 ("Metallic", 'NodeSocketFloat'), ("Normal", 'NodeSocketVector'))


def _active_group_output(tree):
    return next((n for n in tree.nodes if n.type == 'GROUP_OUTPUT' and n.is_active_output), None)


def inner_principled(group_node, out_socket, depth=0):
    """group_node の out_socket（シェーダー）の元になっている Principled を、グループの中（入れ子も）から探す
    戻り値: [(Principled, [途中の入れ子のグループノード…])]。Mix/Add Shader・Reroute はたどる"""
    tree = group_node.node_tree
    go = _active_group_output(tree) if tree else None
    if go is None or depth > 6:
        return []
    idx = list(group_node.outputs).index(out_socket)
    if idx >= len(go.inputs):
        return []
    found, seen, stack = [], set(), [go.inputs[idx]]
    while stack:
        sock = stack.pop()
        for link in sock.links:
            n = link.from_node
            if n.as_pointer() in seen:
                continue
            seen.add(n.as_pointer())
            if n.type == 'BSDF_PRINCIPLED':
                found.append((n, []))
            elif n.type == 'GROUP' and n.node_tree:
                found += [(pr, [n] + path) for pr, path in inner_principled(n, link.from_socket, depth + 1)]
            else:
                stack += [i for i in n.inputs if i.type == 'SHADER']
    return found


def _expose(group_node, path, name, kind, src):
    """グループの中のソケット src を、入れ子の各段に出力「OCW name」を足して、group_node の出力まで出す
    path は group_node の中から Principled のある木までの、入れ子のグループノードの並び"""
    levels = [group_node] + path          # levels[k] のグループの中に levels[k + 1] がある
    out_name = EXPOSE_PREFIX + name
    for gnode in reversed(levels):
        tree = gnode.node_tree
        if not any(it.item_type == 'SOCKET' and it.in_out == 'OUTPUT' and it.name == out_name
                   for it in tree.interface.items_tree):
            tree.interface.new_socket(out_name, in_out='OUTPUT', socket_type=kind)
        go = _active_group_output(tree)
        tree.links.new(src, go.inputs[out_name])
        src = gnode.outputs[out_name]
    return src


def connect_inner_principled(tree, node, group_node, out_socket):
    """ベイク出力のないグループ：中の Principled の色・ラフネス・メタリック・法線を、グループに出力を足して外へ出し、
    濡れた姿の Principled を外に組み立てる。中の Principled が1つのときだけ（2つ以上だと、どの色で暗くするか決められない）"""
    found = inner_principled(group_node, out_socket)
    if len(found) != 1:
        return False
    pr, path = found[0]
    wet = tree.nodes.new('ShaderNodeBsdfPrincipled')
    wet.name = HELPER_PREFIX + "wet_bsdf"
    wet.label = "Wet (from group)"
    wet.inputs['Specular IOR Level'].default_value = WET_SPECULAR
    power = wet_color_node(tree, (0, 0))
    tree.links.new(power.outputs['Color'], wet.inputs['Base Color'])
    for name, kind in EXPOSE_INPUTS:
        inp = pr.inputs[name]
        if inp.is_linked:
            outer = _expose(group_node, path, name, kind, inp.links[0].from_socket)
        elif name == "Normal":
            continue                      # つながっていなければ今の法線のまま
        else:
            outer = None
        target = power.inputs['Color'] if name == "Base Color" else wet.inputs[name]
        if outer is not None:
            tree.links.new(outer, target)
        else:
            target.default_value = inp.default_value
        if name == "Normal" and outer is not None:
            tree.links.new(outer, node.inputs['Normal'])
            node.inputs['Use Normal'].default_value = 1.0
    tree.links.new(wet.outputs[0], node.inputs['Wet Shader'])
    node.inputs['Use Wet Shader'].default_value = 1.0
    return True


def _outer_input(tree, inp, ctx, tag, kind):
    """ctx の木の中の入力 inp の値を、マテリアルの木で使える形で返す：つながっていればソケット（グループの中なら外へ出す）、
    つながっていなければ None（呼ぶ側で default_value を写す）
    ctx は None（マテリアル直下）か (いちばん外のグループノード, 途中の入れ子のグループノード…)"""
    if not inp.is_linked:
        return None
    src = inp.links[0].from_socket
    if ctx is None:
        return src
    group_node, path = ctx
    return _expose(group_node, path, tag, kind, src)


def _rebuild_wet(tree, sock, ctx, state):
    """シェーダーの木を sock からたどって、同じ形の「濡れた姿」の木をマテリアルの木に組み直す
    Principled → 濡れた姿の Principled／Mix・Add Shader → 同じ形で混ぜ直す／入れ子のグループ → 中へ／
    Transparent → そのまま透明／それ以外の BSDF → 黒（暗くするだけ）。戻り値は組み直したシェーダーの出力"""
    n = sock.node
    tag_base = "/".join([g.name for g in (ctx[1] if ctx else [])] + [n.name])
    # 同じノードが何本もの Mix から使われていることがある（Procedural Old Wall では2つの Principled が7か所）。一度作ったら使い回す
    key = (tuple(g.as_pointer() for g in ([ctx[0]] + ctx[1] if ctx else [])), n.as_pointer(), sock.identifier)
    memo = state.setdefault('memo', {})
    if key in memo:
        return memo[key]
    memo[key] = result = _rebuild_wet_node(tree, sock, n, ctx, state, tag_base)
    return result


def _rebuild_wet_node(tree, sock, n, ctx, state, tag_base):
    if n.type == 'REROUTE':
        return _rebuild_wet(tree, n.inputs[0].links[0].from_socket, ctx, state) if n.inputs[0].is_linked else None
    if n.type == 'GROUP' and n.node_tree:
        go = _active_group_output(n.node_tree)
        idx = list(n.outputs).index(sock)
        if go is None or idx >= len(go.inputs) or not go.inputs[idx].is_linked:
            return None
        inner_ctx = (n, []) if ctx is None else (ctx[0], ctx[1] + [n])
        return _rebuild_wet(tree, go.inputs[idx].links[0].from_socket, inner_ctx, state)
    if n.type == 'BSDF_PRINCIPLED':
        wet = tree.nodes.new('ShaderNodeBsdfPrincipled')
        wet.name = HELPER_PREFIX + "wet_bsdf"
        wet.label = f"Wet ({n.name})"
        wet.inputs['Specular IOR Level'].default_value = WET_SPECULAR
        power = wet_color_node(tree, (0, 0))
        tree.links.new(power.outputs['Color'], wet.inputs['Base Color'])
        for name, kind in EXPOSE_INPUTS + (("Alpha", 'NodeSocketFloat'),):
            inp = n.inputs[name]
            target = power.inputs['Color'] if name == "Base Color" else wet.inputs[name]
            outer = _outer_input(tree, inp, ctx, f"{tag_base} {name}", kind)
            if outer is not None:
                tree.links.new(outer, target)
                if name == "Normal" and state.get('normal') is None:
                    state['normal'] = outer      # 水膜の法線は、最初に見つかった Principled のもの
            elif name != "Normal":
                target.default_value = inp.default_value
        return wet.outputs[0]
    if n.type in ('MIX_SHADER', 'ADD_SHADER'):
        offset = 1 if n.type == 'MIX_SHADER' else 0
        parts = []
        for i in (offset, offset + 1):
            inp = n.inputs[i]
            parts.append(_rebuild_wet(tree, inp.links[0].from_socket, ctx, state) if inp.is_linked else None)
        m = tree.nodes.new('ShaderNodeMixShader' if n.type == 'MIX_SHADER' else 'ShaderNodeAddShader')
        m.name = HELPER_PREFIX + "wet_mix"
        if n.type == 'MIX_SHADER':
            fac = _outer_input(tree, n.inputs[0], ctx, f"{tag_base} Fac", 'NodeSocketFloat')
            if fac is not None:
                tree.links.new(fac, m.inputs[0])
            else:
                m.inputs[0].default_value = n.inputs[0].default_value
        for i, part in zip((offset, offset + 1), parts):
            if part is not None:
                tree.links.new(part, m.inputs[i])
        return m.outputs[0]
    leaf = tree.nodes.new('ShaderNodeBsdfTransparent' if n.type == 'BSDF_TRANSPARENT' else 'ShaderNodeBsdfDiffuse')
    leaf.name = HELPER_PREFIX + "wet_leaf"
    if n.type != 'BSDF_TRANSPARENT':
        leaf.inputs['Color'].default_value = (0, 0, 0, 1)   # Principled 以外は黒で暗くするだけ
    return leaf.outputs[0]


def connect_rebuilt(tree, node, src):
    """Principled が複数ある素材（マテリアル直下の Mix Shader、中に Principled が2つ以上あるグループ）を、
    同じ形の濡れた姿に組み直して Wet Shader につなぐ"""
    state = {}
    wet = _rebuild_wet(tree, src, None, state)
    if wet is None:
        return False
    tree.links.new(wet, node.inputs['Wet Shader'])
    node.inputs['Use Wet Shader'].default_value = 1.0
    if state.get('normal') is not None and not node.inputs['Normal'].is_linked:
        tree.links.new(state['normal'], node.inputs['Normal'])
        node.inputs['Use Normal'].default_value = 1.0
    return True


def cleanup_exposed():
    """どこからも使われなくなった「OCW ～」出力をグループから外す（入れ子は外側から順に空くので、変化がなくなるまで繰り返す）"""
    trees = [m.node_tree for m in bpy.data.materials if m.node_tree] + list(bpy.data.node_groups)
    changed = True
    while changed:
        changed = False
        used = set()
        for t in trees:
            for link in t.links:
                n = link.from_node
                if n.type == 'GROUP' and n.node_tree and link.from_socket.name.startswith(EXPOSE_PREFIX):
                    used.add((n.node_tree.name, link.from_socket.identifier))
        for g in bpy.data.node_groups:
            for it in list(g.interface.items_tree):
                if (it.item_type == 'SOCKET' and it.in_out == 'OUTPUT' and it.name.startswith(EXPOSE_PREFIX)
                        and (g.name, it.identifier) not in used):
                    g.interface.remove(it)
                    changed = True


FRAME_NAME = HELPER_PREFIX + "frame"
WET_NODE_GAP = 300   # 濡れノードを置くために Material Output を右へずらす量


def used_outputs(tree):
    """レンダーで実際に使われる Material Output（Cycles 用と Eevee 用。同じ1つのことが多い）
    Blender は、対象（All / Cycles / Eevee）が合う出力のうちアクティブなものを使う。それ以外は挟まない"""
    outs = []
    for target in ('CYCLES', 'EEVEE'):
        o = tree.get_output_node(target)
        if o and o not in outs and o.inputs['Surface'].is_linked:
            outs.append(o)
    return outs


def _abs_location(n):
    return tuple(n.location_absolute)


def _place(n, x, y, frame):
    """n をフレームに入れて、絶対座標 (x, y) に置く（フレームの中の location はフレームからの相対）"""
    n.parent = frame
    n.location_absolute = (x, y)


# ドロップダウン（演算の種類など）が1段ぶん付くノード
_NODES_WITH_MENU = {'MATH', 'VECT_MATH', 'TANGENT', 'MIX', 'MAP_RANGE', 'VECT_TRANSFORM', 'TEX_NOISE',
                    'DISPLACEMENT', 'NORMAL_MAP', 'TEX_IMAGE', 'TEX_VORONOI'}


def _est_height(n, use_drawn=True):
    """ノードの高さ。一度でも描画されていれば Blender の実寸、まだなら（バックグラウンドや足したばかりのノード）
    ソケット・値の欄・パネルの数から見積もる（2026-10-20 に GUI で実寸と照らし合わせた）"""
    if use_drawn and n.dimensions.y > 0:
        return n.dimensions.y / max(bpy.context.preferences.system.ui_scale, 0.1)
    if n.type == 'BSDF_PRINCIPLED':
        return 380                       # パネルが閉じた状態
    h = 36 + (28 if n.type in _NODES_WITH_MENU else 0)
    h += 22 * sum(1 for o in n.outputs if o.enabled and not o.hide)
    for i in n.inputs:
        if not i.enabled or i.hide:
            continue
        unlinked_vector = (not i.is_linked and i.type == 'VECTOR' and not i.hide_value
                           and hasattr(i, 'default_value') and len(i.default_value) == 3)
        h += 88 if unlinked_vector else 22   # つながっていないベクトルは X・Y・Z の3段で出る
    if n.type == 'GROUP' and n.node_tree:
        h += 30 * sum(1 for it in n.node_tree.interface.items_tree if it.item_type == 'PANEL')
    return h


def tidy(tree):
    """足した補助ノードを「One Click Wet」フレームにまとめ、元のノードの下に流れの順で並べる
    左から：Normal Bake の復元 → 濡れた姿の色と Principled → ベクトル変位の補助"""
    helpers = [n for n in tree.nodes if n.name.startswith(HELPER_PREFIX) and n.name != FRAME_NAME]
    if not helpers:
        return
    frame = tree.nodes.get(FRAME_NAME)
    if frame is None:
        frame = tree.nodes.new('NodeFrame')
        frame.name = FRAME_NAME
    frame.label = "One Click Wet"
    frame.label_size = 20
    frame.shrink = True
    others = [n for n in tree.nodes if not n.name.startswith(HELPER_PREFIX)
              and n.type != 'FRAME' and not is_wet_node(n)]
    # 横位置は濡らした元のシェーダー（濡れノードの Shader につながっているノード）の真下から始める
    sources = [w.inputs['Shader'].links[0].from_node for w in tree.nodes
               if is_wet_node(w) and w.inputs['Shader'].is_linked]
    if others:
        left = min(_abs_location(n)[0] for n in (sources or others))
        top = min(_abs_location(n)[1] - _est_height(n) for n in others) - 150
    else:
        left, top = 0.0, 0.0
    # (ノード, 1列に1つずつ並べるか)
    groups = (
        ([n for n in helpers if n.name.startswith(HELPER_PREFIX + "nb_")], False),
        # 色の乗数（Gamma）→ 濡れた姿の Principled の順（流れが左から右になるように）
        (sorted((n for n in helpers if n.name.startswith(HELPER_PREFIX + "wet_")),
                key=lambda n: not n.name.startswith(HELPER_PREFIX + "wet_color")), True),
        ([n for n in helpers if not n.name.startswith((HELPER_PREFIX + "nb_", HELPER_PREFIX + "wet_"))], False),
    )
    x = left
    for nodes, one_per_column in groups:
        if not nodes:
            continue
        y, col_w = top, 0.0
        for n in nodes:
            h = _est_height(n)
            if y != top and (one_per_column or y - h < top - 720):   # 列がこれ以上長くなるなら右の列へ
                x += col_w + 40
                y, col_w = top, 0.0
            _place(n, x, y, frame)
            y -= h + 20
            col_w = max(col_w, n.width)
        x += col_w + 100


def _height_samples(mat, node, objects=None):
    """濡れノードの Height に入る値を Cycles で撮って返す（負の値も取れるように、正の部分を R、負の部分を G に分けて
    Emission にする：H = R − G）
    objects があれば、そのオブジェクトのコピー（モディファイアもそのまま）を一時シーンに置いて前後・左右・上下の6方向から撮る。
    オブジェクト座標や UV で模様を付けた素材も、実物の上の分布になる。このマテリアル以外のスロットは透明にして数えない。
    objects がなければ、2m 四方の板（UV 0〜1）を真上から撮る"""
    import os
    import tempfile
    path = os.path.join(tempfile.gettempdir(), f"ocw_height_{os.getpid()}.exr")
    tmp = mat.copy()
    made = []          # 後片付けするデータブロック
    try:
        nt = tmp.node_tree
        src = nt.nodes[node.name].inputs['Height'].links[0].from_socket
        pos = nt.nodes.new('ShaderNodeMath'); pos.operation = 'MAXIMUM'
        neg = nt.nodes.new('ShaderNodeMath'); neg.operation = 'MINIMUM'
        nt.links.new(src, pos.inputs[0]); pos.inputs[1].default_value = 0.0
        nt.links.new(src, neg.inputs[0]); neg.inputs[1].default_value = 0.0
        flip = nt.nodes.new('ShaderNodeMath'); flip.operation = 'MULTIPLY'
        nt.links.new(neg.outputs[0], flip.inputs[0]); flip.inputs[1].default_value = -1.0
        rg = nt.nodes.new('ShaderNodeCombineXYZ')
        nt.links.new(pos.outputs[0], rg.inputs[0]); nt.links.new(flip.outputs[0], rg.inputs[1])
        em = nt.nodes.new('ShaderNodeEmission')
        nt.links.new(rg.outputs[0], em.inputs['Color'])
        out = nt.nodes.new('ShaderNodeOutputMaterial')
        out.target = 'CYCLES'
        nt.links.new(em.outputs[0], out.inputs['Surface'])
        out.is_active_output = True
        if nt.get_output_node('CYCLES') != out:
            return None
        tmp.displacement_method = 'BUMP'

        scene = bpy.data.scenes.new("OCW_calib"); made.append(scene)
        cam_data = bpy.data.cameras.new("OCW_calib"); made.append(cam_data)
        cam_data.type = 'ORTHO'
        cam = bpy.data.objects.new("OCW_calib_cam", cam_data); made.append(cam)
        scene.collection.objects.link(cam)
        scene.camera = cam
        objects = [o for o in (objects or []) if o.type == 'MESH'][:3]
        if objects:
            # 実物のコピー（メッシュは共有、モディファイアもそのまま）。スロットはオブジェクト側に切り替えて、
            # このマテリアルのスロットだけ測る用のマテリアル、ほかは透明にする（元のメッシュには触らない）
            hide = bpy.data.materials.new("OCW_calib_hide"); made.append(hide)
            hide.use_nodes = True
            hnt = hide.node_tree
            for n in list(hnt.nodes):
                if n.type != 'OUTPUT_MATERIAL':
                    hnt.nodes.remove(n)
            hnt.links.new(hnt.nodes.new('ShaderNodeBsdfTransparent').outputs[0],
                          next(n for n in hnt.nodes if n.type == 'OUTPUT_MATERIAL').inputs['Surface'])
            corners = []
            for src_ob in objects:
                ob = src_ob.copy(); made.append(ob)
                ob.parent = None
                ob.matrix_world = src_ob.matrix_world.copy()
                ob.animation_data_clear()
                for slot in ob.material_slots:
                    is_target = slot.material == mat
                    slot.link = 'OBJECT'
                    slot.material = tmp if is_target else hide
                scene.collection.objects.link(ob)
                corners += [src_ob.matrix_world @ Vector(c) for c in src_ob.bound_box]
            lo = Vector([min(c[i] for c in corners) for i in range(3)])
            hi = Vector([max(c[i] for c in corners) for i in range(3)])
            center, size = (lo + hi) / 2, max((hi - lo).length, 1e-3)
            views = [(Vector(d), size * 1.05) for d in ((1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1))]
            res = 96
        else:
            mesh = bpy.data.meshes.new("OCW_calib"); made.append(mesh)
            mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [], [(0, 1, 2, 3)])
            uv = mesh.uv_layers.new()
            for loop, co in zip(uv.data, ((0, 0), (1, 0), (1, 1), (0, 1))):
                loop.uv = co
            mesh.materials.append(tmp)
            ob = bpy.data.objects.new("OCW_calib", mesh); made.append(ob)
            scene.collection.objects.link(ob)
            center, size = Vector((0, 0, 0)), 2.0
            views = [(Vector((0, 0, 1)), 2.0)]
            res = 64
        r = scene.render
        r.engine = 'CYCLES'
        scene.cycles.samples = 1
        scene.cycles.use_denoising = False
        r.resolution_x = r.resolution_y = res
        r.resolution_percentage = 100
        r.film_transparent = True
        r.filter_size = 0.01
        r.image_settings.file_format = 'OPEN_EXR'
        r.image_settings.color_depth = '32'
        scene.view_settings.view_transform = 'Standard'
        r.filepath = path
        samples = []
        for direction, scale in views:
            cam_data.ortho_scale = scale
            cam_data.clip_end = size * 4
            cam.location = center + direction * size * 2
            cam.rotation_euler = (-direction).to_track_quat('-Z', 'Y').to_euler()
            bpy.ops.render.render(write_still=True, scene=scene.name)
            img = bpy.data.images.load(path, check_existing=False)
            px = img.pixels[:]
            bpy.data.images.remove(img)
            samples += [px[i] - px[i + 1] for i in range(0, len(px), 4) if px[i + 3] > 0.5]
        return sorted(samples)
    except Exception as e:  # 測れなければ高さマスクを使わない（濡らすこと自体は続ける）
        print("One Click Wet: height calibration failed:", e)
        return None
    finally:
        for block in reversed(made):
            coll = {bpy.types.Scene: bpy.data.scenes, bpy.types.Object: bpy.data.objects,
                    bpy.types.Camera: bpy.data.cameras, bpy.types.Mesh: bpy.data.meshes,
                    bpy.types.Image: bpy.data.images, bpy.types.Material: bpy.data.materials}[type(block)]
            coll.remove(block)
        bpy.data.materials.remove(tmp)
        if os.path.exists(path):
            os.remove(path)


def calibrate_height(mat, node, objects=None):
    """素材の高さの分布を測って、濡れノードの Midlevel・Height Gain を合わせる
    高さを「中央値 = 0、低いほうから 25〜75% が −0.5〜+0.5」にそろえる。Pool Softness・Peak Dryness はこの単位。
    あわせて 0〜100% の高さの表を覚え、Pool Area（面積の割合）から水面の高さ（Pool Height）を決める。
    高さの値の範囲は素材ごとにまちまちで（2026-10-20 に Sanctus 6 種・BlenderKit 4 種で測ったら中央値が −0.05〜4.8、
    Sanctus は全部が Midlevel より上）、決め打ちの基準では水たまりができない素材が多かったため。
    測れない・高さに幅がないときは高さマスクを使わない"""
    if not node.inputs['Height'].is_linked:
        return False
    hs = _height_samples(mat, node, objects)
    if not hs or len(hs) < 100:
        node.inputs['Use Height'].default_value = 0.0
        return False
    q = lambda f: hs[min(len(hs) - 1, int(f * len(hs)))]
    iqr = q(0.75) - q(0.25)
    if iqr < 1e-6:
        node.inputs['Use Height'].default_value = 0.0
        return False
    node.inputs['Midlevel'].default_value = q(0.5)
    node.inputs['Height Gain'].default_value = 1.0 / iqr
    node.inputs['Use Height'].default_value = 1.0
    # 0〜100% の 101 点の高さを覚えておき、Pool Area を変えたときに水面の高さを計算し直す
    node["ocw_quantiles"] = [q(i / 100) for i in range(101)]
    update_pool_height(mat)
    return True


def _quantile(table, f):
    """101 点のパーセンタイル表から、割合 f（0〜1）の高さを直線補間で返す"""
    x = max(0.0, min(1.0, f)) * 100
    i = min(int(x), 99)
    return table[i] + (table[i + 1] - table[i]) * (x - i)


def update_pool_height(mat):
    """マテリアルの Pool Area から、濡れノードの水面の高さ（Pool Height）を決める。0 なら水たまりを作らない"""
    if not mat.node_tree:
        return
    for node in mat.node_tree.nodes:
        if not (is_wet_node(node) and "ocw_quantiles" in node and 'Pool Height' in node.inputs):
            continue
        table = list(node["ocw_quantiles"])
        area = mat.ocw_pool_area
        if area <= 0.0:
            node.inputs['Pool Height'].default_value = -1e4
        else:
            node.inputs['Pool Height'].default_value = _quantile(table, area)


def _on_pool_area(mat, context):
    update_pool_height(mat)


def set_mode(node, mode):
    m = MODES[mode]
    for name in MODE_KEYS:
        node.inputs[name].default_value = m[name]
    node["ocw_mode"] = mode
    node.label = f"Wet ({node['ocw_profile_label']}, {m['label']})"


def plan_alpha(surface, reasons):
    """透過の理由が「形を抜いているだけ」なら、Alpha の取り出し方を返す（濡らせる）。ガラス・水などは None（濡らさない）
    ('inner', グループノード, 出力) ：グループの中の Principled が1つで、その Alpha で抜いている（Sanctus の穴あき素材など）
    ('mix', Mix Shader, Transparent の入力番号) ：マテリアル直下で Transparent BSDF と Mix Shader で混ぜている（葉っぱのカードなど）"""
    if not surface.is_linked:
        return None
    src = surface.links[0].from_socket
    n = src.node
    if n.type == 'GROUP' and n.node_tree:
        found = inner_principled(n, src)
        if len(found) == 1 and reasons == [found[0][0].name + " (Alpha)"]:
            return ('inner', n, src)
    if n.type == 'MIX_SHADER':
        for idx in (1, 2):
            inp = n.inputs[idx]
            if (inp.is_linked and inp.links[0].from_node.type == 'BSDF_TRANSPARENT'
                    and reasons == [inp.links[0].from_node.name]):
                return ('mix', n, idx)
    return None


def connect_alpha_plan(tree, node, plan):
    """plan_alpha の取り出し方で、濡れノードの Alpha に「形の抜き」をつなぐ（透明なところは透明のまま濡らす）"""
    kind, n, extra = plan
    alpha = node.inputs['Alpha']
    if kind == 'inner':
        pr, path = inner_principled(n, extra)[0]
        a = pr.inputs['Alpha']
        if a.is_linked:
            tree.links.new(_expose(n, path, "Alpha", 'NodeSocketFloat', a.links[0].from_socket), alpha)
        else:
            alpha.default_value = a.default_value
        return
    # Mix Shader：Fac は「2番目の入力の割合」。Transparent が2番目なら Alpha = 1 − Fac
    fac = n.inputs[0]
    if extra == 1:
        if fac.is_linked:
            tree.links.new(fac.links[0].from_socket, alpha)
        else:
            alpha.default_value = fac.default_value
    else:
        if fac.is_linked:
            inv = tree.nodes.new('ShaderNodeMath')
            inv.name = HELPER_PREFIX + "alpha"
            inv.operation = 'SUBTRACT'
            inv.inputs[0].default_value = 1.0
            tree.links.new(fac.links[0].from_socket, inv.inputs[1])
            tree.links.new(inv.outputs[0], alpha)
        else:
            alpha.default_value = 1.0 - fac.default_value


def apply_wet(mat, key, mode='SOAKED', objects=None):
    """濡れノードを挟む。すでに濡れていればプロファイルだけ差し替える
    戻り値: (濡らしたか, 濡らせなかった理由のリスト)"""
    tree = mat.node_tree
    outs = used_outputs(tree)
    # 透明・ガラスなどは、挟むと不透明になるので何も変えずにやめる
    reasons, alpha_plans = [], {}
    for out in outs:
        if not is_wet_node(out.inputs['Surface'].links[0].from_node):
            r = inspect_surface(out.inputs['Surface'])[2]
            plan = plan_alpha(out.inputs['Surface'], r) if r else None
            if plan:
                alpha_plans[out.name] = plan   # 形を抜いているだけ：Alpha を取り出して濡らす
            else:
                reasons += r
    if reasons:
        return False, reasons
    # 古い版のグループで濡れていたら、いったん外して挿し直す
    if any(is_wet_node(n) and n.node_tree.get(TAG) != GROUP_VERSION for n in tree.nodes):
        remove_wet(mat)
        return apply_wet(mat, key, mode, objects)
    done = False
    for out in outs:
        surf = out.inputs['Surface']
        link = surf.links[0]
        if is_wet_node(link.from_node):
            set_profile(link.from_node, key)
            set_mode(link.from_node, mode)
            done = True
            continue
        alpha_bsdf, normal_node, _ = inspect_surface(surf)
        src = link.from_socket
        bsdf = src.node if src.node.type == 'BSDF_PRINCIPLED' else None
        node = tree.nodes.new('ShaderNodeGroup')
        node.node_tree = get_wet_group()
        # 濡れノードは Material Output があった場所に置き、Material Output を右へずらす（解除で戻す）
        node["ocw_output_location"] = tuple(out.location)
        node.location = tuple(out.location)
        out.location.x += WET_NODE_GAP
        set_profile(node, key)
        tree.links.remove(link)
        tree.links.new(src, node.inputs['Shader'])
        tree.links.new(node.outputs['Shader'], surf)
        connect_height(tree, out, node)
        if (not calibrate_height(mat, node, objects) and node.get("ocw_height_from") != "bump"
                and node.inputs['Height'].is_linked):
            # Displacement はつながっているが高さに幅がない（Sanctus の concrete など）：Bump の高さに切り替える
            _unroute_height(tree, node)
            if connect_bump_height(tree, node):
                calibrate_height(mat, node, objects)
        if bsdf:
            # Principled が直接つながっているときだけ。Mix Shader の先などでは、ほかのシェーダーまで置き換わるので黒で暗くする
            connect_wet_bsdf(tree, node, bsdf)
        elif src.node.type == 'GROUP' and normal_node is None:
            if any(o.name == "Color Bake" for o in src.node.outputs):
                connect_bake_outputs(tree, node, src.node)
            elif not connect_inner_principled(tree, node, src.node, src):
                connect_rebuilt(tree, node, src)       # 中に Principled が2つ以上
        elif src.node.type in ('MIX_SHADER', 'ADD_SHADER'):
            connect_rebuilt(tree, node, src)           # マテリアル直下で混ぜている
        set_profile(node, key)  # 補助ノード（色の乗数）にもプロファイルを入れる
        set_mode(node, mode)
        connect_surface(tree, node, alpha_bsdf, normal_node)
        if out.name in alpha_plans:
            connect_alpha_plan(tree, node, alpha_plans[out.name])
        done = True
    tidy(tree)
    return done, []


def _bypass(tree, node, inp, outp):
    """node を外したときに inp の接続元を outp の接続先へつなぎ直す（node 自体はまだ消さない）"""
    if not (inp and outp and inp.is_linked):
        return
    src = inp.links[0].from_socket
    for d in [l.to_socket for l in outp.links]:
        tree.links.new(src, d)


def remove_wet(mat):
    tree = mat.node_tree
    done = False
    for node in [n for n in tree.nodes if is_wet_node(n)]:
        if "ocw_output_location" in node:   # ずらした Material Output を元の場所へ
            for link in node.outputs['Shader'].links:
                if link.to_node.type == 'OUTPUT_MATERIAL':
                    link.to_node.location = tuple(node["ocw_output_location"])
        _bypass(tree, node, node.inputs['Shader'], node.outputs['Shader'])
        _bypass(tree, node, node.inputs.get('Height'), node.outputs.get('Height'))  # 古い版には Height 出力がない
        tree.nodes.remove(node)
        done = True
    helpers = [n for n in tree.nodes if n.name.startswith(HELPER_PREFIX)]
    for node in helpers:
        if node.name.startswith(PASS_NAME):
            _bypass(tree, node, node.inputs[0], node.outputs[0])
    for node in helpers:
        tree.nodes.remove(node)
    cleanup_exposed()
    return done


PROFILE_ITEMS = [(k, v["label"], "") for k, v in PROFILES.items()]
MODE_ITEMS = [
    ('SOAKED', "Soaked", "Wet all over (splashed or pulled out of water)"),
    ('RAIN', "Rain", "Rain: faces pointing up get wet, vertical faces get drip streaks, faces pointing down (under eaves) stay dry"),
    ('GROUND', "Ground", "Ground only: wet up to 0.4 m above the Ground Height"),
]


def _get_object_wetness(ob):
    return 1.0 - ob.get(DRY_ATTR, 0.0)


def record_top(ob):
    """オブジェクトの一番上の高さ（ローカル Z）を記録する（雨の筋を上の縁から垂らすため）"""
    if ob.type == 'MESH':
        ob[TOP_ATTR] = max(c[2] for c in ob.bound_box)
        ob.update_tag()


def _get_ground(sc):
    return sc.get(GROUND_ATTR, 0.0)


def _set_ground(sc, value):
    sc[GROUND_ATTR] = value
    sc.update_tag()


class OCW_OT_pick_ground(bpy.types.Operator):
    bl_idname = "ocw.pick_ground"
    bl_label = "Pick Ground"
    bl_description = "Set the Ground Height to the lowest point of the active object (terrain or floor)"
    bl_options = {'REGISTER', 'UNDO'}

    @classmethod
    def poll(cls, context):
        return context.object is not None

    def execute(self, context):
        ob = context.object
        z = min((ob.matrix_world @ Vector(c)).z for c in ob.bound_box)
        context.scene.ocw_ground = z
        self.report({'INFO'}, f"Ground Height = {z:.3f} m (bottom of {ob.name})")
        return {'FINISHED'}


def _get_scene_wetness(sc):
    return 1.0 - sc.get(SCENE_DRY_ATTR, 0.0)


def _set_scene_wetness(sc, value):
    # アニメーションの再生中も呼ばれる（キーフレームを打てる）。シェーダーの Attribute（View Layer）が読む
    sc[SCENE_DRY_ATTR] = 1.0 - value
    sc.update_tag()


def _set_object_wetness(ob, value):
    # シェーダーの Attribute ノード（Object）は、カスタムプロパティ "ocw_dry" を読む
    ob[DRY_ATTR] = 1.0 - value
    ob.update_tag()


class OCW_OT_apply(bpy.types.Operator):
    bl_idname = "ocw.apply_wet"
    bl_label = "Make Wet"
    bl_description = "Make the materials of the selected objects wet (already wet ones get the new profile)"
    bl_options = {'REGISTER', 'UNDO'}

    profile: bpy.props.EnumProperty(items=PROFILE_ITEMS, name="Profile")
    mode: bpy.props.EnumProperty(items=MODE_ITEMS, name="Mode")

    def execute(self, context):
        n, skipped = 0, []
        for m in target_materials(context):
            users = [o for o in context.selected_objects
                     if any(sl.material == m for sl in getattr(o, "material_slots", []))]
            done, reasons = apply_wet(m, self.profile, self.mode, users)
            for o in users:
                record_top(o)
            n += done
            if reasons:
                skipped.append(f"{m.name} ({', '.join(reasons)})")
        if skipped:
            self.report({'WARNING'}, f"{n} material(s) made wet. Skipped because they use transparency or glass: "
                        + " / ".join(skipped))
        else:
            self.report({'INFO'}, f"{n} material(s) made wet")
        return {'FINISHED'}


class OCW_OT_remove(bpy.types.Operator):
    bl_idname = "ocw.remove_wet"
    bl_label = "Remove Wet"
    bl_description = "Remove the wet nodes and restore the original connections"
    bl_options = {'REGISTER', 'UNDO'}

    def execute(self, context):
        n = sum(remove_wet(m) for m in target_materials(context))
        self.report({'INFO'}, f"{n} material(s) restored")
        return {'FINISHED'}


class OCW_PT_panel(bpy.types.Panel):
    bl_label = "One Click Wet"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "Wet"

    def draw(self, context):
        # 素材が増えたので縦一列ではなく3列に並べる
        grid = self.layout.grid_flow(row_major=True, columns=3, even_columns=True, align=True)
        for key in PROFILES:
            grid.prop_enum(context.scene, "ocw_profile", key)
        self.layout.row(align=True).prop(context.scene, "ocw_mode", expand=True)
        # シーン全体の濡れ具合：濡らしたマテリアルすべてにかかる。キーフレームを打てば乾いていくアニメーションになる
        self.layout.prop(context.scene, "ocw_wetness", slider=True)
        # 地面の高さ：Rain の跳ね返り・Ground の濡れる範囲はここから測る
        row = self.layout.row(align=True)
        row.prop(context.scene, "ocw_ground")
        row.operator(OCW_OT_pick_ground.bl_idname, text="", icon='EYEDROPPER')
        col = self.layout.column(align=True)
        op = col.operator(OCW_OT_apply.bl_idname, icon='MOD_FLUIDSIM')
        op.profile = context.scene.ocw_profile
        op.mode = context.scene.ocw_mode
        col.operator(OCW_OT_remove.bl_idname, icon='X')

        ob = context.object
        if ob:
            self.layout.prop(ob, "ocw_wetness", slider=True)
        mat = ob.active_material if ob else None
        if not (mat and mat.node_tree):
            return
        node = next((n for n in mat.node_tree.nodes if is_wet_node(n)), None)
        if node:
            box = self.layout.box()
            box.label(text=f"{mat.name}: {node.label}")
            if node.node_tree.get(TAG) != GROUP_VERSION:
                box.label(text="Made with an older version. Update with Make Wet", icon='ERROR')
                return
            if node.inputs['Use Height'].default_value < 0.5:
                box.label(text="No height found: no puddles or drying pattern", icon='INFO')
            for name in TWEAK_KEYS + MODE_KEYS:
                s = node.inputs[name]
                if not s.is_linked:
                    box.prop(s, "default_value", text=name)
            box.prop(mat, "ocw_pool_area", slider=True)
            power = wet_color_nodes(mat.node_tree)
            if power:
                if power[0].type == 'GROUP':
                    box.prop(power[0].inputs['Power'], "default_value", text="Wet Color Power")
                    box.prop(power[0].inputs['Bright Darkening'], "default_value", text="Bright Darkening")


classes = (OCW_OT_apply, OCW_OT_remove, OCW_OT_pick_ground, OCW_PT_panel)


def register():
    for c in classes:
        bpy.utils.register_class(c)
    bpy.types.Scene.ocw_profile = bpy.props.EnumProperty(items=PROFILE_ITEMS, name="Profile")
    bpy.types.Scene.ocw_mode = bpy.props.EnumProperty(items=MODE_ITEMS, name="Mode")
    bpy.types.Material.ocw_pool_area = bpy.props.FloatProperty(
        name="Pool Area", description="Share of the surface that becomes puddles (lowest first). The water level comes from the material's height distribution",
        min=0.0, max=0.5, default=0.08, update=_on_pool_area)
    bpy.types.Scene.ocw_wetness = bpy.props.FloatProperty(
        name="Scene Wetness", description="Wetness of the whole scene (applies to every wet material; can be keyframed)",
        min=0.0, max=1.0, get=_get_scene_wetness, set=_set_scene_wetness)
    bpy.types.Scene.ocw_ground = bpy.props.FloatProperty(
        name="Ground Height", description="Height of the ground (m). Rain splashes and the Ground mode's wet band are measured from here",
        unit='LENGTH', get=_get_ground, set=_set_ground)
    bpy.types.Object.ocw_wetness = bpy.props.FloatProperty(
        name="Object Wetness", description="Wetness of this object (can differ per object even when they share a material)",
        min=0.0, max=1.0, get=_get_object_wetness, set=_set_object_wetness)


def unregister():
    del bpy.types.Material.ocw_pool_area
    del bpy.types.Object.ocw_wetness
    del bpy.types.Scene.ocw_wetness
    del bpy.types.Scene.ocw_ground
    del bpy.types.Scene.ocw_mode
    del bpy.types.Scene.ocw_profile
    for c in reversed(classes):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
