@tool
class_name PixelForgeAsset
extends Resource
## An imported pixel-forge animation set: atlases, frame regions, animations, markers and events.
##
## Built from the `.pxf` render cache only (FR-GD-02, FR-GD-05). The contract for every field and
## helper is docs/contracts/GODOT_INTEGRATION.md section 2. Frame indices are positions in `frames`;
## `markers`, `events` and `root_motion` are indexed the same way.

const _Reader := preload("pxf_reader.gd")

## Largest atlas side the packer will produce (a Godot texture limit is 16384).
const MAX_ATLAS_SIDE := 16384
## Preferred atlas width limit; a wider frame raises it.
const PREFERRED_ATLAS_WIDTH := 4096
const MAX_PADDING := 64

const DEFAULT_OPTIONS := {
	"animations": "",
	"skins": "",
	"trim": true,
	"padding": 1,
}

## One atlas per imported skin (`base` always). Every atlas has the same layout, so a frame's
## `region` is valid in all of them.
@export var atlases: Dictionary[StringName, Texture2D] = {}
## One entry per authored frame of every imported animation, in sorted group, direction, index
## order: `{region: Rect2i, offset_px: Vector2i, duration_ms: int}`. Equal images share a region.
@export var frames: Array[Dictionary] = []
## `{group: {direction: {frames: PackedInt32Array, loop: StringName, mirror: bool}}}`. An undirected
## animation uses the direction `default`. A mirror lists the frame indices of its source direction.
@export var animations: Dictionary = {}
## Per frame index: `{marker name: Vector2i}` in canvas pixels, as stored.
@export var markers: Array[Dictionary] = []
## Per frame index: event names in authored order.
@export var events: Array[PackedStringArray] = []
## Per frame index: `(dx, dy)` in canvas pixels, y down.
@export var root_motion: Array[Vector2i] = []
## The origin pixel (not the origin point; see the contract, section 1).
@export var origin: Vector2i = Vector2i.ZERO
## Pixels per metre.
@export var pixels_per_unit: float = 16.0
## Directions to try, in order, per requested direction.
@export var direction_fallback: Dictionary[StringName, PackedStringArray] = {}
## Size of every source frame, and so of an untrimmed region.
@export var canvas_size: Vector2i = Vector2i.ZERO
## Imported skin keys, `base` first.
@export var skins: PackedStringArray = PackedStringArray()


# ---------------------------------------------------------------------------------------------
# Helpers (contract section 2)
# ---------------------------------------------------------------------------------------------


## The entry the driver would play: tries `direction_fallback[direction]` in order (or `[direction]`
## when there is no entry), then `default`. Returns `{group, direction, frames, loop, mirror}` with
## `direction` the key actually found, or `{}` when the group has none of them.
func resolve(group: StringName, direction: StringName) -> Dictionary:
	var dirs: Variant = animations.get(group)
	if typeof(dirs) != TYPE_DICTIONARY:
		return {}
	var candidates: Array = []
	if direction_fallback.has(direction):
		candidates.append_array(direction_fallback[direction])
	else:
		candidates.append(direction)
	candidates.append(&"default")
	for candidate: Variant in candidates:
		var key := StringName(candidate)
		if (dirs as Dictionary).has(key):
			var entry: Dictionary = dirs[key]
			return {
				"group": group,
				"direction": key,
				"frames": entry["frames"],
				"loop": entry["loop"],
				"mirror": entry["mirror"],
			}
	return {}


## Whether `resolve(group, direction)` finds an entry. An empty `direction` asks whether the group
## has any entry at all.
func has_animation(group: StringName, direction: StringName = &"") -> bool:
	if direction == &"":
		var dirs: Variant = animations.get(group)
		return typeof(dirs) == TYPE_DICTIONARY and not (dirs as Dictionary).is_empty()
	return not resolve(group, direction).is_empty()


## Number of frames of the resolved entry, 0 when unresolved.
func frame_count(group: StringName, direction: StringName) -> int:
	var r := resolve(group, direction)
	return 0 if r.is_empty() else (r["frames"] as PackedInt32Array).size()


## Sum of `duration_ms` over one pass of the resolved entry, 0 when unresolved.
func duration_ms(group: StringName, direction: StringName) -> int:
	var r := resolve(group, direction)
	if r.is_empty():
		return 0
	var total := 0
	for i: int in r["frames"]:
		total += int(frames[i]["duration_ms"])
	return total


