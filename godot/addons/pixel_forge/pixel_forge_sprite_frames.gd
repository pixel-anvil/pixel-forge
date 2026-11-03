@tool
class_name PixelForgeSpriteFrames
extends RefCounted
## Builds Godot `SpriteFrames` from a `PixelForgeAsset`, one per direction (FR-GD-06).
##
## A `SpriteFrames` made here has one animation per group (`walk`, `idle`, ...). Each animation is
## what `PixelForgeAsset.resolve(group, direction)` returns, so the `direction_fallback` rules and
## the `default` direction work exactly as in the driver. Frames are `AtlasTexture`s that share the
## asset atlas of the chosen skin; a trimmed frame keeps its canvas position through
## `AtlasTexture.margin`, so every frame is canvas sized on screen and the origin stays put.
##
## Timing: `SpriteFrames` has one speed per animation and a relative duration per frame. The speed
## is `1000 / g` frames per second where `g` is the greatest common divisor of the frame durations
## in ms, and a frame lasts `duration_ms / g` units, so the times are exact.
##
## Loop: `loop` and `pingpong` set `loop = true`, `once` sets `loop = false`. `SpriteFrames` has no
## ping-pong, so a `pingpong` animation lists `0..n-1, n-2..1` (the driver's sequence, each entry
## with its own duration).
##
## Mirror: a mirrored direction (`mirrorOf`) lists the frames of its source direction. `SpriteFrames`
## cannot flip, so the result records it: `is_mirrored(frames, animation)` is true when the node
## showing that animation must set `flip_h`.
##
## Not in `SpriteFrames`: markers, events and root motion. Use `PixelForgeAsset` and the driver.

## Meta key on the `SpriteFrames`: `{animation name: bool}`, true for a mirrored animation.
const META_MIRROR := &"pixel_forge_mirror"
## Meta key on the `SpriteFrames`: the direction it was built for.
const META_DIRECTION := &"pixel_forge_direction"
## Meta key on the `SpriteFrames`: the skin it was built for.
const META_SKIN := &"pixel_forge_skin"


## The `SpriteFrames` of `direction` in `skin` (`base` by default), or null when `skin` is not in
## the asset. Groups with no entry for `direction` (after the fallback) are left out, so the result
## can be empty. `report` receives `errors` (array of strings).
static func build(
	asset: PixelForgeAsset, direction: StringName, skin: StringName = &"base", report: Dictionary = {}
) -> SpriteFrames:
	var errors: Array[String] = []
	report["errors"] = errors
	if asset == null:
		errors.append("the asset is null")
		return null
	if not asset.atlases.has(skin):
		errors.append("skin '%s' is not in the asset (skins: %s)" % [skin, ", ".join(asset.skins)])
		return null
	var atlas: Texture2D = asset.atlases[skin]
	var out := SpriteFrames.new()
	for existing: StringName in out.get_animation_names():
		out.remove_animation(existing)  # drop the built-in "default"
	var mirrors: Dictionary = {}
	var cache: Dictionary = {}  # frame index -> AtlasTexture, shared inside one SpriteFrames
	var groups: Array = asset.animations.keys()
	groups.sort()
	for group: StringName in groups:
		var entry := asset.resolve(group, direction)
		if entry.is_empty():
			continue
		_add_animation(out, asset, atlas, group, entry, cache)
		mirrors[group] = bool(entry["mirror"])
	out.set_meta(META_MIRROR, mirrors)
	out.set_meta(META_DIRECTION, direction)
	out.set_meta(META_SKIN, skin)
	return out


## `{direction: SpriteFrames}` for every direction in `directions(asset)`, or `{}` when `skin` is
## unknown (`report.errors` says so).
static func build_all(
	asset: PixelForgeAsset, skin: StringName = &"base", report: Dictionary = {}
) -> Dictionary:
	var out: Dictionary = {}
	for direction in directions(asset):
		var sf := build(asset, direction, skin, report)
		if sf == null:
			return {}
		out[direction] = sf
	return out


## The directions `build_all` makes: authored directions (`default` included) and the keys of
## `direction_fallback`, sorted.
static func directions(asset: PixelForgeAsset) -> Array[StringName]:
	var seen: Dictionary = {}
	for group: StringName in asset.animations:
		for d: StringName in asset.animations[group]:
			seen[d] = true
	for d: StringName in asset.direction_fallback:
		seen[d] = true
	var out: Array[StringName] = []
	for d: StringName in seen:
		out.append(d)
	out.sort_custom(func(a: StringName, b: StringName) -> bool: return String(a) < String(b))
	return out


## Whether `animation` of a `SpriteFrames` made by `build` is a mirror, so the node showing it must
## flip it horizontally. False for an unknown animation or a `SpriteFrames` not made here.
static func is_mirrored(sprite_frames: SpriteFrames, animation: StringName) -> bool:
	var m: Variant = sprite_frames.get_meta(META_MIRROR, {})
	return typeof(m) == TYPE_DICTIONARY and bool((m as Dictionary).get(animation, false))


static func _add_animation(
	out: SpriteFrames,
	asset: PixelForgeAsset,
	atlas: Texture2D,
	group: StringName,
	entry: Dictionary,
	cache: Dictionary
) -> void:
	var indices: PackedInt32Array = entry["frames"]
	var order: Array[int] = []
	for i in indices.size():
		order.append(i)
	if entry["loop"] == &"pingpong":
		for i in range(indices.size() - 2, 0, -1):
			order.append(i)
	var step := 0
	for k in order:
		step = _gcd(step, maxi(1, int(asset.frames[indices[k]]["duration_ms"])))
	step = maxi(1, step)
	out.add_animation(group)
	out.set_animation_loop(group, entry["loop"] != &"once")
	out.set_animation_speed(group, 1000.0 / float(step))
	for k in order:
		var frame_index: int = indices[k]
		if not cache.has(frame_index):
			cache[frame_index] = _atlas_texture(asset, atlas, frame_index)
		var ms := maxi(1, int(asset.frames[frame_index]["duration_ms"]))
		out.add_frame(group, cache[frame_index], float(ms / step))


static func _atlas_texture(asset: PixelForgeAsset, atlas: Texture2D, frame_index: int) -> AtlasTexture:
	var f: Dictionary = asset.frames[frame_index]
	var region: Rect2i = f["region"]
	var offset: Vector2i = f["offset_px"]
	var t := AtlasTexture.new()
	t.atlas = atlas
	t.region = Rect2(region)
	# margin: the region sits at `offset` on a canvas-sized frame.
	t.margin = Rect2(Vector2(offset), Vector2(asset.canvas_size - region.size))
	return t


static func _gcd(a: int, b: int) -> int:
	while b != 0:
		var t := b
		b = a % b
		a = t
	return a