## Whether frame `frame_index` has the marker `name`.
func has_marker(frame_index: int, name: StringName) -> bool:
	return frame_index >= 0 and frame_index < markers.size() and markers[frame_index].has(name)


## The marker in pixels, y down, relative to the origin point `(origin.x + 0.5, origin.y + 1)`
## (contract section 6.1): `(s * (mx - ox), my - oy - 0.5)` with `s = -1` when `mirror`. An absent
## marker returns `Vector2.ZERO`; check `has_marker` first.
func marker_px(frame_index: int, name: StringName, mirror: bool) -> Vector2:
	if not has_marker(frame_index, name):
		return Vector2.ZERO
	var m: Vector2i = markers[frame_index][name]
	var s := -1.0 if mirror else 1.0
	return Vector2(s * float(m.x - origin.x), float(m.y - origin.y) - 0.5)


## The marker in metres, y up, relative to the origin point (contract section 6.1):
## `(s * (mx - ox), oy + 0.5 - my) / pixels_per_unit`. Absent markers return `Vector2.ZERO`.
func marker_metres(frame_index: int, name: StringName, mirror: bool) -> Vector2:
	if not has_marker(frame_index, name):
		return Vector2.ZERO
	var px := marker_px(frame_index, name, mirror)
	return Vector2(px.x, -px.y) / pixels_per_unit


# ---------------------------------------------------------------------------------------------
# Building
# ---------------------------------------------------------------------------------------------


## Builds an asset from an open `PixelForgePxfReader`.
##
## `options` (missing keys use `DEFAULT_OPTIONS`):
## - `animations`: comma-separated `group` or `group/direction` names to import; empty means all.
##   The source direction of an imported mirror is imported too.
## - `skins`: comma-separated skin names to import; empty means all. `base` is always imported.
## - `trim`: crop each frame to its opaque pixels, shared by all skins (a frame is cropped to the
##   union of the skins' opaque pixels). A fully transparent frame becomes a 1x1 region.
## - `padding`: transparent pixels around every region in the atlas, 0 to `MAX_PADDING`.
##
## Returns null on failure. `report` receives `errors` and `warnings` (arrays of strings).
static func build(reader: _Reader, options: Dictionary = {}, report: Dictionary = {}) -> PixelForgeAsset:
	var errors: Array[String] = []
	var warnings: Array[String] = []
	report["errors"] = errors
	report["warnings"] = warnings
	if reader == null or not reader.is_open():
		errors.append("the .pxf reader is not open")
		return null
	var opts := _normalise_options(options)
	var index: Dictionary = reader.index

	var skin_keys := _select_skins(index, opts["skins"], warnings)
	var picked := _pick(index, opts["animations"], warnings)
	var entries := _entries(index, picked, false)
	if entries.is_empty():
		errors.append("no animation with frames matches the 'animations' option")
		return null

	# Unique images in first-use order: a path may be shared by several frames and animations.
	var image_paths: PackedStringArray = PackedStringArray()
	var image_slot: Dictionary = {}
	for e: Dictionary in entries:
		for f: Dictionary in e["frames"]:
			var path: String = f["image"]
			if not image_slot.has(path):
				image_slot[path] = image_paths.size()
				image_paths.append(path)

	# Pass 1: canvas size and each image's crop box (the union over the imported skins).
	var canvas := Vector2i.ZERO
	var boxes: Array[Rect2i] = []
	for path in image_paths:
		var box := Rect2i()
		for skin in skin_keys:
			var img := reader.read_png(skin, path)
			if img == null:
				errors.append(reader.error_message)
				return null
			if canvas == Vector2i.ZERO:
				canvas = img.get_size()
			elif img.get_size() != canvas:
				errors.append(
					"render/%s/%s is %s but the canvas is %s" % [skin, path, img.get_size(), canvas]
				)
				return null
			var used := img.get_used_rect() if opts["trim"] else Rect2i(Vector2i.ZERO, canvas)
			if used.has_area():
				box = used if not box.has_area() else box.merge(used)
		if not box.has_area():
			box = Rect2i(0, 0, 1, 1)  # fully transparent: one transparent pixel
		boxes.append(box)

	# One layout for every skin.
	var pad: int = opts["padding"]
	var sizes: Array[Vector2i] = []
	for box in boxes:
		sizes.append(box.size + Vector2i(pad * 2, pad * 2))
	var packed := shelf_pack(sizes)
	var atlas_size: Vector2i = packed["size"]
	if atlas_size.x > MAX_ATLAS_SIDE or atlas_size.y > MAX_ATLAS_SIDE:
		errors.append("the atlas would be %s, over the %d pixel limit" % [atlas_size, MAX_ATLAS_SIDE])
		return null
	var positions: Array[Vector2i] = packed["positions"]

	# Pass 2: one atlas per skin.
	var asset := PixelForgeAsset.new()
	for skin in skin_keys:
		var atlas := Image.create_empty(atlas_size.x, atlas_size.y, false, Image.FORMAT_RGBA8)
		for i in image_paths.size():
			var img := reader.read_png(skin, image_paths[i])
			if img == null:
				errors.append(reader.error_message)
				return null
			atlas.blit_rect(img, boxes[i], positions[i] + Vector2i(pad, pad))
		asset.atlases[StringName(skin)] = ImageTexture.create_from_image(atlas)
	asset.skins = skin_keys

	# Frames, animations and per-frame data, in sorted group, direction, index order.
	var next_frame := 0
	var starts: Dictionary = {}  # "group/direction" -> first frame index
	for e: Dictionary in entries:
		var indices := PackedInt32Array()
		starts["%s/%s" % [e["group"], e["direction"]]] = next_frame
		for f: Dictionary in e["frames"]:
			var slot: int = image_slot[f["image"]]
			asset.frames.append({
				"region": Rect2i(positions[slot] + Vector2i(pad, pad), boxes[slot].size),
				"offset_px": boxes[slot].position,
				"duration_ms": int(f["durationMs"]),
			})
			var marker_map: Dictionary = {}
			for name: String in f["markers"]:
				marker_map[StringName(name)] = Vector2i(int(f["markers"][name]["x"]), int(f["markers"][name]["y"]))
			asset.markers.append(marker_map)
			var names := PackedStringArray()
			for ev: Variant in f["events"]:
				names.append(str(ev))
			asset.events.append(names)
			asset.root_motion.append(Vector2i(int(f["rootMotion"]["dx"]), int(f["rootMotion"]["dy"])))
			indices.append(next_frame)
			next_frame += 1
		_set_animation(asset, e["group"], e["direction"], indices, e["loop"], false)
	for e: Dictionary in _entries(index, picked, true):
		var source_start: int = starts["%s/%s" % [e["group"], e["mirrorOf"]]]
		var source_count: int = (index["animations"][e["group"]][e["mirrorOf"]]["frames"] as Array).size()
		var indices := PackedInt32Array()
		for k in source_count:
			indices.append(source_start + k)
		_set_animation(asset, e["group"], e["direction"], indices, e["loop"], true)

	asset.origin = Vector2i(int(index["origin"]["x"]), int(index["origin"]["y"]))
	asset.pixels_per_unit = float(index["pixelsPerUnit"])
	for key: String in index["directionFallback"]:
		var list := PackedStringArray()
		for d: Variant in index["directionFallback"][key]:
			list.append(str(d))
		asset.direction_fallback[StringName(key)] = list
	asset.canvas_size = canvas
	return asset


## Shelf packing (next-fit decreasing height). `sizes` are the rectangles to place, padding
## included. Returns `{positions: Array[Vector2i] (same order as sizes), size: Vector2i}`.
## Deterministic: ties are broken by the original index. The width is a power of two (at most
## `PREFERRED_ATLAS_WIDTH` unless a rectangle is wider), the height is exactly what the shelves use.
static func shelf_pack(sizes: Array[Vector2i], max_width: int = PREFERRED_ATLAS_WIDTH) -> Dictionary:
	var positions: Array[Vector2i] = []
	positions.resize(sizes.size())
	if sizes.is_empty():
		return {"positions": positions, "size": Vector2i(1, 1)}
	var widest := 0
	var area := 0
	for s in sizes:
		widest = maxi(widest, s.x)
		area += s.x * s.y
	var width := nearest_po2(maxi(widest, ceili(sqrt(float(area) * 1.15))))
	width = maxi(widest, mini(width, max_width))
	var order: Array[int] = []
	for i in sizes.size():
		order.append(i)
	order.sort_custom(func(a: int, b: int) -> bool:
		if sizes[a].y != sizes[b].y:
			return sizes[a].y > sizes[b].y
		if sizes[a].x != sizes[b].x:
			return sizes[a].x > sizes[b].x
		return a < b
	)
	var x := 0
	var y := 0
	var shelf_height := 0
	for i in order:
		var s := sizes[i]
		if x + s.x > width:
			y += shelf_height
			x = 0
			shelf_height = 0
		positions[i] = Vector2i(x, y)
		x += s.x
		shelf_height = maxi(shelf_height, s.y)
	return {"positions": positions, "size": Vector2i(width, y + shelf_height)}


static func _set_animation(
	asset: PixelForgeAsset, group: String, direction: String, indices: PackedInt32Array, loop: String, mirror: bool
) -> void:
	var g := StringName(group)
	if not asset.animations.has(g):
		asset.animations[g] = {}
	asset.animations[g][StringName(direction)] = {
		"frames": indices,
		"loop": StringName(loop),
		"mirror": mirror,
	}


static func _normalise_options(options: Dictionary) -> Dictionary:
	var o := DEFAULT_OPTIONS.duplicate()
	for key: Variant in options:
		if o.has(key):
			o[key] = options[key]
	o["animations"] = _split_list(o["animations"])
	o["skins"] = _split_list(o["skins"])
	o["trim"] = bool(o["trim"])
	o["padding"] = clampi(int(o["padding"]), 0, MAX_PADDING)
	return o


static func _split_list(v: Variant) -> PackedStringArray:
	var out := PackedStringArray()
	var parts: Array = []
	if typeof(v) == TYPE_STRING or typeof(v) == TYPE_STRING_NAME:
		parts = String(v).split(",")
	elif typeof(v) == TYPE_ARRAY or typeof(v) == TYPE_PACKED_STRING_ARRAY:
		parts = Array(v)
	for p: Variant in parts:
		var s := String(p).strip_edges()
		if s != "":
			out.append(s)
	return out


## `base` first, then the index's skins in order, filtered by `wanted` (empty means all).
static func _select_skins(index: Dictionary, wanted: PackedStringArray, warnings: Array[String]) -> PackedStringArray:
	var available: Array = index["skins"]
	var out := PackedStringArray(["base"])
	for s: Variant in available:
		var key := str(s)
		if key != "base" and (wanted.is_empty() or wanted.has(key)):
			out.append(key)
	for w in wanted:
		if w != "base" and not available.has(w):
			warnings.append("skin '%s' is not in the file" % w)
	return out


## The animations to import as a set of `"group/direction"` keys: those matching `wanted` (a group
## name or `group/direction`; empty means all) plus the source direction of every selected mirror.
static func _pick(index: Dictionary, wanted: PackedStringArray, warnings: Array[String]) -> Dictionary:
	var animations: Dictionary = index["animations"]
	var picked: Dictionary = {}
	for g: String in animations:
		for d: String in animations[g]:
			if wanted.is_empty() or wanted.has(g) or wanted.has("%s/%s" % [g, d]):
				picked["%s/%s" % [g, d]] = true
				var entry: Dictionary = animations[g][d]
				if entry.has("mirrorOf"):
					picked["%s/%s" % [g, entry["mirrorOf"]]] = true
	for w in wanted:
		var parts := w.split("/")
		var found := animations.has(parts[0]) and (parts.size() == 1 or (animations[parts[0]] as Dictionary).has(parts[1]))
		if not found:
			warnings.append("animation '%s' is not in the file" % w)
	return picked


## Picked entries, sorted by group then direction, as `{group, direction, loop, frames}` (authored)
## or `{group, direction, loop, mirrorOf}` (mirror), depending on `mirrors`.
static func _entries(index: Dictionary, picked: Dictionary, mirrors: bool) -> Array[Dictionary]:
	var animations: Dictionary = index["animations"]
	var out: Array[Dictionary] = []
	var groups: Array = animations.keys()
	groups.sort()
	for g: String in groups:
		var dirs: Array = (animations[g] as Dictionary).keys()
		dirs.sort()
		for d: String in dirs:
			if not picked.has("%s/%s" % [g, d]):
				continue
			var entry: Dictionary = animations[g][d]
			if mirrors and entry.has("mirrorOf"):
				out.append({"group": g, "direction": d, "loop": str(entry["loop"]), "mirrorOf": str(entry["mirrorOf"])})
			elif not mirrors and entry.has("frames"):
				out.append({"group": g, "direction": d, "loop": str(entry["loop"]), "frames": entry["frames"]})
	return out
